'use strict';

/**
 * DOM level integration test.
 *
 * Loads the real index.html into jsdom, imports the real client modules against a
 * real server, then drives the interface the way a player would: type a name,
 * press Create room, ready up, start, send stickers and read the result. A raw
 * Socket.IO client plays the opponent so the UI is exercised with genuine server
 * broadcasts rather than stubs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');
const { io } = require('socket.io-client');

const { startServer, connect, request, wait } = require('./helpers');

const root = path.resolve(__dirname, '..');
const nodeFetch = globalThis.fetch;
const nodeCrypto = globalThis.crypto;
const appSockets = [];

async function waitFor(predicate, label = 'condition', timeout = 6000) {
  const start = Date.now();
  for (;;) {
    let value;
    try {
      value = predicate();
    } catch {
      value = false;
    }
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await wait(25);
  }
}

function clickSubmit(form, button) {
  const event = new form.ownerDocument.defaultView.SubmitEvent('submit', {
    bubbles: true,
    cancelable: true,
    submitter: button,
  });
  form.dispatchEvent(event);
}

async function bootClient(url) {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: `${url}/`, pretendToBeVisual: true });
  const { window } = dom;

  window.scrollTo = () => {};
  window.confirm = () => true;
  window.HTMLElement.prototype.scrollIntoView = () => {};

  const setGlobal = (name, value) => {
    Object.defineProperty(globalThis, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  };

  setGlobal('window', window);
  setGlobal('document', window.document);
  setGlobal('location', window.location);
  setGlobal('history', window.history);
  setGlobal('navigator', window.navigator);
  setGlobal('localStorage', window.localStorage);
  setGlobal('sessionStorage', window.sessionStorage);
  setGlobal('Image', window.Image);
  setGlobal('HTMLElement', window.HTMLElement);
  setGlobal('Event', window.Event);
  setGlobal('SubmitEvent', window.SubmitEvent);
  setGlobal('crypto', nodeCrypto);
  setGlobal('io', (...args) => {
    const socket = io(...args);
    appSockets.push(socket);
    return socket;
  });
  setGlobal('fetch', (input, init) => nodeFetch(new URL(input, url), init));

  const moduleUrl = `${pathToFileURL(path.join(root, 'public/js/app.js')).href}?t=${Date.now()}`;
  await import(moduleUrl);

  return { dom, window };
}

test('a player can create a room, play a match and see the result in the browser UI', async (t) => {
  const harness = await startServer({ SEND_PER_SECOND: '20', SEND_BURST: '30' });
  t.after(() => harness.close());

  const { window } = await bootClient(harness.url);
  const document = window.document;
  t.after(() => {
    // Leave the room through the UI so the countdown loop stops, then drop sockets.
    try {
      document.getElementById('result-home').click();
    } catch {
      /* ignore */
    }
    for (const socket of appSockets) {
      try {
        socket.disconnect();
      } catch {
        /* ignore */
      }
    }
    window.close();
  });

  await waitFor(
    () => document.getElementById('conn-text').textContent === 'Connected',
    'socket connection',
  );

  // Home screen is the visible screen at boot.
  assert.equal(document.getElementById('screen-home').hidden, false);
  assert.equal(document.getElementById('screen-lobby').hidden, true);

  // A short name is refused before any network call.
  const nameInput = document.getElementById('player-name');
  nameInput.value = 'A';
  clickSubmit(document.getElementById('home-form'), document.getElementById('create-room'));
  await waitFor(() => !document.getElementById('name-error').hidden, 'name validation');
  assert.match(document.getElementById('name-error').textContent, /at least 2/i);

  // Valid name, create room.
  nameInput.value = '  Ada  ';
  clickSubmit(document.getElementById('home-form'), document.getElementById('create-room'));
  await waitFor(
    () => document.getElementById('screen-lobby').hidden === false,
    'lobby screen',
  );
  const code = document.getElementById('lobby-code').textContent.trim();
  assert.match(code, /^[A-Z2-9]{6}$/);
  assert.match(document.getElementById('invite-link').value, new RegExp(`#/room/${code}$`));

  // The opponent joins from a separate raw socket.
  const guest = await connect(harness.url);
  t.after(() => guest.disconnect());
  const guestJoin = await request(guest, 'room:join', { code, name: 'Bo' });
  assert.equal(guestJoin.ok, true);

  await waitFor(
    () => document.querySelectorAll('#lobby-players .player-card').length === 2,
    'two player cards',
  );
  const lobbyText = document.getElementById('lobby-players').textContent;
  assert.match(lobbyText, /Ada/);
  assert.match(lobbyText, /Bo/);

  // Host only controls.
  assert.equal(document.getElementById('start-match').hidden, false);
  assert.equal(document.getElementById('start-match').disabled, true);
  assert.ok(!document.querySelector('#duration-options input').disabled);

  // The host picks a 30 second round; the server confirms the change.
  document.querySelector('#duration-options input[value="30"]').click();
  await waitFor(
    () => harness.store.listRooms()[0].durationSeconds === 30,
    'duration change',
  );

  // Guest readies up, then the UI player readies up through the button.
  await request(guest, 'room:ready', { ready: true });
  const readyButton = document.getElementById('ready-toggle');
  await waitFor(() => readyButton.textContent === 'I am ready', 'ready button label');
  readyButton.click();
  await waitFor(() => readyButton.getAttribute('aria-pressed') === 'true', 'ready pressed');
  await waitFor(() => document.getElementById('start-match').disabled === false, 'start enabled');

  // Start the match.
  document.getElementById('start-match').click();
  await waitFor(() => document.getElementById('screen-arena').hidden === false, 'arena screen');
  await waitFor(
    () => document.querySelectorAll('#tray .sticker-option').length >= 3,
    'sticker tray',
  );
  const trayCount = document.querySelectorAll('#tray .sticker-option').length;
  assert.ok(trayCount >= 3 && trayCount <= 6);
  assert.equal(document.getElementById('arena-you-name').textContent, 'Ada');
  assert.equal(document.getElementById('arena-them-name').textContent, 'Bo');

  // Move the authoritative clock into the playing window.
  const room = harness.store.listRooms()[0];
  harness.clock.advance(room.startsAt - harness.clock.now() + 5);
  harness.store.tick();
  await waitFor(() => document.getElementById('send-sticker').disabled === false, 'send enabled');

  // Send three stickers through the real send control.
  const sendButton = document.getElementById('send-sticker');
  sendButton.click();
  sendButton.click();
  sendButton.click();
  await waitFor(
    () => harness.store.listRooms()[0].players.find((p) => p.name === 'Ada').score === 3,
    'server score',
  );
  await waitFor(() => document.getElementById('arena-you-score').textContent === '3', 'ui score');

  // Selecting a different sticker from the tray works with the keyboard too.
  const trayButtons = [...document.querySelectorAll('#tray .sticker-option')];
  trayButtons[1].click();
  assert.equal(trayButtons[1].getAttribute('aria-pressed'), 'true');

  const keyEvent = new window.KeyboardEvent('keydown', { key: '1', bubbles: true });
  document.dispatchEvent(keyEvent);
  assert.equal(
    document.querySelectorAll('#tray .sticker-option')[0].getAttribute('aria-pressed'),
    'true',
  );

  // Finish the round on the server.
  harness.clock.set(room.endsAt + 1);
  harness.store.tick();
  await waitFor(() => document.getElementById('screen-results').hidden === false, 'results screen');
  assert.equal(document.getElementById('results-title').textContent, 'You win');
  assert.match(document.getElementById('result-scores').textContent, /3/);
  assert.match(document.getElementById('result-scores').textContent, /Bo/);
  assert.equal(document.getElementById('best-banner').hidden, false);
  assert.match(document.getElementById('best-banner-value').textContent, /personal best|First record/i);

  const saved = JSON.parse(window.localStorage.getItem('sticker-showdown:record:v1'));
  assert.deepEqual(saved, { bestScore: 3, opponentName: 'Bo', roundDurationSeconds: 30 });

  await wait(120);
  assert.equal(document.getElementById('rematch').disabled, false);
  assert.equal(document.getElementById('result-copy').disabled, false);
  assert.equal(document.getElementById('result-home').disabled, false);
});
