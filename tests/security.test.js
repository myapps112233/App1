'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startServer, connect, request, wait } = require('./helpers');

test('health check, public config and security headers', async (t) => {
  const harness = await startServer();
  t.after(() => harness.close());

  const health = await fetch(`${harness.url}/healthz`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.status, 'ok');
  assert.equal(healthBody.catalog, 12);
  assert.equal(health.headers.get('x-powered-by'), null);
  assert.match(health.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(health.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('referrer-policy'), 'no-referrer');

  const config = await (await fetch(`${harness.url}/api/config`)).json();
  assert.deepEqual(config.durations, [30, 60, 90]);
  assert.equal(config.sendPerSecond, 10);
  assert.equal(config.production, false);

  const catalog = await (await fetch(`${harness.url}/api/stickers`)).json();
  assert.equal(catalog.stickers.length, 12);
  for (const sticker of catalog.stickers) {
    assert.match(sticker.src, /^\/stickers\/[A-Za-z0-9._-]+\.(webp|png|jpe?g)$/);
    assert.match(sticker.id, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
    assert.ok(sticker.alt.length > 0);
  }
});

test('private and development paths are not served', async (t) => {
  const harness = await startServer();
  t.after(() => harness.close());

  for (const pathname of [
    '/src/server.js',
    '/src/config.js',
    '/tests/helpers.js',
    '/package.json',
    '/package-lock.json',
    '/.env',
    '/.git/config',
    '/stickers/%2e%2e%2f%2e%2e%2fpackage.json',
    '/stickers/..%2f..%2fpackage.json',
    '/legal/nope',
  ]) {
    const response = await fetch(`${harness.url}${pathname}`);
    assert.equal(response.status, 404, `${pathname} should not be served`);
  }

  assert.equal((await fetch(`${harness.url}/css/styles.css`)).status, 200);
  assert.equal((await fetch(`${harness.url}/js/app.js`)).status, 200);
  const stickerFile = await fetch(`${harness.url}/stickers/STK-20260825-WA0079.webp`);
  assert.equal(stickerFile.status, 200);
  assert.match(stickerFile.headers.get('cache-control'), /immutable/);
  assert.match(stickerFile.headers.get('content-type'), /image\/webp/);
});

test('legal pages render configured contact details without placeholders', async (t) => {
  const harness = await startServer();
  t.after(() => harness.close());

  for (const page of ['privacy', 'terms', 'cookies', 'accessibility', 'contact']) {
    const response = await fetch(`${harness.url}/legal/${page}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(!html.includes('{{'), `${page} still contains an unreplaced placeholder`);
    assert.ok(html.includes('privacy@example.test'), `${page} should show the configured contact`);
  }

  const privacy = await (await fetch(`${harness.url}/legal/privacy`)).text();
  assert.match(privacy, /Not affiliated with WhatsApp or Meta/);
  assert.match(privacy, /local storage/i);
});

test('api errors are JSON without stack traces', async (t) => {
  const harness = await startServer();
  t.after(() => harness.close());

  const notFound = await fetch(`${harness.url}/api/unknown`);
  assert.equal(notFound.status, 404);
  assert.deepEqual(await notFound.json(), { error: 'not_found' });

  for (const pathname of ['/src/server.js', '/nope']) {
    const html = await (await fetch(`${harness.url}${pathname}`)).text();
    assert.ok(!/\bat .*\.js:\d+/.test(html), 'no stack traces in error pages');
  }
});

test('oversized JSON payloads are rejected', async (t) => {
  const harness = await startServer();
  t.after(() => harness.close());

  const response = await fetch(`${harness.url}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(8000) }),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'payload_too_large' });
});

test('websocket handshake rejects foreign origins but accepts its own host', async (t) => {
  const harness = await startServer();
  t.after(() => harness.close());

  await assert.rejects(
    connect(harness.url, { extraHeaders: { Origin: 'https://evil.example' } }),
    /origin_not_allowed|websocket error|forbidden/i,
  );

  const sameOrigin = await connect(harness.url, {
    extraHeaders: { Origin: `http://127.0.0.1:${harness.port}` },
  });
  assert.equal(sameOrigin.connected, true);
  sameOrigin.disconnect();
});

test('the development only origin escape hatch works and production ignores it', async (t) => {
  const dev = await startServer({ DEV_ALLOW_ANY_ORIGIN: '1' });
  t.after(() => dev.close());
  const relaxed = await connect(dev.url, {
    extraHeaders: { Origin: 'https://some-preview-host.example' },
  });
  assert.equal(relaxed.connected, true);
  relaxed.disconnect();

  const prod = await startServer({ DEV_ALLOW_ANY_ORIGIN: '1', NODE_ENV: 'production' });
  t.after(() => prod.close());
  await assert.rejects(
    connect(prod.url, { extraHeaders: { Origin: 'https://some-preview-host.example' } }),
    /origin_not_allowed|websocket error|forbidden/i,
  );
});

test('an allowlisted production origin works while others are refused', async (t) => {
  const harness = await startServer({ ALLOWED_ORIGINS: 'https://allowed.example' });
  t.after(() => harness.close());

  const allowed = await connect(harness.url, {
    extraHeaders: { Origin: 'https://allowed.example' },
  });
  allowed.disconnect();

  await assert.rejects(
    connect(harness.url, { extraHeaders: { Origin: 'https://blocked.example' } }),
    /origin_not_allowed|websocket error|forbidden/i,
  );
});

test('unauthenticated socket actions are refused', async (t) => {
  const harness = await startServer();
  t.after(() => harness.close());
  const socket = await connect(harness.url);
  t.after(() => socket.disconnect());

  for (const [event, payload] of [
    ['room:ready', { ready: true }],
    ['room:start', {}],
    ['room:duration', { durationSeconds: 30 }],
    ['sticker:send', { stickerId: 'anything', eventId: 'abcdefgh1234' }],
    ['match:rematch', {}],
    ['state:request', {}],
  ]) {
    const response = await request(socket, event, payload);
    assert.equal(response.ok, false, `${event} should require a room`);
    assert.equal(response.code, 'NOT_IN_ROOM');
  }
});

test('malformed socket payloads are rejected without crashing the server', async (t) => {
  const harness = await startServer();
  t.after(() => harness.close());
  const socket = await connect(harness.url);
  t.after(() => socket.disconnect());

  const stringPayload = await new Promise((resolve) => {
    socket.timeout(2000).emit('room:create', 'not-an-object', (error, response) => resolve(response));
  });
  assert.equal(stringPayload.ok, false);
  assert.equal(stringPayload.code, 'INVALID_PAYLOAD');

  const tooManyKeys = {};
  for (let i = 0; i < 12; i += 1) tooManyKeys[`key${i}`] = i;
  const manyKeys = await request(socket, 'room:create', tooManyKeys);
  assert.equal(manyKeys.ok, false);
  assert.equal(manyKeys.code, 'INVALID_PAYLOAD');

  const badName = await request(socket, 'room:create', { name: { $ne: null } });
  assert.equal(badName.ok, false);
  assert.equal(badName.code, 'INVALID_NAME');

  const badCode = await request(socket, 'room:join', { code: '../../etc/passwd', name: 'Mallory' });
  assert.equal(badCode.ok, false);
  assert.equal(badCode.code, 'ROOM_NOT_FOUND');

  const health = await fetch(`${harness.url}/healthz`);
  assert.equal(health.status, 200);
});

test('room actions are authorized against the joined slot, not payload fields', async (t) => {
  const harness = await startServer();
  t.after(() => harness.close());

  const host = await connect(harness.url);
  const guest = await connect(harness.url);
  t.after(() => {
    host.disconnect();
    guest.disconnect();
  });

  const created = await request(host, 'room:create', { name: 'Ada' });
  const joined = await request(guest, 'room:join', { code: created.state.code, name: 'Bo' });

  const guestStart = await request(guest, 'room:start', {
    roomId: created.state.roomId,
    playerId: created.playerId,
    hostId: created.playerId,
  });
  assert.equal(guestStart.ok, false);
  assert.equal(guestStart.code, 'NOT_HOST');

  const spoofedReady = await request(guest, 'room:ready', {
    ready: true,
    playerId: created.playerId,
  });
  assert.equal(spoofedReady.ok, true);
  assert.equal(
    spoofedReady.state.players.find((p) => p.id === created.playerId).ready,
    false,
    'the host must not be marked ready by the guest payload',
  );
  assert.equal(spoofedReady.state.players.find((p) => p.id === joined.playerId).ready, true);

  const guestLeave = await request(guest, 'room:leave', { playerId: created.playerId });
  assert.equal(guestLeave.ok, true);
  const afterLeave = await request(host, 'state:request');
  assert.equal(afterLeave.state.players.length, 1);
  assert.equal(afterLeave.state.players[0].id, created.playerId);
});

test('a third player cannot join over the socket transport', async (t) => {
  const harness = await startServer();
  t.after(() => harness.close());

  const host = await connect(harness.url);
  const guest = await connect(harness.url);
  const third = await connect(harness.url);
  t.after(() => {
    host.disconnect();
    guest.disconnect();
    third.disconnect();
  });

  const created = await request(host, 'room:create', { name: 'Ada' });
  await request(guest, 'room:join', { code: created.state.code, name: 'Bo' });
  const rejected = await request(third, 'room:join', { code: created.state.code, name: 'Mallory' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'ROOM_FULL');
});

test('session tokens cannot be guessed', async (t) => {
  const harness = await startServer();
  t.after(() => harness.close());
  const socket = await connect(harness.url);
  t.after(() => socket.disconnect());

  for (const token of ['a'.repeat(43), 'short', '', 'x'.repeat(500)]) {
    const response = await request(socket, 'session:resume', { token });
    assert.equal(response.ok, false);
    assert.equal(response.code, 'SESSION_GONE');
  }
});

test('socket connections per IP are capped', async (t) => {
  const harness = await startServer({ MAX_SOCKETS_PER_IP: '2' });
  t.after(() => harness.close());

  const a = await connect(harness.url);
  const b = await connect(harness.url);
  t.after(() => {
    a.disconnect();
    b.disconnect();
  });

  await assert.rejects(
    connect(harness.url),
    /too_many_connections|websocket error|forbidden/i,
  );

  a.disconnect();
  await wait(100);
  const c = await connect(harness.url);
  c.disconnect();
});

test('a disconnect storm leaves the server healthy', async (t) => {
  const harness = await startServer();
  t.after(() => harness.close());

  const sockets = await Promise.all(
    Array.from({ length: 8 }, () => connect(harness.url)),
  );
  for (const socket of sockets) socket.disconnect();
  await wait(150);

  const health = await fetch(`${harness.url}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
});

test('rooms are isolated from one another over the socket transport', async (t) => {
  const harness = await startServer();
  t.after(() => harness.close());

  const a = await connect(harness.url);
  const b = await connect(harness.url);
  t.after(() => {
    a.disconnect();
    b.disconnect();
  });

  const roomA = await request(a, 'room:create', { name: 'Alpha' });
  await request(b, 'room:create', { name: 'Beta' });

  const startA = await request(a, 'room:ready', { ready: true });
  assert.equal(startA.ok, true);

  const stateB = await request(b, 'state:request');
  assert.equal(stateB.state.roomId !== roomA.state.roomId, true);
  assert.equal(stateB.state.players.length, 1);
  assert.equal(stateB.state.players[0].name, 'Beta');
});
