'use strict';

const { loadConfig } = require('../src/config');
const { createRoomStore, GameError } = require('../src/game/rooms');
const { createFakeClock } = require('./helpers');

const STICKERS = new Set(['sticker-one', 'sticker-two', 'sticker-three']);

function createHarness(overrides = {}, options = {}) {
  const clock = options.clock || createFakeClock();
  const config = loadConfig({
    NODE_ENV: 'test',
    ROOM_IDLE_TTL_MS: '60000',
    DISCONNECT_GRACE_MS: '10000',
    ...overrides,
  });
  const codes = ['ABC234', 'DEF567', 'GHJ890', 'KLM234', 'NPQ567', 'RST890'];
  let index = 0;
  const store = createRoomStore({
    config,
    clock,
    stickerIds: STICKERS,
    useTimers: false,
    codeGenerator:
      options.codeGenerator ||
      (() => {
        const code = codes[index % codes.length];
        index += 1;
        return code;
      }),
  });

  function createRoom(name = 'Ada', socketId = 'socket-ada', ip = '10.0.0.1') {
    return store.createRoom({ name, socketId, ip });
  }

  function joinRoom(code, name = 'Bo', socketId = 'socket-bo', ip = '10.0.0.2') {
    return store.joinRoom({ code, name, socketId, ip });
  }

  function startReadyMatch({ durationSeconds = 30, hostName = 'Ada', guestName = 'Bo' } = {}) {
    const host = createRoom(hostName);
    const guest = joinRoom(host.room.code, guestName);
    store.setDuration({ roomId: host.room.id, playerId: host.player.id, durationSeconds });
    store.setReady({ roomId: host.room.id, playerId: host.player.id, ready: true });
    store.setReady({ roomId: host.room.id, playerId: guest.player.id, ready: true });
    store.startMatch({ roomId: host.room.id, playerId: host.player.id });
    clock.advance(config.countdownMs + 10);
    store.tick();
    return { host, guest, room: host.room };
  }

  function send(player, room, eventId, stickerId = 'sticker-one') {
    return store.recordSend({
      roomId: room.id,
      playerId: player.player.id,
      socketId: player.player.socketId,
      stickerId,
      eventId,
    });
  }

  return { store, config, clock, createRoom, joinRoom, startReadyMatch, send, STICKERS, GameError };
}

function expectCode(fn, code) {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (!thrown) throw new Error(`expected GameError ${code}, nothing was thrown`);
  if (!(thrown instanceof GameError)) throw thrown;
  if (thrown.code !== code) {
    throw new Error(`expected ${code}, received ${thrown.code}`);
  }
  return thrown;
}

module.exports = { createHarness, expectCode, STICKERS };
