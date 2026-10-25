'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, expectCode } = require('./store-harness');

function eventId(seed = 'a') {
  return `event-${seed.repeat(8)}`;
}

test('a valid sticker send adds exactly one point', () => {
  const { store, startReadyMatch, send } = createHarness();
  const { host, room } = startReadyMatch();

  const first = send(host, room, eventId('a'));
  assert.equal(first.score, 1);
  const second = send(host, room, eventId('b'), 'sticker-two');
  assert.equal(second.score, 2);
  assert.equal(store.findPlayer(room, host.player.id).score, 2);
  assert.equal(room.sendsAccepted, 2);
});

test('rejects sends from a socket that does not own the slot', () => {
  const { store, startReadyMatch } = createHarness();
  const { host, guest, room } = startReadyMatch();

  expectCode(
    () => store.recordSend({
      roomId: room.id,
      playerId: host.player.id,
      socketId: guest.player.socketId,
      stickerId: 'sticker-one',
      eventId: eventId('c'),
    }),
    'NOT_IN_ROOM',
  );
  expectCode(
    () => store.recordSend({
      roomId: room.id,
      playerId: 'pl_forged',
      socketId: host.player.socketId,
      stickerId: 'sticker-one',
      eventId: eventId('d'),
    }),
    'NOT_IN_ROOM',
  );
  assert.equal(store.findPlayer(room, host.player.id).score, 0);
});

test('rejects sends for another room', () => {
  const { store, startReadyMatch, createRoom } = createHarness();
  const { host, room } = startReadyMatch();
  const other = createRoom('Other');

  expectCode(
    () => store.recordSend({
      roomId: other.room.id,
      playerId: host.player.id,
      socketId: host.player.socketId,
      stickerId: 'sticker-one',
      eventId: eventId('e'),
    }),
    'NOT_IN_ROOM',
  );
});

test('rejects sends outside the playing phase', () => {
  const { store, clock, createRoom, joinRoom } = createHarness();
  const host = createRoom();
  const guest = joinRoom(host.room.code);
  store.setDuration({ roomId: host.room.id, playerId: host.player.id, durationSeconds: 30 });
  store.setReady({ roomId: host.room.id, playerId: host.player.id, ready: true });
  store.setReady({ roomId: host.room.id, playerId: guest.player.id, ready: true });
  store.startMatch({ roomId: host.room.id, playerId: host.player.id });

  // COUNTDOWN
  expectCode(
    () => store.recordSend({
      roomId: host.room.id,
      playerId: host.player.id,
      socketId: host.player.socketId,
      stickerId: 'sticker-one',
      eventId: eventId('f'),
    }),
    'NOT_STARTED',
  );

  // PLAYING
  clock.advance(4000);
  store.tick();
  const ok = store.recordSend({
    roomId: host.room.id,
    playerId: host.player.id,
    socketId: host.player.socketId,
    stickerId: 'sticker-one',
    eventId: eventId('g'),
  });
  assert.equal(ok.score, 1);

  // FINISHED
  clock.advance(31000);
  store.tick();
  expectCode(
    () => store.recordSend({
      roomId: host.room.id,
      playerId: host.player.id,
      socketId: host.player.socketId,
      stickerId: 'sticker-one',
      eventId: eventId('h'),
    }),
    'ROUND_OVER',
  );
});

test('rejects a late send at the official end time', () => {
  const { store, clock, startReadyMatch } = createHarness();
  const { host, room } = startReadyMatch();

  clock.set(room.endsAt);
  expectCode(
    () => store.recordSend({
      roomId: room.id,
      playerId: host.player.id,
      socketId: host.player.socketId,
      stickerId: 'sticker-one',
      eventId: eventId('i'),
    }),
    'ROUND_OVER',
  );
  assert.equal(room.phase, 'FINISHED', 'a late send finalizes the round immediately');
  assert.equal(store.findPlayer(room, host.player.id).score, 0);
});

test('duplicate event ids never award a second point', () => {
  const { store, startReadyMatch, send } = createHarness();
  const { host, room } = startReadyMatch();
  send(host, room, eventId('j'));
  expectCode(
    () => store.recordSend({
      roomId: room.id,
      playerId: host.player.id,
      socketId: host.player.socketId,
      stickerId: 'sticker-one',
      eventId: eventId('j'),
    }),
    'DUPLICATE_EVENT',
  );
  assert.equal(store.findPlayer(room, host.player.id).score, 1);
});

test('rejects malformed event ids and unknown stickers', () => {
  const { store, startReadyMatch, send } = createHarness();
  const { host, room } = startReadyMatch();

  for (const bad of ['', 'short', 'has spaces here', 'x'.repeat(80), null, 42]) {
    expectCode(
      () => store.recordSend({
        roomId: room.id,
        playerId: host.player.id,
        socketId: host.player.socketId,
        stickerId: 'sticker-one',
        eventId: bad,
      }),
      'INVALID_PHASE',
    );
  }

  for (const badSticker of ['../etc/passwd', 'sticker-999', '', null, 'sticker-one ']) {
    expectCode(
      () => store.recordSend({
        roomId: room.id,
        playerId: host.player.id,
        socketId: host.player.socketId,
        stickerId: badSticker,
        eventId: eventId('k'),
      }),
      'INVALID_STICKER',
    );
  }
  assert.equal(store.findPlayer(room, host.player.id).score, 0);
  assert.equal(send(host, room, eventId('l')).score, 1);
});

test('client supplied score fields cannot change the official score', () => {
  const { store, startReadyMatch } = createHarness();
  const { host, room } = startReadyMatch();
  const before = store.findPlayer(room, host.player.id).score;

  const result = store.recordSend({
    roomId: room.id,
    playerId: host.player.id,
    socketId: host.player.socketId,
    stickerId: 'sticker-one',
    eventId: eventId('m'),
    score: 9999,
    winnerId: host.player.id,
    durationSeconds: 1,
  });
  assert.equal(result.score, before + 1);
  assert.equal(result.scores[host.player.id], 1);
  assert.equal(room.durationSeconds, 30);
});

test('rate limiting allows fast play then blocks bursts, and recovers', () => {
  const { store, clock, startReadyMatch } = createHarness({ SEND_BURST: '5', SEND_PER_SECOND: '2' });
  const { host, room } = startReadyMatch();

  for (let i = 0; i < 5; i += 1) {
    const result = store.recordSend({
      roomId: room.id,
      playerId: host.player.id,
      socketId: host.player.socketId,
      stickerId: 'sticker-one',
      eventId: eventId(`r${i}`),
    });
    assert.equal(result.score, i + 1);
  }

  expectCode(
    () => store.recordSend({
      roomId: room.id,
      playerId: host.player.id,
      socketId: host.player.socketId,
      stickerId: 'sticker-one',
      eventId: eventId('r5'),
    }),
    'RATE_LIMITED',
  );
  assert.equal(store.findPlayer(room, host.player.id).score, 5);
  assert.ok(room.sendsRejected >= 1);

  clock.advance(1000);
  const recovered = store.recordSend({
    roomId: room.id,
    playerId: host.player.id,
    socketId: host.player.socketId,
    stickerId: 'sticker-one',
    eventId: eventId('r6'),
  });
  assert.equal(recovered.score, 6);
});

test('default rate limit supports sustained fast tapping', () => {
  const { store, clock, startReadyMatch } = createHarness();
  const { host, room } = startReadyMatch();

  let accepted = 0;
  for (let second = 0; second < 5; second += 1) {
    for (let tap = 0; tap < 9; tap += 1) {
      try {
        store.recordSend({
          roomId: room.id,
          playerId: host.player.id,
          socketId: host.player.socketId,
          stickerId: 'sticker-one',
          eventId: eventId(`${second}${tap}zz`),
        });
        accepted += 1;
      } catch (error) {
        assert.equal(error.code, 'RATE_LIMITED');
      }
    }
    clock.advance(1000);
  }
  assert.ok(accepted >= 45, `expected at least 45 accepted sends, received ${accepted}`);
});

test('both players can score at the same instant', () => {
  const { store, startReadyMatch, send } = createHarness();
  const { host, guest, room } = startReadyMatch();

  const a = send(host, room, eventId('s'));
  const b = send(guest, room, eventId('t'));
  assert.equal(a.score, 1);
  assert.equal(b.score, 1);

  const scores = store.publicState(room).players.map((p) => p.score);
  assert.deepEqual(scores, [1, 1]);
  assert.equal(room.sendsAccepted, 2);
});

test('a send from a disconnected player is rejected', () => {
  const { store, startReadyMatch } = createHarness();
  const { host, room } = startReadyMatch();
  host.player.connected = false;
  expectCode(
    () => store.recordSend({
      roomId: room.id,
      playerId: host.player.id,
      socketId: host.player.socketId,
      stickerId: 'sticker-one',
      eventId: eventId('u'),
    }),
    'PLAYER_DISCONNECTED',
  );
});

test('the winner and margin are computed from server scores', () => {
  const { store, clock, startReadyMatch, send } = createHarness();
  const { host, guest, room } = startReadyMatch();
  for (let i = 0; i < 3; i += 1) send(host, room, eventId(`w${i}`));
  send(guest, room, eventId('v0'));

  clock.advance(30000);
  store.tick();
  const result = store.publicState(room).result;
  assert.equal(result.winnerId, host.player.id);
  assert.equal(result.draw, false);
  assert.equal(result.scoreDifference, 2);
  assert.equal(result.scores.find((s) => s.playerId === host.player.id).score, 3);
  assert.equal(result.scores.find((s) => s.playerId === guest.player.id).score, 1);
});

test('a tie is reported as a draw', () => {
  const { store, clock, startReadyMatch, send } = createHarness();
  const { host, guest, room } = startReadyMatch();
  send(host, room, eventId('x0'));
  send(guest, room, eventId('x1'));
  clock.advance(30000);
  store.tick();
  const result = store.publicState(room).result;
  assert.equal(result.draw, true);
  assert.equal(result.winnerId, null);
  assert.equal(result.scoreDifference, 0);
});

test('dedupe window stays bounded', () => {
  const { store, startReadyMatch } = createHarness({
    DEDUPE_WINDOW: '50',
    SEND_BURST: '60',
    SEND_PER_SECOND: '10',
  });
  const { host, room } = startReadyMatch();
  for (let i = 0; i < 20; i += 1) {
    store.recordSend({
      roomId: room.id,
      playerId: host.player.id,
      socketId: host.player.socketId,
      stickerId: 'sticker-one',
      eventId: eventId(`d${i}`),
    });
  }
  assert.ok(host.player.seenEventOrder.length <= 50);
  assert.equal(host.player.seenEvents.size, host.player.seenEventOrder.length);
});
