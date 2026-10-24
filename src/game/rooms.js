'use strict';

/**
 * Authoritative, in-memory room and match state machine.
 *
 * Phases: WAITING -> READY -> COUNTDOWN -> PLAYING -> FINISHED -> CLOSED
 *
 * The store owns all scoring, timing and transition decisions. Sockets only pass
 * an authenticated player slot plus a validated payload into it.
 */

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const {
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  validateName,
} = require('./names');
const { createBucket, takeToken, createWindowCounter, hitWindow } = require('./rate-limiter');

const PHASE = Object.freeze({
  WAITING: 'WAITING',
  READY: 'READY',
  COUNTDOWN: 'COUNTDOWN',
  PLAYING: 'PLAYING',
  FINISHED: 'FINISHED',
  CLOSED: 'CLOSED',
});

const LOBBY_PHASES = new Set([PHASE.WAITING, PHASE.READY]);
const ACTIVE_PHASES = new Set([PHASE.COUNTDOWN, PHASE.PLAYING]);

class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}

const ERRORS = {
  INVALID_NAME: 'Enter a valid display name.',
  ROOM_NOT_FOUND: 'That room code does not match a live room.',
  ROOM_EXPIRED: 'That room has expired. Create a new one.',
  ROOM_CLOSED: 'That room is closed.',
  ROOM_FULL: 'That room already has two players.',
  ROOM_STARTED: 'That match has already started.',
  NAME_TAKEN: 'Another player in this room is using that name.',
  NOT_HOST: 'Only the room host can do that.',
  NOT_IN_ROOM: 'You are not part of this room.',
  NOT_ENOUGH_PLAYERS: 'Two players are needed to start.',
  NOT_READY: 'Both players must be ready before the match can start.',
  INVALID_DURATION: 'Choose a round length of 30, 60 or 90 seconds.',
  INVALID_PHASE: 'That action is not available right now.',
  ALREADY_STARTED: 'This match has already started.',
  NOT_STARTED: 'The round has not started yet.',
  ROUND_OVER: 'The round has already ended.',
  RATE_LIMITED: 'Easy there. Your sends are arriving too fast.',
  INVALID_STICKER: 'That sticker is not part of the approved collection.',
  DUPLICATE_EVENT: 'That sticker was already counted.',
  PLAYER_DISCONNECTED: 'Reconnect before sending stickers.',
  SESSION_GONE: 'That match session is no longer available.',
  REMATCH_NOT_AVAILABLE: 'Rematch is not available right now.',
  ROOM_LIMIT: 'The server is at capacity. Try again in a moment.',
  NO_STICKERS: 'No stickers are configured on this server, so a match cannot start.',
  TOO_MANY_ROOMS: 'You have created too many rooms. Try again shortly.',
};

function fail(code, message = ERRORS[code] || 'Something went wrong.') {
  return new GameError(code, message);
}

function createRoomStore(options) {
  const {
    config,
    logger = { info() {}, warn() {}, error() {}, debug() {} },
    clock = { now: () => Date.now() },
    codeGenerator,
    useTimers = true,
    stickerIds = new Set(),
  } = options;

  const bus = new EventEmitter();
  bus.setMaxListeners(50);

  /** @type {Map<string, any>} */
  const rooms = new Map();
  /** @type {Map<string, string>} room code -> room id */
  const codes = new Map();
  /** @type {Map<string, {roomId: string, playerId: string}>} token -> slot */
  const tokens = new Map();
  /** @type {Map<string, any>} ip -> counters */
  const ipCounters = new Map();
  /** @type {Set<string>} */
  let allowedStickerIds = stickerIds;

  const nextCode =
    codeGenerator ||
    (() => generateRoomCode((n) => crypto.randomBytes(n)));

  function nowMs() {
    return typeof clock.now === 'function' ? clock.now() : Date.now();
  }

  function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
  }

  function newToken() {
    return crypto.randomBytes(32).toString('base64url');
  }

  function emit(type, payload) {
    bus.emit('event', { type, ...payload });
  }

  function ipStats(ip) {
    const key = ip || 'unknown';
    let entry = ipCounters.get(key);
    if (!entry) {
      entry = {
        joins: createWindowCounter({
          limit: config.joinAttemptsPerMinute,
          windowMs: 60_000,
          now: nowMs(),
        }),
        creates: createWindowCounter({
          limit: config.maxRoomsPerIp,
          windowMs: 10 * 60_000,
          now: nowMs(),
        }),
        sockets: 0,
      };
      ipCounters.set(key, entry);
    }
    return entry;
  }

  function assertRoom(room) {
    if (!room || room.phase === PHASE.CLOSED) throw fail('ROOM_CLOSED');
    if (nowMs() > room.expiresAt) throw fail('ROOM_EXPIRED');
    return room;
  }

  function getRoomById(roomId) {
    return rooms.get(roomId) || null;
  }

  function getRoomByCode(code) {
    const normalized = normalizeRoomCode(code);
    if (!isValidRoomCode(normalized)) return null;
    const roomId = codes.get(normalized);
    return roomId ? rooms.get(roomId) || null : null;
  }

  function findPlayer(room, playerId) {
    return room.players.find((player) => player.id === playerId) || null;
  }

  function requirePlayer(room, playerId) {
    const player = findPlayer(room, playerId);
    if (!player) throw fail('NOT_IN_ROOM');
    return player;
  }

  function requireHost(room, playerId) {
    if (room.hostId !== playerId) throw fail('NOT_HOST');
  }

  function clearTimers(room) {
    if (room.timers) {
      for (const timer of Object.values(room.timers)) clearTimeout(timer);
    }
    room.timers = {};
  }

  function armTimers(room) {
    clearTimers(room);
    if (!useTimers) return;
    const now = nowMs();

    if (room.phase === PHASE.COUNTDOWN && room.startsAt) {
      const delay = Math.max(0, room.startsAt - now);
      room.timers.start = setTimeout(() => {
        tick();
      }, delay + 2);
      room.timers.start.unref?.();
    }
    if ((room.phase === PHASE.COUNTDOWN || room.phase === PHASE.PLAYING) && room.endsAt) {
      const delay = Math.max(0, room.endsAt - now);
      room.timers.end = setTimeout(() => {
        tick();
      }, delay + 2);
      room.timers.end.unref?.();
    }
  }

  function makePlayer({ name, ip, socketId }) {
    return {
      id: newId('pl'),
      token: newToken(),
      name,
      ip: ip || 'unknown',
      socketId,
      connected: Boolean(socketId),
      ready: false,
      score: 0,
      joinedAt: nowMs(),
      disconnectedAt: null,
      leftAt: null,
      rematchRequested: false,
      sendBucket: createBucket({
        capacity: config.sendBurst,
        refillPerSecond: config.sendPerSecond,
        now: nowMs(),
      }),
      seenEvents: new Set(),
      seenEventOrder: [],
      sendsAccepted: 0,
      sendsRejected: 0,
    };
  }

  function roomSummary(room) {
    const now = nowMs();
    const players = room.players.map((player) => ({
      id: player.id,
      name: player.name,
      isHost: player.id === room.hostId,
      connected: player.connected,
      ready: player.ready,
      score: player.score,
      rematchRequested: player.rematchRequested,
    }));
    const result = room.result
      ? {
          roundNumber: room.result.roundNumber,
          durationSeconds: room.result.durationSeconds,
          finishedAt: room.result.finishedAt,
          scores: room.result.scores.map((entry) => ({ ...entry })),
          winnerId: room.result.winnerId,
          draw: room.result.draw,
          scoreDifference: room.result.scoreDifference,
          reason: room.result.reason,
        }
      : null;

    return {
      roomId: room.id,
      code: room.code,
      hostId: room.hostId,
      phase: room.phase,
      durationSeconds: room.durationSeconds,
      durationOptions: [...config.allowedDurations],
      roundNumber: room.roundNumber,
      startsAt: room.startsAt,
      endsAt: room.endsAt,
      players,
      result,
      rematch: {
        requestedBy: room.players.filter((p) => p.rematchRequested).map((p) => p.id),
      },
      rules: {
        sendPerSecond: config.sendPerSecond,
        sendBurst: config.sendBurst,
        countdownMs: config.countdownMs,
        scoring: 'server',
      },
      serverNow: now,
      expiresAt: room.expiresAt,
    };
  }

  function stateFor(room, viewerId) {
    const summary = roomSummary(room);
    const you = summary.players.find((player) => player.id === viewerId) || null;
    return {
      ...summary,
      you,
      token: room.players.find((player) => player.id === viewerId)?.token ?? null,
    };
  }

  function touch(room) {
    room.updatedAt = nowMs();
    if (LOBBY_PHASES.has(room.phase)) {
      room.expiresAt = room.updatedAt + config.roomIdleTtlMs;
    }
  }

  function publish(room, type = 'room:update') {
    emit(type, { roomId: room.id, phase: room.phase });
  }

  function removeFromIndexes(room, player) {
    tokens.delete(player.token);
  }

  function addRoom(room) {
    rooms.set(room.id, room);
    codes.set(room.code, room.id);
  }

  function destroyRoom(room, reason) {
    clearTimers(room);
    for (const player of room.players) removeFromIndexes(room, player);
    room.phase = PHASE.CLOSED;
    rooms.delete(room.id);
    codes.delete(room.code);
    emit('room:closed', { roomId: room.id, reason });
  }

  /**
   * Create a room. The creator occupies slot A.
   */
  function createRoom({ name, socketId = null, ip = 'unknown' }) {
    const normalized = validateName(name, config);
    if (!normalized.ok) throw fail(normalized.code, normalized.message);
    if (rooms.size >= config.maxRooms) throw fail('ROOM_LIMIT');

    const stats = ipStats(ip);
    let activeForIp = 0;
    for (const existing of rooms.values()) {
      if (existing.players.some((p) => p.ip === ip)) activeForIp += 1;
    }
    if (activeForIp >= config.maxRoomsPerIp) throw fail('TOO_MANY_ROOMS');
    if (!hitWindow(stats.creates, nowMs())) throw fail('TOO_MANY_ROOMS');

    let code = '';
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const candidate = nextCode();
      if (isValidRoomCode(candidate) && !codes.has(candidate)) {
        code = candidate;
        break;
      }
    }
    if (!code) throw fail('ROOM_LIMIT', 'Could not allocate a room code. Try again.');

    const now = nowMs();
    const player = makePlayer({ name: normalized.name, ip, socketId });
    const room = {
      id: newId('rm'),
      code,
      hostId: player.id,
      players: [player],
      phase: PHASE.WAITING,
      durationSeconds: 60,
      roundNumber: 0,
      startsAt: null,
      endsAt: null,
      result: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + config.roomIdleTtlMs,
      finalized: false,
      timers: {},
      sendsAccepted: 0,
      sendsRejected: 0,
    };

    addRoom(room);
    tokens.set(player.token, { roomId: room.id, playerId: player.id });
    logger.info('room_created', { roomId: room.id, phase: room.phase });
    emit('room:created', { roomId: room.id });
    publish(room);
    return { room, player, token: player.token };
  }

  function joinRoom({ code, name, socketId = null, ip = 'unknown' }) {
    if (!hitWindow(ipStats(ip).joins, nowMs())) throw fail('RATE_LIMITED');
    const normalizedCode = normalizeRoomCode(code);
    if (!isValidRoomCode(normalizedCode)) throw fail('ROOM_NOT_FOUND');
    const room = getRoomByCode(normalizedCode);
    if (!room) throw fail('ROOM_NOT_FOUND');
    assertRoom(room);

    if (!LOBBY_PHASES.has(room.phase)) {
      throw fail(room.phase === PHASE.CLOSED ? 'ROOM_CLOSED' : 'ROOM_STARTED');
    }
    if (room.players.length >= 2) throw fail('ROOM_FULL');

    const normalized = validateName(name, config);
    if (!normalized.ok) throw fail(normalized.code, normalized.message);
    if (
      room.players.some(
        (player) => player.name.toLowerCase() === normalized.name.toLowerCase(),
      )
    ) {
      throw fail('NAME_TAKEN');
    }

    const player = makePlayer({ name: normalized.name, ip, socketId });
    room.players.push(player);
    room.phase = PHASE.READY;
    touch(room);
    tokens.set(player.token, { roomId: room.id, playerId: player.id });
    logger.info('room_joined', { roomId: room.id, players: room.players.length });
    publish(room);
    return { room, player, token: player.token };
  }

  /**
   * Bind a returning client to its existing player slot, invalidating any older
   * socket for the same slot. One slot can only ever have one live socket.
   */
  function resumeSession({ token, socketId }) {
    const entry = tokens.get(token);
    if (!entry) throw fail('SESSION_GONE');
    const room = rooms.get(entry.roomId);
    if (!room) throw fail('SESSION_GONE');
    assertRoom(room);
    const player = findPlayer(room, entry.playerId);
    if (!player) throw fail('SESSION_GONE');

    const previousSocketId = player.socketId;
    player.socketId = socketId;
    player.connected = Boolean(socketId);
    player.disconnectedAt = null;
    room.updatedAt = nowMs();
    touch(room);
    logger.info('session_resumed', { roomId: room.id, phase: room.phase });
    publish(room);
    return { room, player, token, previousSocketId };
  }

  function setDuration({ roomId, playerId, durationSeconds }) {
    const room = assertRoom(getRoomById(roomId));
    requirePlayer(room, playerId);
    requireHost(room, playerId);
    if (!LOBBY_PHASES.has(room.phase)) throw fail('INVALID_PHASE');
    if (
      !Number.isInteger(durationSeconds) ||
      !config.allowedDurations.includes(durationSeconds)
    ) {
      throw fail('INVALID_DURATION');
    }
    room.durationSeconds = durationSeconds;
    touch(room);
    publish(room);
    return room;
  }

  function setReady({ roomId, playerId, ready }) {
    const room = assertRoom(getRoomById(roomId));
    const player = requirePlayer(room, playerId);
    if (!LOBBY_PHASES.has(room.phase)) throw fail('INVALID_PHASE');
    if (typeof ready !== 'boolean') throw fail('INVALID_PHASE', 'Ready must be true or false.');
    player.ready = ready;
    touch(room);
    publish(room);
    return room;
  }

  function startMatch({ roomId, playerId }) {
    const room = assertRoom(getRoomById(roomId));
    requirePlayer(room, playerId);
    requireHost(room, playerId);
    if (!LOBBY_PHASES.has(room.phase)) {
      throw fail(
        [PHASE.COUNTDOWN, PHASE.PLAYING].includes(room.phase) ? 'ALREADY_STARTED' : 'INVALID_PHASE',
      );
    }
    if (room.players.length !== 2) throw fail('NOT_ENOUGH_PLAYERS');
    if (!room.players.every((player) => player.ready && player.connected)) {
      throw fail('NOT_READY');
    }
    if (!allowedStickerIds.size) throw fail('NO_STICKERS');

    const now = nowMs();
    room.roundNumber += 1;
    room.phase = PHASE.COUNTDOWN;
    room.result = null;
    room.finalized = false;
    room.startsAt = now + config.countdownMs;
    room.endsAt = room.startsAt + room.durationSeconds * 1000;
    // Keep the room addressable for the whole round plus the result window.
    room.expiresAt = room.endsAt + config.roomFinishedTtlMs;
    room.sendsAccepted = 0;
    room.sendsRejected = 0;
    for (const player of room.players) {
      player.score = 0;
      player.ready = false;
      player.rematchRequested = false;
      player.sendBucket = createBucket({
        capacity: config.sendBurst,
        refillPerSecond: config.sendPerSecond,
        now,
      });
      player.seenEvents.clear();
      player.seenEventOrder = [];
      player.sendsAccepted = 0;
      player.sendsRejected = 0;
    }
    touch(room);
    armTimers(room);
    logger.info('match_started', {
      roomId: room.id,
      round: room.roundNumber,
      durationSeconds: room.durationSeconds,
    });
    emit('match:started', { roomId: room.id, startsAt: room.startsAt, endsAt: room.endsAt });
    publish(room);
    return room;
  }

  /**
   * Validate and apply one sticker send. Returns the authoritative score.
   */
  function recordSend({ roomId, playerId, socketId, stickerId, eventId }) {
    const now = nowMs();
    const room = rooms.get(roomId);
    if (!room) throw fail('ROOM_NOT_FOUND');
    const player = findPlayer(room, playerId);
    if (!player || !player.socketId || player.socketId !== socketId) throw fail('NOT_IN_ROOM');
    if (player.connected === false) throw fail('PLAYER_DISCONNECTED');

    if (typeof eventId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(eventId)) {
      throw fail('INVALID_PHASE', 'Malformed sticker event.');
    }
    if (typeof stickerId !== 'string' || !allowedStickerIds.has(stickerId)) {
      throw fail('INVALID_STICKER');
    }

    if (room.phase === PHASE.FINISHED) throw fail('ROUND_OVER');
    if (room.phase === PHASE.COUNTDOWN) throw fail('NOT_STARTED');
    if (room.phase !== PHASE.PLAYING) throw fail('INVALID_PHASE');
    if (!room.startsAt || !room.endsAt) throw fail('INVALID_PHASE');
    if (now < room.startsAt) throw fail('NOT_STARTED');
    if (now >= room.endsAt) {
      finishRound({ roomId: room.id, reason: 'time' });
      throw fail('ROUND_OVER');
    }

    if (player.seenEvents.has(eventId)) {
      throw fail('DUPLICATE_EVENT');
    }

    if (!takeToken(player.sendBucket, now)) {
      player.sendsRejected += 1;
      room.sendsRejected += 1;
      throw fail('RATE_LIMITED');
    }

    player.seenEvents.add(eventId);
    player.seenEventOrder.push(eventId);
    if (player.seenEventOrder.length > config.dedupeWindow) {
      const oldest = player.seenEventOrder.shift();
      player.seenEvents.delete(oldest);
    }

    player.score += 1;
    player.sendsAccepted += 1;
    room.sendsAccepted += 1;
    room.updatedAt = now;

    emit('sticker:accepted', {
      roomId: room.id,
      playerId: player.id,
      stickerId,
      score: player.score,
      at: now,
    });
    return {
      score: player.score,
      scores: Object.fromEntries(room.players.map((p) => [p.id, p.score])),
      at: now,
    };
  }

  function finishRound({ roomId, reason = 'time' }) {
    const room = rooms.get(roomId);
    if (!room) throw fail('ROOM_NOT_FOUND');
    if (room.phase === PHASE.FINISHED) return room.result || null;
    if (!ACTIVE_PHASES.has(room.phase)) return null;
    if (room.finalized) return room.result || null;

    const finishedAt = Math.min(nowMs(), room.endsAt || nowMs());
    room.finalized = true;
    clearTimers(room);
    room.phase = PHASE.FINISHED;
    room.endsAt = room.endsAt || finishedAt;
    room.updatedAt = nowMs();
    room.expiresAt = room.updatedAt + config.roomFinishedTtlMs;

    const scores = room.players.map((player) => ({
      playerId: player.id,
      name: player.name,
      score: player.score,
      connected: player.connected,
    }));
    const sorted = [...scores].sort((a, b) => b.score - a.score);
    const draw = sorted.length === 2 && sorted[0].score === sorted[1].score;
    room.result = {
      roundNumber: room.roundNumber,
      durationSeconds: room.durationSeconds,
      finishedAt,
      scores,
      winnerId: draw ? null : sorted[0]?.playerId ?? null,
      draw,
      scoreDifference: sorted.length === 2 ? Math.abs(sorted[0].score - sorted[1].score) : 0,
      reason,
    };

    logger.info('match_finished', {
      roomId: room.id,
      round: room.roundNumber,
      draw,
      scoreDifference: room.result.scoreDifference,
      accepted: room.sendsAccepted,
      rejected: room.sendsRejected,
    });
    emit('match:ended', { roomId: room.id, result: room.result });
    publish(room);
    return room.result;
  }

  function requestRematch({ roomId, playerId }) {
    const room = assertRoom(getRoomById(roomId));
    const player = requirePlayer(room, playerId);
    if (room.phase !== PHASE.FINISHED) throw fail('REMATCH_NOT_AVAILABLE');
    if (!player.connected) throw fail('PLAYER_DISCONNECTED');
    player.rematchRequested = true;
    touch(room);
    room.expiresAt = nowMs() + config.roomFinishedTtlMs;

    const bothReady =
      room.players.length === 2 &&
      room.players.every((p) => p.rematchRequested && p.connected);
    if (bothReady) {
      room.phase = PHASE.READY;
      room.result = null;
      room.finalized = false;
      room.startsAt = null;
      room.endsAt = null;
      for (const p of room.players) {
        p.score = 0;
        p.rematchRequested = false;
        p.ready = false;
        p.sendBucket = createBucket({
          capacity: config.sendBurst,
          refillPerSecond: config.sendPerSecond,
          now: nowMs(),
        });
        p.seenEvents.clear();
        p.seenEventOrder = [];
      }
      room.expiresAt = nowMs() + config.roomIdleTtlMs;
      logger.info('rematch_ready', { roomId: room.id });
      emit('rematch:ready', { roomId: room.id });
    }
    publish(room);
    return room;
  }

  function markDisconnected({ roomId, playerId, socketId }) {
    const room = rooms.get(roomId);
    if (!room) return null;
    const player = findPlayer(room, playerId);
    if (!player) return null;
    if (player.socketId && socketId && player.socketId !== socketId) return null;
    player.connected = false;
    player.socketId = null;
    player.disconnectedAt = nowMs();
    room.updatedAt = nowMs();
    logger.info('player_disconnected', { roomId: room.id, phase: room.phase });
    publish(room);
    return room;
  }

  function removePlayerFromRoom(room, player, reason) {
    const index = room.players.findIndex((p) => p.id === player.id);
    if (index === -1) return;
    room.players.splice(index, 1);
    removeFromIndexes(room, player);

    if (room.players.length === 0) {
      destroyRoom(room, reason || 'empty');
      return;
    }
    if (room.hostId === player.id) {
      room.hostId = room.players[0].id;
    }
    if (!ACTIVE_PHASES.has(room.phase) && room.phase !== PHASE.FINISHED) {
      room.phase = room.players.length >= 2 ? PHASE.READY : PHASE.WAITING;
      room.startsAt = null;
      room.endsAt = null;
    }
    touch(room);
    logger.info('player_removed', { roomId: room.id, phase: room.phase });
    emit('player:left', { roomId: room.id, playerId: player.id, reason: reason || 'left' });
    publish(room);
  }

  /**
   * Intentional leave. During a live round the slot is kept so scores and the
   * eventual result stay intact, but the player can no longer score.
   */
  function leaveRoom({ roomId, playerId, reason = 'left' }) {
    const room = getRoomById(roomId);
    if (!room) return null;
    const player = findPlayer(room, playerId);
    if (!player) return null;

    if (ACTIVE_PHASES.has(room.phase) || room.phase === PHASE.FINISHED) {
      player.connected = false;
      player.socketId = null;
      player.leftAt = nowMs();
      player.disconnectedAt = nowMs();
      player.ready = false;
      removeFromIndexes(room, player);
      room.updatedAt = nowMs();
      emit('player:left', { roomId: room.id, playerId: player.id, reason });
      publish(room);
      return room;
    }

    removePlayerFromRoom(room, player, reason);
    return room;
  }

  function tick(now = nowMs()) {
    for (const room of [...rooms.values()]) {
      try {
        if (room.phase === PHASE.COUNTDOWN && room.startsAt && now >= room.startsAt) {
          room.phase = PHASE.PLAYING;
          armTimers(room);
          publish(room);
        }
        if (ACTIVE_PHASES.has(room.phase) && room.endsAt && now >= room.endsAt) {
          finishRound({ roomId: room.id, reason: 'time' });
          continue;
        }
        if (room.phase === PHASE.FINISHED && now >= room.expiresAt) {
          destroyRoom(room, 'finished-expired');
          continue;
        }
        if (room.phase === PHASE.WAITING || room.phase === PHASE.READY) {
          if (now >= room.expiresAt) {
            destroyRoom(room, 'idle-expired');
            continue;
          }
          for (const player of [...room.players]) {
            if (
              !player.connected &&
              player.disconnectedAt &&
              now - player.disconnectedAt > config.disconnectGraceMs
            ) {
              removePlayerFromRoom(room, player, 'disconnect-timeout');
            }
          }
        }
      } catch (error) {
        logger.error('tick_failed', { roomId: room.id, error: error.code || 'internal' });
      }
    }

    // Drop IP bookkeeping that no longer has a live room.
    if (ipCounters.size > 0 && rooms.size === 0) ipCounters.clear();
  }

  function stats() {
    const byPhase = {};
    let players = 0;
    for (const room of rooms.values()) {
      byPhase[room.phase] = (byPhase[room.phase] || 0) + 1;
      players += room.players.length;
    }
    return { rooms: rooms.size, players, byPhase };
  }

  function close() {
    for (const room of rooms.values()) clearTimers(room);
    rooms.clear();
    codes.clear();
    tokens.clear();
    ipCounters.clear();
    bus.removeAllListeners();
  }

  function setStickerIds(ids) {
    allowedStickerIds = ids instanceof Set ? ids : new Set(ids);
  }

  function listRooms() {
    return [...rooms.values()];
  }

  return {
    PHASE,
    bus,
    createRoom,
    joinRoom,
    resumeSession,
    setDuration,
    setReady,
    startMatch,
    recordSend,
    finishRound,
    requestRematch,
    markDisconnected,
    leaveRoom,
    tick,
    stats,
    now: nowMs,
    close,
    setStickerIds,
    stateFor,
    publicState: roomSummary,
    getRoomById,
    getRoomByCode,
    findPlayer,
    listRooms,
    _internal: { rooms, codes, tokens, ipCounters },
  };
}

module.exports = { createRoomStore, GameError, ERRORS, PHASE };
