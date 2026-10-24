'use strict';

/**
 * Socket.IO wiring.
 *
 * Every mutating event follows the same shape:
 *   client -> server payload (validated)
 *   server -> client acknowledgement {ok:true, ...} or {ok:false, code, message}
 *
 * Identity is never taken from the payload: the server resolves it from the
 * socket binding created at create/join/resume time.
 */

const { GameError } = require('../game/rooms');
const { createBucket, takeToken } = require('../game/rate-limiter');

const MAX_PAYLOAD_KEYS = 8;

function safeError(error) {
  if (error instanceof GameError) {
    return { ok: false, code: error.code, message: error.message };
  }
  return { ok: false, code: 'SERVER_ERROR', message: 'That action could not be completed.' };
}

function isPlainPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  return Object.keys(payload).length <= MAX_PAYLOAD_KEYS;
}

function createSocketServer({ io, store, config, logger }) {
  const roomChannel = (roomId) => `room:${roomId}`;
  const socketIpHits = new Map();
  const scoreFlushTimers = new Map();

  function ipSocketCount(ip) {
    return socketIpHits.get(ip) || 0;
  }

  function sendStateToRoom(room) {
    if (!room || room.phase === store.PHASE.CLOSED) return;
    io.to(roomChannel(room.id)).emit('room:state', store.publicState(room));
  }

  function queueScoreUpdate(roomId, scores) {
    let entry = scoreFlushTimers.get(roomId);
    if (!entry) {
      entry = { scores: {}, timer: null };
      scoreFlushTimers.set(roomId, entry);
    }
    Object.assign(entry.scores, scores);
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      const payload = entry.scores;
      const room = store.getRoomById(roomId);
      entry.timer = null;
      entry.scores = {};
      if (!room) {
        scoreFlushTimers.delete(roomId);
        return;
      }
      io.to(roomChannel(roomId)).emit('scores', {
        scores: payload,
        serverNow: store.now(),
      });
    }, 120);
    entry.timer.unref?.();
  }

  store.bus.on('event', (event) => {
    try {
      const room = event.roomId ? store.getRoomById(event.roomId) : null;

      switch (event.type) {
        case 'room:update':
          if (room) sendStateToRoom(room);
          break;
        case 'match:started':
          if (room) {
            io.to(roomChannel(room.id)).emit('match:started', {
              roomId: room.id,
              roundNumber: room.roundNumber,
              startsAt: room.startsAt,
              endsAt: room.endsAt,
              durationSeconds: room.durationSeconds,
              serverNow: store.now(),
            });
            sendStateToRoom(room);
          }
          break;
        case 'match:ended':
          if (room) {
            io.to(roomChannel(room.id)).emit('match:ended', {
              roomId: room.id,
              result: room.result,
              serverNow: store.now(),
            });
            sendStateToRoom(room);
          }
          break;
        case 'sticker:accepted': {
          const liveRoom = store.getRoomById(event.roomId);
          io.to(roomChannel(event.roomId)).emit('sticker:event', {
            playerId: event.playerId,
            stickerId: event.stickerId,
            at: event.at,
          });
          if (liveRoom) {
            queueScoreUpdate(liveRoom.id, {
              [event.playerId]: event.score,
            });
          }
          break;
        }
        case 'player:left':
          if (room) {
            io.to(roomChannel(room.id)).emit('notice', {
              code: 'PLAYER_LEFT',
              message: 'A player left the room.',
            });
            sendStateToRoom(room);
          }
          break;
        case 'room:closed':
          io.to(roomChannel(event.roomId)).emit('room:closed', {
            reason: event.reason || 'closed',
          });
          io.in(roomChannel(event.roomId)).socketsLeave(roomChannel(event.roomId));
          break;
        default:
          break;
      }
    } catch (error) {
      logger.error('broadcast_failed', { type: event.type, error: error.name || 'Error' });
    }
  });

  io.use((socket, next) => {
    const ip = socket.handshake.address || 'unknown';
    if (ipSocketCount(ip) >= config.maxSocketsPerIp) {
      return next(new Error('too_many_connections'));
    }
    socket.data.ip = ip;
    socket.data.actions = createBucket({ capacity: 40, refillPerSecond: 3, now: Date.now() });
    socket.data.binding = null;
    return next();
  });

  io.on('connection', (socket) => {
    const ip = socket.data.ip || 'unknown';
    socketIpHits.set(ip, ipSocketCount(ip) + 1);
    logger.debug('socket_connected', { active: io.engine?.clientsCount });

    const respond = (ack, payload) => {
      if (typeof ack === 'function') ack(payload);
    };

    const register = (name, handler) => {
      socket.on(name, async (payload, ack) => {
        try {
          if (!isPlainPayload(payload)) {
            respond(ack, {
              ok: false,
              code: 'INVALID_PAYLOAD',
              message: 'Malformed request.',
            });
            return;
          }
          if (!takeToken(socket.data.actions, Date.now())) {
            respond(ack, {
              ok: false,
              code: 'RATE_LIMITED',
              message: 'Too many actions. Wait a moment.',
            });
            return;
          }
          const result = await handler(payload);
          respond(ack, { ok: true, ...(result || {}) });
        } catch (error) {
          if (!(error instanceof GameError)) {
            logger.error('socket_handler_failed', {
              event: name,
              error: error?.name || 'Error',
            });
          }
          respond(ack, safeError(error));
        }
      });
    };

    const bind = (room, player, token) => {
      socket.data.binding = { roomId: room.id, playerId: player.id, token };
      socket.join(roomChannel(room.id));
      return {
        token,
        playerId: player.id,
        state: store.stateFor(room, player.id),
      };
    };

    const requireBinding = () => {
      const binding = socket.data.binding;
      if (!binding) {
        throw new GameError('NOT_IN_ROOM', 'Join a room first.');
      }
      return binding;
    };

    register('room:create', async (payload) => {
      if (socket.data.binding) {
        throw new GameError('INVALID_PHASE', 'You are already in a room.');
      }
      const { room, player, token } = store.createRoom({
        name: payload.name,
        socketId: socket.id,
        ip,
      });
      return bind(room, player, token);
    });

    register('room:join', async (payload) => {
      if (socket.data.binding) {
        throw new GameError('INVALID_PHASE', 'You are already in a room.');
      }
      const { room, player, token } = store.joinRoom({
        code: payload.code,
        name: payload.name,
        socketId: socket.id,
        ip,
      });
      return bind(room, player, token);
    });

    register('session:resume', async (payload) => {
      const token = typeof payload.token === 'string' ? payload.token : '';
      if (token.length < 20 || token.length > 120) {
        throw new GameError('SESSION_GONE');
      }
      const { room, player, previousSocketId } = store.resumeSession({
        token,
        socketId: socket.id,
      });
      if (previousSocketId && previousSocketId !== socket.id) {
        const previous = io.sockets.sockets.get(previousSocketId);
        if (previous) {
          previous.emit('session:replaced');
          previous.data.binding = null;
          previous.leave(roomChannel(room.id));
          previous.disconnect(true);
        }
      }
      return bind(room, player, token);
    });

    register('room:duration', async (payload) => {
      const binding = requireBinding();
      const room = store.setDuration({
        roomId: binding.roomId,
        playerId: binding.playerId,
        durationSeconds: payload.durationSeconds,
      });
      return { state: store.stateFor(room, binding.playerId) };
    });

    register('room:ready', async (payload) => {
      const binding = requireBinding();
      const room = store.setReady({
        roomId: binding.roomId,
        playerId: binding.playerId,
        ready: payload.ready,
      });
      return { state: store.stateFor(room, binding.playerId) };
    });

    register('room:start', async () => {
      const binding = requireBinding();
      const room = store.startMatch({
        roomId: binding.roomId,
        playerId: binding.playerId,
      });
      return { state: store.stateFor(room, binding.playerId) };
    });

    register('sticker:send', async (payload) => {
      const binding = requireBinding();
      const result = store.recordSend({
        roomId: binding.roomId,
        playerId: binding.playerId,
        socketId: socket.id,
        stickerId: payload.stickerId,
        eventId: payload.eventId,
      });
      return result;
    });

    register('match:rematch', async () => {
      const binding = requireBinding();
      const room = store.requestRematch({
        roomId: binding.roomId,
        playerId: binding.playerId,
      });
      return { state: store.stateFor(room, binding.playerId) };
    });

    register('room:leave', async () => {
      const binding = socket.data.binding;
      if (!binding) return { left: true };
      store.leaveRoom({ roomId: binding.roomId, playerId: binding.playerId, reason: 'left' });
      socket.leave(roomChannel(binding.roomId));
      socket.data.binding = null;
      return { left: true };
    });

    register('state:request', async () => {
      const binding = requireBinding();
      const room = store.getRoomById(binding.roomId);
      if (!room) throw new GameError('SESSION_GONE');
      const player = store.findPlayer(room, binding.playerId);
      if (!player) throw new GameError('SESSION_GONE');
      return { state: store.stateFor(room, binding.playerId) };
    });

    register('time:sync', async () => ({ serverNow: store.now() }));

    socket.on('disconnect', (reason) => {
      socketIpHits.set(ip, Math.max(0, ipSocketCount(ip) - 1));
      const binding = socket.data.binding;
      socket.data.binding = null;
      if (!binding) return;
      try {
        store.markDisconnected({
          roomId: binding.roomId,
          playerId: binding.playerId,
          socketId: socket.id,
        });
      } catch (error) {
        logger.warn('disconnect_handling_failed', { error: error.name || 'Error' });
      }
      logger.debug('socket_disconnected', { reason });
    });
  });

  return {
    close() {
      for (const entry of scoreFlushTimers.values()) clearTimeout(entry.timer);
      scoreFlushTimers.clear();
      socketIpHits.clear();
    },
  };
}

module.exports = { createSocketServer };
