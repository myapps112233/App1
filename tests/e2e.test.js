'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startServer, connect, request, track, once } = require('./helpers');

function sendSticker(socket, stickerId, suffix) {
  return request(socket, 'sticker:send', {
    stickerId,
    eventId: `testevent${suffix}`.padEnd(12, 'x'),
  });
}

test('two independent clients complete a full match end to end', async (t) => {
  const harness = await startServer({ SEND_PER_SECOND: '20', SEND_BURST: '30' });
  t.after(() => harness.close());

  const catalog = await (await fetch(`${harness.url}/api/stickers`)).json();
  assert.ok(catalog.stickers.length >= 3);
  const stickerId = catalog.stickers[0].id;

  const host = await connect(harness.url);
  const guest = await connect(harness.url);
  t.after(() => {
    host.disconnect();
    guest.disconnect();
  });
  const hostLog = track(host);
  const guestLog = track(guest);

  // Create and join through the real socket transport.
  const created = await request(host, 'room:create', { name: 'Ada' });
  assert.equal(created.ok, true);
  assert.equal(created.state.phase, 'WAITING');
  assert.equal(typeof created.token, 'string');
  assert.ok(created.token.length > 30);

  const code = created.state.code;
  const joined = await request(guest, 'room:join', { code: code.toLowerCase(), name: 'Bo' });
  assert.equal(joined.ok, true);
  assert.equal(joined.state.phase, 'READY');

  const lobbyState = await hostLog.waitFor('states', (state) => state.code === code && state.players.length === 2);
  assert.deepEqual(
    lobbyState.players.map((player) => player.name).sort(),
    ['Ada', 'Bo'],
  );

  // Duration is host only.
  const guestDuration = await request(guest, 'room:duration', { durationSeconds: 30 });
  assert.equal(guestDuration.ok, false);
  assert.equal(guestDuration.code, 'NOT_HOST');

  const duration = await request(host, 'room:duration', { durationSeconds: 30 });
  assert.equal(duration.ok, true);
  assert.equal(duration.state.durationSeconds, 30);

  // Starting early is refused.
  const earlyStart = await request(host, 'room:start');
  assert.equal(earlyStart.ok, false);
  assert.equal(earlyStart.code, 'NOT_READY');

  assert.equal((await request(host, 'room:ready', { ready: true })).ok, true);
  const guestReady = await request(guest, 'room:ready', { ready: true });
  assert.equal(guestReady.ok, true);

  const hostStartEvent = once(host, 'match:started');
  const guestStartEvent = once(guest, 'match:started');
  const started = await request(host, 'room:start');
  assert.equal(started.ok, true);
  assert.equal(started.state.phase, 'COUNTDOWN');

  const [hostStart, guestStart] = await Promise.all([hostStartEvent, guestStartEvent]);
  assert.equal(hostStart.startsAt, guestStart.startsAt);
  assert.equal(hostStart.endsAt, guestStart.endsAt);
  assert.equal(hostStart.durationSeconds, 30);

  // The fake clock drives the server side transitions deterministically.
  harness.clock.advance(hostStart.startsAt - harness.clock.now() + 5);
  harness.store.tick();
  await hostLog.waitFor('states', (state) => state.phase === 'PLAYING');
  await guestLog.waitFor('states', (state) => state.phase === 'PLAYING');

  // Sending before the server considers the round live is impossible; now sends count.
  const hostSends = await Promise.all([
    sendSticker(host, stickerId, 'aaaa'),
    sendSticker(host, stickerId, 'bbbb'),
    sendSticker(host, stickerId, 'cccc'),
  ]);
  assert.deepEqual(hostSends.map((r) => r.ok), [true, true, true]);
  assert.deepEqual(hostSends.map((r) => r.score), [1, 2, 3]);

  const guestSend = await sendSticker(guest, stickerId, 'dddd');
  assert.equal(guestSend.ok, true);
  assert.equal(guestSend.score, 1);

  const scoreUpdate = await guestLog.waitFor(
    'scores',
    (payload) => payload.scores && payload.scores[created.playerId] === 3,
  );
  assert.equal(scoreUpdate.scores[joined.playerId], 1);

  const duplicate = await sendSticker(host, stickerId, 'aaaa');
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'DUPLICATE_EVENT');

  const forgedSticker = await request(host, 'sticker:send', {
    stickerId: 'not-a-real-sticker',
    eventId: 'forgedevent123',
    score: 500,
    playerId: joined.playerId,
  });
  assert.equal(forgedSticker.ok, false);
  assert.equal(forgedSticker.code, 'INVALID_STICKER');

  // Advance to the official end of the round.
  harness.clock.advance(hostStart.endsAt - harness.clock.now());
  harness.store.tick();

  const [hostEnd, guestEnd] = await Promise.all([
    hostLog.waitFor('ends', (payload) => Boolean(payload.result)),
    guestLog.waitFor('ends', (payload) => Boolean(payload.result)),
  ]);
  assert.deepEqual(hostEnd.result, guestEnd.result, 'both players must receive the same result');
  assert.equal(hostEnd.result.winnerId, created.playerId);
  assert.equal(hostEnd.result.draw, false);
  assert.equal(hostEnd.result.scoreDifference, 2);
  assert.equal(hostEnd.result.durationSeconds, 30);

  const afterEnd = await sendSticker(host, stickerId, 'eeee');
  assert.equal(afterEnd.ok, false);
  assert.equal(afterEnd.code, 'ROUND_OVER');

  // Rejoin after the round finished returns the finalized result, not a new round.
  const rejoin = await connect(harness.url);
  t.after(() => rejoin.disconnect());
  const resumed = await request(rejoin, 'session:resume', { token: created.token });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.state.phase, 'FINISHED');
  assert.deepEqual(resumed.state.result, hostEnd.result);
  assert.equal(resumed.playerId, created.playerId);

  // Guest refreshes and rematches; both accepting resets the room.
  const guestAgain = await connect(harness.url);
  t.after(() => guestAgain.disconnect());
  const guestAgainLog = track(guestAgain);
  const guestResume = await request(guestAgain, 'session:resume', { token: joined.token });
  assert.equal(guestResume.ok, true);
  assert.equal(guestResume.state.phase, 'FINISHED');
  assert.deepEqual(guestResume.state.result, guestEnd.result);

  const hostRematch = await request(rejoin, 'match:rematch');
  assert.equal(hostRematch.ok, true);
  const guestRematch = await request(guestAgain, 'match:rematch');
  assert.equal(guestRematch.ok, true);
  assert.equal(guestRematch.state.phase, 'READY');
  assert.deepEqual(guestRematch.state.players.map((p) => p.score), [0, 0]);
  await guestAgainLog.waitFor('states', (state) => state.phase === 'READY');

});

test('a session token cannot be replayed alongside an active socket without replacing it', async (t) => {
  const harness = await startServer();
  t.after(() => harness.close());

  const first = await connect(harness.url);
  const second = await connect(harness.url);
  t.after(() => {
    first.disconnect();
    second.disconnect();
  });

  const created = await request(first, 'room:create', { name: 'Ada' });
  const replaced = new Promise((resolve) => first.once('session:replaced', resolve));
  // The same token from a second tab claims the slot and evicts the first socket.
  const resumed = await request(second, 'session:resume', { token: created.token });
  await replaced;
  assert.equal(resumed.ok, true);
  assert.equal(resumed.playerId, created.playerId);

  await new Promise((resolve) => {
    if (first.disconnected) return resolve();
    first.once('disconnect', resolve);
  });
  assert.equal(first.connected, false);
});
