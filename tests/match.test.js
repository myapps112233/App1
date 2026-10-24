'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, expectCode } = require('./store-harness');

test('a match cannot start until both players are ready', () => {
  const { store, createRoom, joinRoom } = createHarness();
  const host = createRoom();
  const guest = joinRoom(host.room.code);
  store.setDuration({ roomId: host.room.id, playerId: host.player.id, durationSeconds: 30 });

  expectCode(
    () => store.startMatch({ roomId: host.room.id, playerId: host.player.id }),
    'NOT_READY',
  );

  store.setReady({ roomId: host.room.id, playerId: host.player.id, ready: true });
  expectCode(
    () => store.startMatch({ roomId: host.room.id, playerId: host.player.id }),
    'NOT_READY',
  );

  store.setReady({ roomId: host.room.id, playerId: guest.player.id, ready: true });
  const room = store.startMatch({ roomId: host.room.id, playerId: host.player.id });
  assert.equal(room.phase, 'COUNTDOWN');
  assert.equal(room.roundNumber, 1);
  assert.ok(room.startsAt > 0);
  assert.equal(room.endsAt - room.startsAt, 30000);
});

test('the host cannot start alone', () => {
  const { store, createRoom } = createHarness();
  const host = createRoom();
  store.setReady({ roomId: host.room.id, playerId: host.player.id, ready: true });
  expectCode(
    () => store.startMatch({ roomId: host.room.id, playerId: host.player.id }),
    'NOT_ENOUGH_PLAYERS',
  );
});

test('only permitted round lengths are accepted', () => {
  const { store, createRoom, joinRoom } = createHarness();
  const host = createRoom();
  joinRoom(host.room.code);

  for (const duration of [0, 15, 45, 120, '60', null]) {
    expectCode(
      () => store.setDuration({ roomId: host.room.id, playerId: host.player.id, durationSeconds: duration }),
      'INVALID_DURATION',
    );
  }
  for (const duration of [30, 60, 90]) {
    store.setDuration({ roomId: host.room.id, playerId: host.player.id, durationSeconds: duration });
    assert.equal(host.room.durationSeconds, duration);
  }
});

test('both players receive the same room state during a match', () => {
  const { store, startReadyMatch } = createHarness();
  const { host, guest, room } = startReadyMatch();

  const hostView = store.stateFor(room, host.player.id);
  const guestView = store.stateFor(room, guest.player.id);

  assert.equal(hostView.phase, 'PLAYING');
  assert.equal(hostView.startsAt, guestView.startsAt);
  assert.equal(hostView.endsAt, guestView.endsAt);
  assert.equal(hostView.durationSeconds, guestView.durationSeconds);
  assert.equal(hostView.hostId, guestView.hostId);
  assert.deepEqual(
    hostView.players.map((p) => p.name),
    guestView.players.map((p) => p.name),
  );
  assert.equal(hostView.rules.scoring, 'server');
});

test('the countdown moves to PLAYING and the timer ends the round', () => {
  const { store, clock, config, createRoom, joinRoom } = createHarness();
  const host = createRoom();
  const guest = joinRoom(host.room.code);
  store.setDuration({ roomId: host.room.id, playerId: host.player.id, durationSeconds: 30 });
  store.setReady({ roomId: host.room.id, playerId: host.player.id, ready: true });
  store.setReady({ roomId: host.room.id, playerId: guest.player.id, ready: true });
  store.startMatch({ roomId: host.room.id, playerId: host.player.id });

  assert.equal(host.room.phase, 'COUNTDOWN');
  clock.advance(config.countdownMs - 100);
  store.tick();
  assert.equal(host.room.phase, 'COUNTDOWN');

  clock.advance(200);
  store.tick();
  assert.equal(host.room.phase, 'PLAYING');

  clock.advance(30000);
  store.tick();
  assert.equal(host.room.phase, 'FINISHED');
  assert.equal(host.room.result.reason, 'time');
  assert.equal(host.room.result.durationSeconds, 30);
  assert.equal(store.stateFor(host.room, host.player.id).result.draw, true);
});

test('a finished round cannot be restarted by a late start event', () => {
  const { store, clock, startReadyMatch } = createHarness();
  const { host, room } = startReadyMatch();

  clock.advance(30000);
  store.tick();
  assert.equal(room.phase, 'FINISHED');
  const resultBefore = JSON.stringify(room.result);

  expectCode(
    () => store.startMatch({ roomId: room.id, playerId: host.player.id }),
    'INVALID_PHASE',
  );
  assert.equal(JSON.stringify(room.result), resultBefore);
  assert.equal(room.phase, 'FINISHED');
});

test('the round can only be finalized once', () => {
  const { store, clock, startReadyMatch } = createHarness();
  const { room } = startReadyMatch();
  clock.advance(30000);
  const first = store.finishRound({ roomId: room.id, reason: 'time' });
  const second = store.finishRound({ roomId: room.id, reason: 'time' });
  assert.equal(first, second);
  expectCode(() => store.finishRound({ roomId: 'rm_missing' }), 'ROOM_NOT_FOUND');
});

test('rematch is only available after the round finishes', () => {
  const harness = createHarness();
  const { host, room } = harness.startReadyMatch();
  expectCode(
    () => harness.store.requestRematch({ roomId: room.id, playerId: host.player.id }),
    'REMATCH_NOT_AVAILABLE',
  );
});

test('rematch requires both players and resets scores and timestamps', () => {
  const { store, clock, startReadyMatch, send } = createHarness();
  const { host, guest, room } = startReadyMatch();
  send(host, room, 'event-aaaaaaaa');
  send(host, room, 'event-bbbbbbbb');
  send(guest, room, 'event-cccccccc');

  clock.advance(30000);
  store.tick();
  assert.equal(room.phase, 'FINISHED');
  assert.equal(
    store.stateFor(room, host.player.id).result.scores.find((s) => s.playerId === host.player.id).score,
    2,
  );

  store.requestRematch({ roomId: room.id, playerId: host.player.id });
  assert.equal(room.phase, 'FINISHED', 'one request must not restart the match');
  assert.deepEqual(store.publicState(room).rematch.requestedBy, [host.player.id]);

  store.requestRematch({ roomId: room.id, playerId: guest.player.id });
  assert.equal(room.phase, 'READY');
  assert.equal(room.result, null);
  assert.equal(room.startsAt, null);
  assert.equal(room.endsAt, null);
  assert.deepEqual(room.players.map((p) => p.score), [0, 0]);
  assert.deepEqual(room.players.map((p) => p.ready), [false, false]);

  store.setReady({ roomId: room.id, playerId: host.player.id, ready: true });
  store.setReady({ roomId: room.id, playerId: guest.player.id, ready: true });
  store.startMatch({ roomId: room.id, playerId: host.player.id });
  assert.equal(room.roundNumber, 2);
  assert.equal(room.result, null);
  assert.ok(room.startsAt > 0);
});

test('the room stays addressable for the whole round', () => {
  const { store, clock, config, startReadyMatch } = createHarness();
  const { host, room } = startReadyMatch();
  clock.advance(10000);
  store.tick();
  assert.equal(room.phase, 'PLAYING');
  const resumed = store.resumeSession({ token: host.token, socketId: 'reconnect-1' });
  assert.equal(resumed.room.id, room.id);
  assert.equal(room.expiresAt > room.endsAt, true);
  assert.ok(config.roomFinishedTtlMs > 0);
});

test('a player who leaves mid round keeps their score for the result', () => {
  const { store, clock, startReadyMatch, send } = createHarness();
  const { host, guest, room } = startReadyMatch();
  send(guest, room, 'event-dddddddd');
  store.leaveRoom({ roomId: room.id, playerId: guest.player.id });

  assert.equal(room.players.length, 2);
  assert.equal(store.findPlayer(room, guest.player.id).connected, false);

  clock.advance(30000);
  store.tick();
  const result = store.stateFor(room, host.player.id).result;
  assert.equal(result.scores.find((s) => s.playerId === guest.player.id).score, 1);
  assert.equal(result.winnerId, guest.player.id);
});

test('a disconnected player can reconnect before the round ends', () => {
  const { store, startReadyMatch } = createHarness();
  const { guest, room } = startReadyMatch();
  store.markDisconnected({ roomId: room.id, playerId: guest.player.id, socketId: 'socket-bo' });
  assert.equal(store.findPlayer(room, guest.player.id).connected, false);

  store.resumeSession({ token: guest.token, socketId: 'socket-bo-new' });
  assert.equal(store.findPlayer(room, guest.player.id).connected, true);
  assert.equal(store.findPlayer(room, guest.player.id).socketId, 'socket-bo-new');
});

test('finished rooms expire and disappear', () => {
  const { store, clock, config, startReadyMatch } = createHarness();
  const { room } = startReadyMatch();

  clock.advance(30000);
  store.tick();
  assert.equal(room.phase, 'FINISHED');

  clock.advance(config.roomFinishedTtlMs + 1000);
  store.tick();
  assert.equal(store.getRoomById(room.id), null);
  assert.equal(store.stats().rooms, 0);
});
