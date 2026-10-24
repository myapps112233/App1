'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../src/config');
const { createRoomStore, GameError } = require('../src/game/rooms');
const { createFakeClock } = require('./helpers');

const STICKERS = new Set(['sticker-one', 'sticker-two', 'sticker-three']);

function setup(overrides = {}, options = {}) {
  const clock = options.clock || createFakeClock();
  const config = loadConfig({
    NODE_ENV: 'test',
    ROOM_IDLE_TTL_MS: '60000',
    DISCONNECT_GRACE_MS: '10000',
    ...overrides,
  });
  let counter = 0;
  const store = createRoomStore({
    config,
    clock,
    stickerIds: STICKERS,
    useTimers: false,
    codeGenerator:
      options.codeGenerator ||
      (() => {
        const codes = ['ABC234', 'DEF567', 'GHJ890', 'KLM234', 'NPQ567', 'RST890'];
        const code = codes[counter % codes.length];
        counter += 1;
        return code;
      }),
  });
  return { store, config, clock };
}

function create(store, name = 'Ada', socketId = 'socket-host') {
  return store.createRoom({ name, socketId, ip: '10.0.0.1' });
}

function join(store, code, name = 'Bo', socketId = 'socket-guest') {
  return store.joinRoom({ code, name, socketId, ip: '10.0.0.2' });
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof GameError, 'expected a GameError');
    assert.equal(error.code, code);
    return true;
  });
}

test('creates a room with a random id, six character code and host slot', () => {
  const { store } = setup();
  const { room, player, token } = create(store);

  assert.match(room.code, /^[A-Z2-9]{6}$/);
  assert.notEqual(room.id, room.code);
  assert.ok(room.id.length >= 16);
  assert.ok(token.length >= 40);
  assert.equal(room.phase, 'WAITING');
  assert.equal(room.players.length, 1);
  assert.equal(player.name, 'Ada');
  assert.equal(room.hostId, player.id);
  assert.equal(store.getRoomByCode(room.code.toLowerCase())?.id, room.id);
});

test('rejects invalid display names', () => {
  const { store } = setup();
  for (const name of ['', ' ', 'a', 'x'.repeat(17), '<script>alert(1)</script>', 'Host']) {
    expectCode(() => create(store, name), 'INVALID_NAME');
  }
  assert.equal(store.stats().rooms, 0);
});

test('accepts punctuation and unicode names', () => {
  const { store } = setup();
  const first = create(store, "Ana-Maria O'Neil");
  assert.equal(first.player.name, "Ana-Maria O'Neil");
  const second = create(store, 'Ana  María');
  assert.equal(second.player.name, 'Ana María');
});

test('joins a room, switches to READY and shows both names', () => {
  const { store } = setup();
  const host = create(store);
  const guest = join(store, host.room.code);

  assert.equal(host.room.phase, 'READY');
  assert.equal(host.room.players.length, 2);
  const hostView = store.stateFor(host.room, host.player.id);
  const guestView = store.stateFor(guest.room, guest.player.id);

  assert.deepEqual(
    hostView.players.map((p) => p.name),
    guestView.players.map((p) => p.name),
  );
  assert.equal(hostView.players.find((p) => p.isHost).name, 'Ada');
  assert.equal(guestView.players.find((p) => p.isHost).name, 'Ada');
});

test('rejects unknown, malformed and expired room codes', () => {
  const { store, clock, config } = setup();
  expectCode(() => join(store, 'ZZZZZZ'), 'ROOM_NOT_FOUND');
  expectCode(() => join(store, 'bad'), 'ROOM_NOT_FOUND');
  expectCode(() => join(store, ''), 'ROOM_NOT_FOUND');
  expectCode(() => join(store, 'O0I1LL'), 'ROOM_NOT_FOUND');

  const host = create(store);
  clock.advance(config.roomIdleTtlMs + 1);
  expectCode(() => join(store, host.room.code), 'ROOM_EXPIRED');
});

test('rejects a third competitor', () => {
  const { store } = setup();
  const host = create(store);
  join(store, host.room.code);
  expectCode(
    () => store.joinRoom({ code: host.room.code, name: 'Third', socketId: 's3', ip: '10.0.0.3' }),
    'ROOM_FULL',
  );
});

test('rejects joining an already started or finished room', () => {
  const { store, clock } = setup();
  const host = create(store);
  const guest = join(store, host.room.code);
  store.setDuration({ roomId: host.room.id, playerId: host.player.id, durationSeconds: 30 });
  store.setReady({ roomId: host.room.id, playerId: host.player.id, ready: true });
  store.setReady({ roomId: host.room.id, playerId: guest.player.id, ready: true });
  store.startMatch({ roomId: host.room.id, playerId: host.player.id });

  expectCode(
    () => store.joinRoom({ code: host.room.code, name: 'Late', socketId: 's4', ip: '10.0.0.4' }),
    'ROOM_STARTED',
  );

  clock.advance(35 * 1000);
  store.tick();
  assert.equal(host.room.phase, 'FINISHED');
  expectCode(
    () => store.joinRoom({ code: host.room.code, name: 'Later', socketId: 's5', ip: '10.0.0.5' }),
    'ROOM_STARTED',
  );
});

test('blocks duplicate names inside the same room', () => {
  const { store } = setup();
  const host = create(store, 'Same');
  expectCode(() => join(store, host.room.code, 'same'), 'NAME_TAKEN');
});

test('enforces host-only actions and room membership', () => {
  const { store } = setup();
  const host = create(store);
  const guest = join(store, host.room.code);

  expectCode(
    () => store.setDuration({ roomId: host.room.id, playerId: guest.player.id, durationSeconds: 30 }),
    'NOT_HOST',
  );
  expectCode(
    () => store.startMatch({ roomId: host.room.id, playerId: guest.player.id }),
    'NOT_HOST',
  );
  expectCode(() => store.setReady({ roomId: host.room.id, playerId: 'pl_unknown', ready: true }), 'NOT_IN_ROOM');
  expectCode(() => store.setDuration({ roomId: 'rm_missing', playerId: host.player.id, durationSeconds: 30 }), 'ROOM_CLOSED');
});

test('two players in different rooms cannot touch each other', () => {
  const { store } = setup();
  const a = create(store, 'Alpha');
  const b = create(store, 'Beta');

  expectCode(
    () => store.setReady({ roomId: a.room.id, playerId: b.player.id, ready: true }),
    'NOT_IN_ROOM',
  );
  expectCode(
    () => store.recordSend({
      roomId: a.room.id,
      playerId: b.player.id,
      socketId: b.player.socketId,
      stickerId: 'sticker-one',
      eventId: 'event-abcdefgh',
    }),
    'NOT_IN_ROOM',
  );
});

test('prevents room code collisions', () => {
  const codes = ['ABC234', 'ABC234', 'DEF567'];
  let index = 0;
  const { store } = setup({}, { codeGenerator: () => codes[Math.min(index++, codes.length - 1)] });
  const first = create(store);
  const second = create(store, 'Second');
  assert.equal(first.room.code, 'ABC234');
  assert.equal(second.room.code, 'DEF567');
  assert.equal(store.stats().rooms, 2);
});

test('fails safely when no unique code can be allocated', () => {
  const { store } = setup({}, { codeGenerator: () => 'ABC234' });
  create(store);
  expectCode(() => create(store, 'Second'), 'ROOM_LIMIT', 'should not overwrite the first room');
  assert.equal(store.stats().rooms, 1);
});

test('expires abandoned rooms and drops their tokens', () => {
  const { store, clock, config } = setup();
  const host = create(store);
  const token = host.token;
  clock.advance(config.roomIdleTtlMs + 1000);
  store.tick();
  expectCode(() => store.resumeSession({ token, socketId: 'new' }), 'SESSION_GONE');
  assert.equal(store.stats().rooms, 0);
});

test('resumes a session and replaces the older socket', () => {
  const { store } = setup();
  const host = create(store);
  const resumed = store.resumeSession({ token: host.token, socketId: 'socket-second' });
  assert.equal(resumed.player.id, host.player.id);
  assert.equal(resumed.previousSocketId, 'socket-host');
  assert.equal(resumed.player.socketId, 'socket-second');

  expectCode(() => store.resumeSession({ token: 'not-a-real-token', socketId: 'x' }), 'SESSION_GONE');
  expectCode(() => store.resumeSession({ token: '', socketId: 'x' }), 'SESSION_GONE');
});

test('a brief lobby disconnect does not remove the player before the grace period', () => {
  const { store, clock, config } = setup();
  const host = create(store);
  const guest = join(store, host.room.code);

  store.markDisconnected({ roomId: host.room.id, playerId: guest.player.id, socketId: 'socket-guest' });
  assert.equal(store.findPlayer(host.room, guest.player.id).connected, false);

  clock.advance(config.disconnectGraceMs - 1000);
  store.tick();
  assert.equal(host.room.players.length, 2);

  clock.advance(2000);
  store.tick();
  assert.equal(host.room.players.length, 1);
  assert.equal(host.room.phase, 'WAITING');
  assert.equal(store.findPlayer(host.room, host.player.id).connected, true);
});

test('promotes the remaining player when the host leaves the lobby', () => {
  const { store } = setup();
  const host = create(store);
  const guest = join(store, host.room.code);

  store.leaveRoom({ roomId: host.room.id, playerId: host.player.id });
  assert.equal(host.room.players.length, 1);
  assert.equal(host.room.hostId, guest.player.id);
  assert.equal(host.room.phase, 'WAITING');
});

test('closes the room when the last player leaves', () => {
  const { store } = setup();
  const host = create(store);
  store.leaveRoom({ roomId: host.room.id, playerId: host.player.id });
  assert.equal(store.stats().rooms, 0);
});

test('ignores stale disconnect events from a replaced socket', () => {
  const { store } = setup();
  const host = create(store);
  store.resumeSession({ token: host.token, socketId: 'socket-second' });
  const result = store.markDisconnected({
    roomId: host.room.id,
    playerId: host.player.id,
    socketId: 'socket-host',
  });
  assert.equal(result, null);
  assert.equal(store.findPlayer(host.room, host.player.id).connected, true);
});

test('enforces room capacity on room creation', () => {
  const { store } = setup({ MAX_ROOMS: '10', MAX_ROOMS_PER_IP: '2' });
  create(store, 'One');
  create(store, 'Two');
  expectCode(() => create(store, 'Three'), 'TOO_MANY_ROOMS');
});
