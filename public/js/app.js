import {
  readRecord,
  saveIfBetter,
  clearRecord,
  readStoredName,
  saveName,
  describeRecord,
} from './records.mjs';
import { createServerClock } from './time-sync.mjs';
import { createSocketClient } from './socket-client.js';

const SESSION_KEY = 'sticker-showdown:session:v1';
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._'\u2019!?&+#-]*$/u;
const RESERVED_NAMES = new Set(['host', 'guest', 'server', 'admin', 'system', 'null', 'undefined']);

const $ = (id) => document.getElementById(id);

const el = {
  screens: {
    home: $('screen-home'),
    lobby: $('screen-lobby'),
    arena: $('screen-arena'),
    results: $('screen-results'),
    records: $('screen-records'),
  },
  connStatus: $('conn-status'),
  connText: $('conn-text'),
  rateFact: $('rate-fact'),

  homeForm: $('home-form'),
  nameInput: $('player-name'),
  nameError: $('name-error'),
  createRoom: $('create-room'),
  codeInput: $('room-code'),
  codeError: $('code-error'),
  joinRoom: $('join-room'),
  homeError: $('home-error'),
  homeBest: $('home-best'),
  homeBestMeta: $('home-best-meta'),

  lobbyCode: $('lobby-code'),
  lobbyLead: $('lobby-lead'),
  inviteLink: $('invite-link'),
  copyInvite: $('copy-invite'),
  copyStatus: $('copy-status'),
  lobbyPlayers: $('lobby-players'),
  durationOptions: $('duration-options'),
  durationHint: $('duration-hint'),
  readyToggle: $('ready-toggle'),
  startMatch: $('start-match'),
  startHint: $('start-hint'),
  lobbyLeave: $('lobby-leave'),

  youName: $('arena-you-name'),
  youScore: $('arena-you-score'),
  themName: $('arena-them-name'),
  themScore: $('arena-them-score'),
  timer: $('arena-timer'),
  timerLabel: $('timer-label'),
  timerFill: $('timer-fill'),
  stageFrame: $('stage-frame'),
  stageEmpty: $('stage-empty'),
  stageImage: $('stage-image'),
  stageWho: $('stage-who'),
  feed: $('feed'),
  tray: $('tray'),
  sendBtn: $('send-sticker'),
  sendMeta: $('send-meta'),
  arenaStatus: $('arena-status'),
  arenaLeave: $('arena-leave'),
  liveStatus: $('live-status'),
  liveScore: $('live-score'),

  resultsEyebrow: $('results-eyebrow'),
  resultsTitle: $('results-title'),
  resultsVerdict: $('results-verdict'),
  resultScores: $('result-scores'),
  resultMargin: $('result-margin'),
  bestBanner: $('best-banner'),
  bestBannerValue: $('best-banner-value'),
  rematch: $('rematch'),
  resultCopy: $('result-copy'),
  resultHome: $('result-home'),
  rematchStatus: $('rematch-status'),
  resultError: $('result-error'),
  resultLive: $('result-live'),

  recordScore: $('record-score'),
  recordOpponent: $('record-opponent'),
  recordDuration: $('record-duration'),
  recordError: $('record-error'),
  clearRecord: $('clear-record'),

  confirmDialog: $('confirm-dialog'),
  confirmTitle: $('confirm-title'),
  confirmBody: $('confirm-body'),
  confirmAccept: $('confirm-accept'),
};

const state = {
  config: null,
  catalog: [],
  stickerById: new Map(),
  broken: new Set(),
  socket: null,
  connected: false,
  connecting: false,
  session: null,
  token: null,
  playerId: null,
  room: null,
  you: null,
  inRoom: false,
  screen: 'home',
  clock: createServerClock(),
  tray: [],
  selectedId: null,
  recentIds: [],
  pending: 0,
  feed: [],
  timerHandle: null,
  rotateHandle: null,
  holdHandle: null,
  holdRepeated: false,
  resultHandledKey: null,
  lastScoreAnnounceAt: 0,
  lastAnnouncedScore: '',
  resumeInFlight: false,
  clockCalibratedForRound: null,
  finalizeFallback: null,
};

/* ------------------------------- utilities ------------------------------- */

function normalizeName(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function validateNameClient(value) {
  const name = normalizeName(value);
  if (!name) return { ok: false, message: 'Enter a display name to continue.' };
  if (name.length < 2) return { ok: false, message: 'Use at least 2 characters for your name.' };
  if (name.length > 16) return { ok: false, message: 'Keep your name to 16 characters or fewer.' };
  if (!NAME_PATTERN.test(name)) {
    return {
      ok: false,
      message: 'Use letters, numbers, spaces or simple punctuation such as . _ -',
    };
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    return { ok: false, message: 'That name is reserved. Pick another one.' };
  }
  return { ok: true, name };
}

function normalizeCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

function makeEventId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, '');
  } catch {
    /* fall through */
  }
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function announce(message) {
  if (!message) return;
  el.liveStatus.textContent = message;
}

function setError(node, message) {
  if (!node) return;
  if (message) {
    node.textContent = message;
    node.hidden = false;
  } else {
    node.textContent = '';
    node.hidden = true;
  }
}

function formatSeconds(totalMs) {
  const totalSeconds = Math.max(0, Math.ceil(totalMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function inviteUrl(code) {
  return `${location.origin}${location.pathname}#/room/${code}`;
}

async function copyText(text, sourceInput) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    const ok = document.execCommand('copy');
    helper.remove();
    if (ok) return true;
  } catch {
    /* ignore */
  }
  if (sourceInput) {
    sourceInput.focus();
    sourceInput.select();
  }
  return false;
}

function confirmAction({ title, body, confirmLabel = 'Confirm' }) {
  return new Promise((resolve) => {
    const dialog = el.confirmDialog;
    if (!dialog || typeof dialog.showModal !== 'function') {
      resolve(globalThis.confirm(body)); // eslint-disable-line no-alert
      return;
    }
    el.confirmTitle.textContent = title;
    el.confirmBody.textContent = body;
    el.confirmAccept.textContent = confirmLabel;
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      resolve(dialog.returnValue === 'confirm');
    };
    dialog.addEventListener('close', onClose);
    dialog.showModal();
  });
}

/* -------------------------------- session -------------------------------- */

function saveSession(session) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* private mode: the match still works, refresh will not resume */
  }
  state.session = session;
}

function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.token !== 'string' || typeof parsed.code !== 'string') return null;
    if (parsed.token.length < 20) return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
  state.session = null;
  state.token = null;
  state.playerId = null;
  state.room = null;
  state.you = null;
  state.inRoom = false;
}

/* -------------------------------- screens -------------------------------- */

const HEADINGS = {
  home: 'home-title',
  lobby: 'lobby-title',
  arena: 'arena-title',
  results: 'results-title',
  records: 'records-title',
};

function showScreen(name, { focus = true } = {}) {
  for (const [key, node] of Object.entries(el.screens)) {
    if (node) node.hidden = key !== name;
  }
  state.screen = name;

  if (name === 'arena') startTimerLoop();
  else stopTimerLoop();

  if (state.room && state.inRoom) {
    history.replaceState(null, '', `#/room/${state.room.code}`);
  } else if (name === 'records') {
    history.replaceState(null, '', '#/records');
  } else if (name === 'home') {
    history.replaceState(null, '', '#/');
  }

  updateUnloadGuard();

  if (focus) {
    const heading = document.getElementById(HEADINGS[name] || '');
    if (heading) heading.focus({ preventScroll: true });
  }
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function updateUnloadGuard() {
  const active = state.room && ['COUNTDOWN', 'PLAYING'].includes(state.room.phase);
  if (active) {
    if (!state.unloadGuard) {
      state.unloadGuard = (event) => {
        event.preventDefault();
        event.returnValue = '';
      };
      window.addEventListener('beforeunload', state.unloadGuard);
    }
  } else if (state.unloadGuard) {
    window.removeEventListener('beforeunload', state.unloadGuard);
    state.unloadGuard = null;
  }
}

function showHome(message) {
  stopTimerLoop();
  clearTrayRotation();
  showScreen('home');
  refreshRecordUI();
  if (message) announce(message);
  setError(el.homeError, '');
}

function showRecords() {
  renderRecords();
  showScreen('records');
}

/* -------------------------------- records -------------------------------- */

function refreshRecordUI() {
  const { record, corrupt, available } = readRecord();
  if (!available) {
    el.homeBest.textContent = 'Local storage is blocked';
    el.homeBestMeta.textContent = 'This browser will not keep a personal record.';
    return;
  }
  if (corrupt) {
    el.homeBest.textContent = 'Saved record was unreadable';
    el.homeBestMeta.textContent = 'Clearing the record on the Records screen resets it.';
    return;
  }
  if (!record) {
    el.homeBest.textContent = 'No record yet';
    el.homeBestMeta.textContent = 'Play a match to set your first record on this device.';
    return;
  }
  el.homeBest.textContent = `${record.bestScore} stickers`;
  el.homeBestMeta.textContent = `Against ${record.opponentName}${record.roundDurationSeconds ? ` in ${record.roundDurationSeconds} seconds` : ''}. Stored only in this browser.`;
}

function renderRecords() {
  const { record, corrupt, available } = readRecord();
  const view = describeRecord(record);
  el.recordScore.textContent = view.score;
  el.recordOpponent.textContent = view.opponent;
  el.recordDuration.textContent = view.duration;

  if (!available) {
    setError(el.recordError, 'This browser blocked local storage, so no record can be saved.');
  } else if (corrupt) {
    setError(el.recordError, 'The saved record could not be read. Clear it to start again.');
  } else {
    setError(el.recordError, '');
  }
  el.clearRecord.disabled = !available;
}

el.clearRecord?.addEventListener('click', async () => {
  const ok = await confirmAction({
    title: 'Clear saved record',
    body: 'This removes the personal best stored in this browser. It cannot be undone.',
    confirmLabel: 'Clear record',
  });
  if (!ok) return;
  clearRecord();
  renderRecords();
  refreshRecordUI();
  announce('Personal record cleared for this browser.');
});

/* ------------------------------- socket layer ---------------------------- */

function ensureSocket() {
  if (state.socket) return state.socket;
  state.socket = createSocketClient({
    onConnectionChange: handleConnectionChange,
    onState: (payload) => applyPublicState(payload),
    onScores: (payload) => applyScores(payload),
    onSticker: (payload) => {
      if (!state.inRoom) return;
      pushFeed(payload.playerId, payload.stickerId);
      const name = playerName(payload.playerId);
      showStage(payload.stickerId, payload.playerId === state.playerId ? 'You sent' : `${name} sent`);
    },
    onMatchStarted: (payload) => {
      state.clock.noteServerNow(payload.serverNow);
      calibrateClock();
      if (state.room) {
        state.room.phase = 'COUNTDOWN';
        state.room.startsAt = payload.startsAt;
        state.room.endsAt = payload.endsAt;
        state.room.roundNumber = payload.roundNumber ?? state.room.roundNumber;
        state.room.durationSeconds = payload.durationSeconds ?? state.room.durationSeconds;
        state.room.result = null;
      }
      prepareArena({ reset: true });
      if (state.screen !== 'arena') showScreen('arena');
      updateTimerDisplay();
    },
    onMatchEnded: (payload) => {
      state.clock.noteServerNow(payload.serverNow);
      if (state.room) {
        state.room.result = payload.result;
        state.room.phase = 'FINISHED';
      }
      if (state.inRoom) showResults();
    },
    onNotice: (payload) => {
      if (!state.inRoom) return;
      announce(payload?.message || 'Room update.');
      if (payload?.code === 'PLAYER_LEFT') {
        el.arenaStatus.textContent = payload.message;
      }
    },
    onRoomClosed: () => {
      if (!state.inRoom) return;
      clearSession();
      showHome('That room is closed. Create a new one to play again.');
    },
    onSessionReplaced: () => {
      clearSession();
      try {
        state.socket?.socket.disconnect();
      } catch {
        /* ignore */
      }
      showHome('This room was opened in another tab, so this tab stopped playing.');
    },
  });
  return state.socket;
}

function handleConnectionChange(status, reason) {
  state.connected = status === 'connected';
  el.connStatus.dataset.state = status;
  if (status === 'connecting') {
    el.connText.textContent = 'Connecting';
  } else if (status === 'connected') {
    el.connText.textContent = 'Connected';
    if (state.session && state.inRoom === false && state.resumeInFlight === false) {
      // A reload or dropped connection: rejoin the same slot.
      resumeSession();
    } else if (state.inRoom) {
      resumeSession();
    }
    if (state.screen === 'arena') updateSendState();
  } else if (status === 'reconnecting') {
    el.connText.textContent = 'Reconnecting';
    if (state.inRoom) announce('Connection lost. Reconnecting to your match.');
    updateSendState();
  } else {
    el.connText.textContent = 'Offline';
    if (state.inRoom) {
      announce('You are offline. The server keeps your room open for a short grace period.');
      el.arenaStatus.textContent = 'Connection lost. Trying to reconnect.';
    }
    updateSendState();
    if (reason === 'io server disconnect') {
      el.connText.textContent = 'Disconnected';
    }
  }
}

async function resumeSession() {
  if (state.resumeInFlight) return;
  const session = loadSession();
  if (!session || !state.connected) return;
  state.resumeInFlight = true;
  try {
    const res = await state.socket.request('session:resume', { token: session.token });
    if (!res.ok) {
      if (res.code === 'SESSION_GONE' || res.code === 'ROOM_CLOSED' || res.code === 'ROOM_EXPIRED') {
        clearSession();
        if (state.screen !== 'home') showHome('That match has ended or expired. Create a new room to play.');
      }
      return;
    }
    state.token = session.token;
    state.playerId = res.playerId;
    state.inRoom = true;
    saveSession({ code: res.state.code, token: session.token, playerId: res.playerId });
    state.room = res.state;
    state.you = res.state.you;
    state.clock.noteServerNow(res.state.serverNow);
    announce('Reconnected to your match.');
    applyPhase({ fromResume: true });
    if (['COUNTDOWN', 'PLAYING'].includes(res.state.phase)) calibrateClock();
  } finally {
    state.resumeInFlight = false;
  }
}

/* ----------------------------- state rendering --------------------------- */

function playerName(playerId) {
  const player = state.room?.players.find((entry) => entry.id === playerId);
  return player?.name || 'Player';
}

function opponentOfMe() {
  const room = state.room;
  if (!room) return null;
  return room.players.find((player) => player.id !== state.playerId) || null;
}

function myPlayer() {
  const room = state.room;
  if (!room) return null;
  return room.players.find((player) => player.id === state.playerId) || null;
}

function applyPublicState(payload) {
  if (!state.inRoom) return;
  if (!payload || typeof payload !== 'object') return;
  if (state.room && payload.roomId && payload.roomId !== state.room.roomId) return;

  state.room = payload;
  state.you = myPlayer();
  state.clock.noteServerNow(payload.serverNow);
  applyPhase();
}

function applyPhase({ fromResume = false } = {}) {
  const room = state.room;
  if (!room || !state.inRoom) return;

  if (room.phase === 'WAITING' || room.phase === 'READY') {
    renderLobby();
    if (state.screen !== 'lobby') showScreen('lobby', { focus: !fromResume });
  } else if (room.phase === 'COUNTDOWN' || room.phase === 'PLAYING') {
    prepareArena();
    renderArena();
    if (state.screen !== 'arena') showScreen('arena', { focus: !fromResume });
  } else if (room.phase === 'FINISHED') {
    showResults();
  }
}

function applyScores(payload) {
  if (!state.inRoom || !state.room || !payload?.scores) return;
  let changed = false;
  for (const player of state.room.players) {
    if (typeof payload.scores[player.id] === 'number') {
      if (player.score !== payload.scores[player.id]) changed = true;
      player.score = payload.scores[player.id];
    }
  }
  if (changed) {
    renderScores();
    maybeAnnounceScore();
  }
}

/* --------------------------------- lobby --------------------------------- */

function buildDurationOptions() {
  if (!el.durationOptions || el.durationOptions.dataset.built === 'true') return;
  const durations = state.config?.durations || [30, 60, 90];
  el.durationOptions.innerHTML = '';
  for (const duration of durations) {
    const wrapper = document.createElement('label');
    wrapper.className = 'duration-option';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'duration';
    input.value = String(duration);
    input.addEventListener('change', async () => {
      if (!input.checked) return;
      const res = await state.socket.request('room:duration', {
        durationSeconds: Number(input.value),
      });
      if (!res.ok) {
        setError(el.homeError, res.message);
        if (res.state) {
          state.room = res.state;
          renderLobby();
        }
      }
    });
    const label = document.createElement('span');
    label.textContent = `${duration}s`;
    wrapper.append(input, label);
    el.durationOptions.appendChild(wrapper);
  }
  el.durationOptions.dataset.built = 'true';
}

function renderLobby() {
  const room = state.room;
  if (!room || !state.inRoom) return;
  const me = myPlayer();
  const isHost = room.hostId === state.playerId;
  const bothPresent = room.players.length === 2;
  const bothReady = bothPresent && room.players.every((player) => player.ready);
  const bothConnected = bothPresent && room.players.every((player) => player.connected);

  el.lobbyCode.textContent = room.code;
  el.inviteLink.value = inviteUrl(room.code);
  el.lobbyLead.textContent = bothPresent
    ? 'Both players are here. Set the round length, then mark ready.'
    : 'Waiting for a second player to join with the invitation link.';

  buildDurationOptions();
  for (const input of el.durationOptions.querySelectorAll('input')) {
    input.checked = Number(input.value) === room.durationSeconds;
    input.disabled = !isHost;
  }
  el.durationHint.textContent = isHost
    ? 'You are the host, so you choose the round length.'
    : 'The host chooses the round length.';

  el.lobbyPlayers.innerHTML = '';
  for (let index = 0; index < 2; index += 1) {
    const player = room.players[index];
    const card = document.createElement('article');
    card.className = 'player-card';
    if (!player) {
      card.dataset.empty = 'true';
      const text = document.createElement('div');
      const title = document.createElement('p');
      title.className = 'player-name';
      title.textContent = 'Waiting for opponent';
      const meta = document.createElement('p');
      meta.className = 'player-meta';
      const tag = document.createElement('span');
      tag.className = 'tag tag-waiting';
      tag.textContent = 'Empty seat';
      meta.appendChild(tag);
      text.append(title, meta);
      card.appendChild(text);
    } else {
      const text = document.createElement('div');
      const title = document.createElement('p');
      title.className = 'player-name';
      title.textContent = player.name;
      const meta = document.createElement('p');
      meta.className = 'player-meta';
      const hostTag = document.createElement('span');
      hostTag.className = 'tag';
      hostTag.textContent = player.isHost ? 'Host' : 'Guest';
      meta.appendChild(hostTag);
      if (player.id === state.playerId) {
        const youTag = document.createElement('span');
        youTag.className = 'tag';
        youTag.textContent = 'You';
        meta.appendChild(youTag);
      }
      const stateTag = document.createElement('span');
      stateTag.className = 'tag';
      if (!player.connected) {
        stateTag.classList.add('tag-waiting');
        stateTag.textContent = 'Reconnecting';
      } else if (player.ready) {
        stateTag.classList.add('tag-ready');
        stateTag.textContent = 'Ready';
      } else {
        stateTag.classList.add('tag-waiting');
        stateTag.textContent = 'Not ready';
      }
      meta.appendChild(stateTag);
      text.append(title, meta);
      card.appendChild(text);
    }
    el.lobbyPlayers.appendChild(card);
  }

  const ready = Boolean(me?.ready);
  el.readyToggle.textContent = ready ? 'Cancel ready' : 'I am ready';
  el.readyToggle.setAttribute('aria-pressed', String(ready));
  el.readyToggle.disabled = !me || !me.connected;
  el.startMatch.hidden = !isHost;
  el.startMatch.disabled = !(isHost && bothPresent && bothReady && bothConnected);
  if (!bothPresent) {
    el.startHint.textContent = 'The host can start once a second player joins and both players are ready.';
  } else if (!bothReady) {
    el.startHint.textContent = 'Both players must mark ready before the host can start.';
  } else if (!bothConnected) {
    el.startHint.textContent = 'Waiting for the other player to come back online.';
  } else if (!isHost) {
    el.startHint.textContent = 'Both players are ready. The host can start the match.';
  } else {
    el.startHint.textContent = 'Both players are ready. Start when you are set.';
  }
  updateUnloadGuard();
}

el.readyToggle?.addEventListener('click', async () => {
  if (!state.inRoom) return;
  const me = myPlayer();
  el.readyToggle.disabled = true;
  const res = await state.socket.request('room:ready', { ready: !me?.ready });
  if (!res.ok) {
    setError(el.homeError, res.message);
    announce(res.message);
  } else if (res.state) {
    state.room = res.state;
    state.you = myPlayer();
    renderLobby();
  }
  el.readyToggle.disabled = false;
});

el.startMatch?.addEventListener('click', async () => {
  if (!state.inRoom) return;
  el.startMatch.disabled = true;
  const res = await state.socket.request('room:start');
  if (!res.ok) {
    announce(res.message);
    el.startHint.textContent = res.message;
    el.startMatch.disabled = false;
    return;
  }
  if (res.state) {
    state.room = res.state;
    state.you = myPlayer();
    prepareArena({ reset: true });
    showScreen('arena');
    updateTimerDisplay();
  }
});

el.copyInvite?.addEventListener('click', async () => {
  if (!state.room) return;
  const ok = await copyText(inviteUrl(state.room.code), el.inviteLink);
  el.copyStatus.textContent = ok
    ? 'Invitation link copied. Send it to your opponent.'
    : 'Copy failed. Select the link above and copy it manually.';
  announce(el.copyStatus.textContent);
});

/* --------------------------------- arena --------------------------------- */

function prepareArena({ reset = false } = {}) {
  const room = state.room;
  if (!room) return;
  if (reset) {
    state.feed = [];
    el.feed.innerHTML = '';
    el.stageEmpty.hidden = false;
    el.stageImage.hidden = true;
    el.stageImage.removeAttribute('src');
    el.stageWho.hidden = true;
    state.resultHandledKey = null;
    if (state.clockCalibratedForRound !== room.roundNumber) calibrateClock();
    pickTray();
  } else if (!state.tray.length) {
    pickTray();
  }
  renderScores();
  renderArenaNames();
}

function renderArenaNames() {
  const room = state.room;
  if (!room) return;
  const me = myPlayer();
  const them = opponentOfMe();
  el.youName.textContent = me?.name || 'You';
  el.themName.textContent = them?.name || 'Waiting';
}

function renderArena() {
  const room = state.room;
  if (!room) return;
  renderScores();
  renderArenaNames();
  renderTray();
  updateTimerDisplay();
  updateSendState();
}

function renderScores() {
  const me = myPlayer();
  const them = opponentOfMe();
  el.youScore.textContent = String(me?.score ?? 0);
  el.themScore.textContent = String(them?.score ?? 0);
  const meName = me?.name || 'You';
  const themName = them?.name || 'Opponent';
  el.youName.textContent = meName;
  el.themName.textContent = themName;
}

function maybeAnnounceScore() {
  if (state.room?.phase !== 'PLAYING') return;
  const now = Date.now();
  if (now - state.lastScoreAnnounceAt < 6000) return;
  const me = myPlayer();
  const them = opponentOfMe();
  if (!me || !them) return;
  const text = `You ${me.score}, ${them.name} ${them.score}.`;
  if (text === state.lastAnnouncedScore) return;
  state.lastAnnouncedScore = text;
  state.lastScoreAnnounceAt = now;
  el.liveScore.textContent = text;
}

function pickRandomSticker(exclude) {
  const pool = state.catalog.filter(
    (sticker) =>
      !exclude.has(sticker.id) &&
      !state.broken.has(sticker.id) &&
      !state.recentIds.includes(sticker.id),
  );
  const fallback = state.catalog.filter(
    (sticker) => !exclude.has(sticker.id) && !state.broken.has(sticker.id),
  );
  const source = pool.length ? pool : fallback;
  if (!source.length) return null;
  return source[Math.floor(Math.random() * source.length)];
}

function pickTray() {
  const traySize = Math.min(6, state.catalog.length);
  const picked = [];
  const chosen = new Set();
  while (picked.length < traySize) {
    const sticker = pickRandomSticker(chosen);
    if (!sticker) break;
    picked.push(sticker);
    chosen.add(sticker.id);
  }
  state.tray = picked;
  state.selectedId = picked[0]?.id || null;
  state.recentIds = [...state.recentIds, ...picked.map((s) => s.id)].slice(-8);
  renderTray();
  preload(picked.map((s) => s.src));
  if (!picked.length) {
    el.tray.innerHTML = '';
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'No stickers are available right now.';
    el.tray.appendChild(note);
  }
}

function renderTray() {
  if (!el.tray) return;
  el.tray.innerHTML = '';
  state.tray.forEach((sticker, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sticker-option';
    button.dataset.stickerId = sticker.id;
    button.setAttribute('aria-pressed', String(sticker.id === state.selectedId));
    button.setAttribute('aria-label', `Sticker ${index + 1}: ${sticker.alt || 'Reaction'}`);
    button.addEventListener('click', () => selectSticker(sticker.id));

    const img = document.createElement('img');
    img.src = sticker.src;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => handleBrokenSticker(sticker.id));
    button.appendChild(img);
    el.tray.appendChild(button);
  });
}

function selectSticker(id) {
  state.selectedId = id;
  for (const button of el.tray.querySelectorAll('.sticker-option')) {
    button.setAttribute('aria-pressed', String(button.dataset.stickerId === id));
  }
  updateSendState();
}

function handleBrokenSticker(id) {
  if (state.broken.has(id)) return;
  state.broken.add(id);
  state.tray = state.tray.filter((sticker) => sticker.id !== id);
  if (state.selectedId === id) {
    const replacement = pickRandomSticker(new Set(state.tray.map((s) => s.id)));
    if (replacement) state.tray.push(replacement);
    state.selectedId = state.tray[0]?.id || null;
  }
  renderTray();
  announce('One sticker could not load, so another was chosen.');
}

function rotateTraySlot(sentId) {
  if (clearTimeout) clearTimeout(state.rotateHandle);
  state.rotateHandle = setTimeout(() => {
    const index = state.tray.findIndex((sticker) => sticker.id === sentId);
    if (index === -1 || state.screen !== 'arena') return;
    const replacement = pickRandomSticker(new Set(state.tray.map((s) => s.id)));
    if (!replacement) return;
    state.tray[index] = replacement;
    state.recentIds = [...state.recentIds, replacement.id].slice(-8);
    preload([replacement.src]);
    if (state.selectedId === sentId) state.selectedId = replacement.id;
    renderTray();
  }, 700);
}

function clearTrayRotation() {
  if (state.rotateHandle) {
    clearTimeout(state.rotateHandle);
    state.rotateHandle = null;
  }
}

function preload(sources) {
  for (const src of sources) {
    try {
      const image = new Image();
      image.decoding = 'async';
      image.src = src;
      state.preloaded = state.preloaded || new Set();
      state.preloaded.add(image);
      if (state.preloaded.size > 30) {
        const first = state.preloaded.values().next().value;
        state.preloaded.delete(first);
      }
    } catch {
      /* ignore */
    }
  }
}

function showStage(stickerId, attribution) {
  const sticker = state.stickerById.get(stickerId);
  if (!sticker) return;
  el.stageEmpty.hidden = true;
  el.stageImage.hidden = false;
  el.stageImage.src = sticker.src;
  el.stageImage.alt = sticker.alt || 'Sticker';
  el.stageWho.hidden = false;
  el.stageWho.textContent = attribution;
  el.stageFrame.dataset.flash = 'true';
  setTimeout(() => {
    el.stageFrame.dataset.flash = 'false';
  }, 160);
}

function pushFeed(playerId, stickerId) {
  const sticker = state.stickerById.get(stickerId);
  if (!sticker) return;
  state.feed.unshift({ playerId, sticker });
  state.feed = state.feed.slice(0, 6);
  el.feed.innerHTML = '';
  for (const item of state.feed) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = item.sticker.src;
    img.alt = '';
    img.loading = 'lazy';
    img.width = 28;
    img.height = 28;
    img.addEventListener('error', (event) => event.target.remove());
    const label = document.createElement('span');
    label.textContent = playerName(item.playerId);
    li.append(img, label);
    el.feed.appendChild(li);
  }
}

function roundIsLive() {
  const room = state.room;
  if (!room || room.phase !== 'PLAYING' || !room.endsAt) return false;
  return state.clock.now() < room.endsAt;
}

function updateSendState() {
  const canSend = Boolean(
    state.socket?.connected && roundIsLive() && state.selectedId && state.inRoom,
  );
  el.sendBtn.disabled = !canSend;
  if (!state.inRoom) return;

  if (state.sendNotice && state.sendNotice.until > Date.now()) {
    el.sendBtn.dataset.busy = 'false';
    el.sendMeta.textContent = state.sendNotice.text;
    return;
  }

  if (state.pending > 0) {
    el.sendBtn.dataset.busy = 'true';
    el.sendMeta.textContent = `${state.pending} on the way`;
  } else if (state.room?.phase === 'COUNTDOWN') {
    el.sendBtn.dataset.busy = 'false';
    el.sendMeta.textContent = 'Unlocks when the clock starts';
  } else if (!state.connected) {
    el.sendBtn.dataset.busy = 'false';
    el.sendMeta.textContent = 'Reconnecting';
  } else if (state.room?.phase === 'PLAYING' && !roundIsLive()) {
    el.sendBtn.dataset.busy = 'false';
    el.sendMeta.textContent = 'Time is up';
  } else {
    el.sendBtn.dataset.busy = 'false';
    el.sendMeta.textContent = 'Tap again and again. Hold to repeat.';
  }
}

async function sendSticker() {
  if (!roundIsLive() || !state.selectedId || !state.socket?.connected) return;
  const stickerId = state.selectedId;
  const eventId = makeEventId();

  state.pending += 1;
  updateSendState();
  showStage(stickerId, 'You sent');
  rotateTraySlot(stickerId);

  const res = await state.socket.request('sticker:send', { stickerId, eventId }, 5000);
  state.pending = Math.max(0, state.pending - 1);

  if (!res.ok) {
    if (res.code === 'RATE_LIMITED') {
      state.sendNotice = { text: 'Too fast. Ease off a little.', until: Date.now() + 1600 };
      el.sendMeta.textContent = state.sendNotice.text;
      announce('Your sends are arriving faster than the server accepts.');
    } else if (res.code === 'ROUND_OVER' || res.code === 'NOT_STARTED' || res.code === 'INVALID_PHASE') {
      announce(res.message);
      requestStateIfStuck();
    } else if (res.code !== 'OFFLINE' && res.code !== 'TIMEOUT') {
      announce(res.message);
    }
  } else if (typeof res.score === 'number') {
    const me = myPlayer();
    if (me) me.score = res.score;
    renderScores();
    maybeAnnounceScore();
  }
  updateSendState();
}

function requestStateIfStuck() {
  if (state.finalizeFallback) return;
  state.finalizeFallback = setTimeout(async () => {
    state.finalizeFallback = null;
    if (!state.inRoom || !state.socket?.connected) return;
    const res = await state.socket.request('state:request');
    if (res.ok && res.state) applyPublicState(res.state);
  }, 2500);
}

function startTimerLoop() {
  stopTimerLoop();
  state.timerHandle = setInterval(updateTimerDisplay, 200);
  updateTimerDisplay();
}

function stopTimerLoop() {
  if (state.timerHandle) {
    clearInterval(state.timerHandle);
    state.timerHandle = null;
  }
}

function updateTimerDisplay() {
  const room = state.room;
  if (!room || !state.inRoom) return;
  const now = state.clock.now();
  const total = (room.durationSeconds || 60) * 1000;

  if (room.phase === 'COUNTDOWN' && room.startsAt) {
    const remaining = room.startsAt - now;
    el.timerLabel.textContent = 'Starts in';
    el.timer.textContent = String(Math.max(1, Math.ceil(remaining / 1000)));
    el.timer.dataset.urgent = 'false';
    el.timerFill.style.width = '100%';
    el.arenaStatus.textContent = 'Get ready. Sending unlocks when the server clock starts.';
  } else if (room.phase === 'PLAYING' && room.endsAt) {
    const remaining = Math.max(0, room.endsAt - now);
    el.timerLabel.textContent = remaining > 0 ? 'Time left' : 'Time is up';
    el.timer.textContent = formatSeconds(remaining);
    el.timer.dataset.urgent = remaining <= 10000 ? 'true' : 'false';
    el.timerFill.style.width = `${Math.min(100, (remaining / total) * 100)}%`;
    if (remaining > 0) {
      el.arenaStatus.textContent = 'Round live. Every accepted sticker is one point.';
    } else {
      el.arenaStatus.textContent = 'Time is up. Waiting for the official result.';
      requestStateIfStuck();
    }
  } else if (room.phase === 'FINISHED') {
    el.timerLabel.textContent = 'Round over';
    el.timer.textContent = '0:00';
    el.timerFill.style.width = '0%';
    el.arenaStatus.textContent = 'Round complete.';
  }
  updateSendState();
}

async function calibrateClock() {
  if (!state.socket?.connected) return;
  for (let i = 0; i < 3; i += 1) {
    const sample = await state.socket.timeSync();
    if (sample) state.clock.addRoundTrip(sample.serverNow, sample.sentAt, sample.receivedAt);
  }
  updateTimerDisplay();
}

/* Sending controls: tap to send, hold to repeat at the server rate. */
function holdIntervalMs() {
  const rate = Math.min(state.config?.sendPerSecond || 8, 8);
  return Math.max(1000 / rate, 110);
}

function stopHold() {
  if (state.holdHandle) {
    clearInterval(state.holdHandle);
    state.holdHandle = null;
  }
}

el.sendBtn?.addEventListener('click', () => {
  if (state.holdRepeated) {
    state.holdRepeated = false;
    return;
  }
  sendSticker();
});

el.sendBtn?.addEventListener('pointerdown', (event) => {
  if (event.button !== undefined && event.button !== 0) return;
  if (el.sendBtn.disabled) return;
  state.holdRepeated = false;
  stopHold();
  state.holdDelay = setTimeout(() => {
    state.holdHandle = setInterval(() => {
      state.holdRepeated = true;
      sendSticker();
    }, holdIntervalMs());
  }, 320);
});

function endHold() {
  clearTimeout(state.holdDelay);
  state.holdDelay = null;
  stopHold();
}

el.sendBtn?.addEventListener('pointerup', endHold);
el.sendBtn?.addEventListener('pointercancel', endHold);
el.sendBtn?.addEventListener('pointerleave', endHold);
el.sendBtn?.addEventListener('blur', endHold);
window.addEventListener('blur', endHold);

document.addEventListener('keydown', (event) => {
  if (state.screen !== 'arena') return;
  if (event.target instanceof HTMLElement) {
    const tag = event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target.isContentEditable) return;
  }
  const index = Number.parseInt(event.key, 10);
  if (Number.isInteger(index) && index >= 1 && index <= state.tray.length) {
    selectSticker(state.tray[index - 1].id);
  }
});

/* -------------------------------- results -------------------------------- */

function showResults() {
  const room = state.room;
  if (!room || !room.result) return;
  const result = room.result;
  const youRow = result.scores.find((row) => row.playerId === state.playerId);
  const themRow = result.scores.find((row) => row.playerId !== state.playerId);

  el.resultsEyebrow.textContent = `Round ${result.roundNumber} complete, ${result.durationSeconds} seconds`;
  el.resultScores.innerHTML = '';

  const buildSide = (row, isYou) => {
    const side = document.createElement('div');
    side.className = 'result-side';
    side.dataset.you = String(isYou);
    const isWinner = !result.draw && row && row.playerId === result.winnerId;
    side.dataset.winner = String(Boolean(isWinner));
    const name = document.createElement('p');
    name.className = 'result-name';
    name.textContent = `${isYou ? 'You' : 'Opponent'}: ${row?.name || 'Player'}`;
    const score = document.createElement('p');
    score.className = 'result-score';
    score.textContent = String(row?.score ?? 0);
    side.append(name, score);
    return side;
  };

  const versus = document.createElement('p');
  versus.className = 'result-versus';
  versus.textContent = 'to';

  el.resultScores.append(buildSide(youRow, true), versus, buildSide(themRow, false));

  if (result.draw) {
    el.resultsTitle.textContent = 'Draw';
    el.resultsVerdict.textContent = 'Both players landed the same number of stickers.';
    el.resultMargin.textContent = `Shared score: ${youRow?.score ?? 0} stickers each.`;
  } else if (result.winnerId === state.playerId) {
    el.resultsTitle.textContent = 'You win';
    el.resultsVerdict.textContent = 'More accepted stickers than your opponent when the clock stopped.';
    el.resultMargin.textContent = `${result.scoreDifference} sticker margin.`;
  } else {
    el.resultsTitle.textContent = 'You lose';
    el.resultsVerdict.textContent = `${themRow?.name || 'Your opponent'} landed more accepted stickers before time ran out.`;
    el.resultMargin.textContent = `${result.scoreDifference} sticker margin.`;
  }

  const outcome = result.draw
    ? 'Draw'
    : result.winnerId === state.playerId
      ? 'You win'
      : 'You lose';
  el.resultLive.textContent = `${outcome}. You ${youRow?.score ?? 0}, ${themRow?.name || 'opponent'} ${themRow?.score ?? 0}.`;

  handlePersonalBest(result, youRow, themRow);
  renderRematchStatus();
  setError(el.resultError, '');
  showScreen('results');
}

function handlePersonalBest(result, youRow, themRow) {
  const key = `${state.room?.roomId}:${result.roundNumber}:${result.finishedAt}`;
  if (state.resultHandledKey === key) return;
  state.resultHandledKey = key;
  if (!youRow || !themRow) return;

  const outcome = saveIfBetter({
    score: youRow.score,
    opponentName: themRow.name,
    roundDurationSeconds: result.durationSeconds,
  });

  if (!outcome.available) {
    el.bestBanner.hidden = false;
    el.bestBannerValue.textContent = 'This browser blocked local storage, so the record was not saved.';
  } else if (outcome.saved) {
    el.bestBanner.hidden = false;
    el.bestBannerValue.textContent = outcome.firstRecord
      ? `First record saved: ${outcome.record.bestScore} stickers against ${outcome.record.opponentName}.`
      : `New personal best: ${outcome.record.bestScore} stickers against ${outcome.record.opponentName}.`;
  } else {
    el.bestBanner.hidden = true;
    el.bestBannerValue.textContent = '';
  }
  refreshRecordUI();
}

function renderRematchStatus() {
  const room = state.room;
  if (!room) return;
  const requested = room.rematch?.requestedBy || [];
  const mine = requested.includes(state.playerId);
  const theirs = requested.some((id) => id !== state.playerId);
  if (mine && !theirs) {
    el.rematchStatus.textContent = 'Rematch requested. Waiting for your opponent.';
  } else if (theirs && !mine) {
    el.rematchStatus.textContent = 'Your opponent wants a rematch. Accept to play again.';
  } else {
    el.rematchStatus.textContent = 'Both players keep their scores until a new round starts.';
  }
  el.rematch.disabled = mine;
  el.rematch.textContent = mine ? 'Rematch requested' : 'Rematch';
}

el.rematch?.addEventListener('click', async () => {
  if (!state.inRoom) return;
  el.rematch.disabled = true;
  const res = await state.socket.request('match:rematch');
  if (!res.ok) {
    setError(el.resultError, res.message);
    el.rematch.disabled = false;
    return;
  }
  if (res.state) {
    state.room = res.state;
    state.you = myPlayer();
    renderRematchStatus();
    if (['WAITING', 'READY'].includes(res.state.phase)) {
      prepareArena({ reset: true });
      renderLobby();
      showScreen('lobby');
    }
  }
});

el.resultHome?.addEventListener('click', async () => {
  await leaveCurrentRoom({ confirm: false });
  showHome();
});

el.resultCopy?.addEventListener('click', async () => {
  const confirmed = await confirmAction({
    title: 'Start a new match',
    body: 'This leaves the finished room and creates a fresh room code for another match. Your current result stays visible until you leave.',
    confirmLabel: 'Create new room',
  });
  if (!confirmed) return;
  const ok = await startFreshRoom();
  if (!ok) return;
  const copied = await copyText(inviteUrl(state.room.code), el.inviteLink);
  el.copyStatus.textContent = copied
    ? 'New room created and invitation link copied. Send it to your opponent.'
    : 'New room created. Select the invitation link in the lobby to copy it.';
  announce(el.copyStatus.textContent);
});

async function startFreshRoom() {
  const name = state.you?.name || el.nameInput.value;
  setError(el.resultError, '');
  try {
    await state.socket.request('room:leave');
  } catch {
    /* ignore */
  }
  clearSession();
  const res = await state.socket.request('room:create', { name });
  if (!res.ok) {
    setError(el.resultError, res.message);
    showHome(res.message);
    return false;
  }
  acceptSession(res, name);
  return true;
}

/* ------------------------------ leave / join ---------------------------- */

async function leaveCurrentRoom({ confirm = true } = {}) {
  if (!state.inRoom || !state.socket) return true;
  const playing = ['COUNTDOWN', 'PLAYING'].includes(state.room?.phase);
  if (confirm) {
    const ok = await confirmAction({
      title: playing ? 'Leave the match' : 'Leave the room',
      body: playing
        ? 'Your opponent keeps the score you have already sent, and the round will finish without you. You can rejoin only with the same link before it expires.'
        : 'The invitation link will stop working for you. You can join again with the same code if the room is still open.',
      confirmLabel: 'Leave',
    });
    if (!ok) return false;
  }
  try {
    await state.socket.request('room:leave');
  } catch {
    /* ignore */
  }
  clearSession();
  el.feed.innerHTML = '';
  el.tray.innerHTML = '';
  el.stageImage.hidden = true;
  el.stageImage.removeAttribute('src');
  el.stageWho.hidden = true;
  el.stageEmpty.hidden = false;
  state.tray = [];
  state.feed = [];
  state.selectedId = null;
  state.pending = 0;
  state.resultHandledKey = null;
  updateUnloadGuard();
  return true;
}

function acceptSession(res, name) {
  state.token = res.token;
  state.playerId = res.playerId;
  state.inRoom = true;
  state.room = res.state;
  state.you = res.state.you;
  saveSession({ code: res.state.code, token: res.token, playerId: res.playerId });
  if (name) saveName(name);
  state.clock.noteServerNow(res.state.serverNow);
  calibrateClock();
  applyPhase({ fromResume: true });
}

async function waitForConnection(timeoutMs = 6000) {
  const socket = state.socket;
  if (!socket) return false;
  if (socket.connected) return true;
  socket.connect();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.socket.off('connect', onConnect);
      resolve(false);
    }, timeoutMs);
    function onConnect() {
      clearTimeout(timer);
      socket.socket.off('connect', onConnect);
      resolve(true);
    }
    socket.socket.on('connect', onConnect);
  });
}

function getValidName() {
  const result = validateNameClient(el.nameInput.value);
  if (!result.ok) {
    setError(el.nameError, result.message);
    el.nameInput.focus();
    return null;
  }
  setError(el.nameError, '');
  el.nameInput.value = result.name;
  return result.name;
}

async function handleCreateRoom() {
  setError(el.homeError, '');
  setError(el.codeError, '');
  const name = getValidName();
  if (!name) return;
  ensureSocket();
  el.createRoom.disabled = true;
  el.createRoom.textContent = 'Creating room';
  const connected = await waitForConnection();
  if (!connected) {
    el.createRoom.disabled = false;
    el.createRoom.textContent = 'Create room';
    setError(el.homeError, 'Cannot reach the game server. Check your connection and try again.');
    return;
  }
  const res = await state.socket.request('room:create', { name });
  el.createRoom.disabled = false;
  el.createRoom.textContent = 'Create room';
  if (!res.ok) {
    setError(el.homeError, res.message || 'The room could not be created.');
    announce(res.message || 'The room could not be created.');
    return;
  }
  acceptSession(res, name);
  el.copyStatus.textContent = '';
}

async function handleJoinRoom() {
  setError(el.homeError, '');
  setError(el.codeError, '');
  const name = getValidName();
  if (!name) return;
  const code = normalizeCode(el.codeInput.value);
  el.codeInput.value = code;
  if (code.length !== 6) {
    setError(el.codeError, 'Room codes are six characters, for example K4M9PX.');
    el.codeInput.focus();
    return;
  }
  ensureSocket();
  el.joinRoom.disabled = true;
  el.joinRoom.textContent = 'Joining room';
  const connected = await waitForConnection();
  if (!connected) {
    el.joinRoom.disabled = false;
    el.joinRoom.textContent = 'Join room';
    setError(el.homeError, 'Cannot reach the game server. Check your connection and try again.');
    return;
  }
  const res = await state.socket.request('room:join', { code, name });
  el.joinRoom.disabled = false;
  el.joinRoom.textContent = 'Join room';
  if (!res.ok) {
    const message = res.code === 'ROOM_NOT_FOUND'
      ? 'No live room matches that code. Check the code and try again.'
      : res.message || 'That room cannot be joined.';
    setError(el.homeError, message);
    announce(message);
    return;
  }
  acceptSession(res, name);
}

el.homeForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  const submitter = event.submitter;
  if (submitter && submitter.id === 'join-room') handleJoinRoom();
  else handleCreateRoom();
});

el.nameInput?.addEventListener('input', () => {
  if (!el.nameError.hidden) setError(el.nameError, '');
});

el.codeInput?.addEventListener('input', () => {
  el.codeInput.value = normalizeCode(el.codeInput.value);
  if (!el.codeError.hidden) setError(el.codeError, '');
});

el.codeInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    handleJoinRoom();
  }
});

el.lobbyLeave?.addEventListener('click', async () => {
  const ok = await leaveCurrentRoom({ confirm: true });
  if (ok) showHome();
});

el.arenaLeave?.addEventListener('click', async () => {
  const ok = await leaveCurrentRoom({ confirm: true });
  if (ok) showHome('You left the match.');
});

window.addEventListener('hashchange', () => {
  const parsed = parseHash();
  if (parsed.view === 'records') {
    if (state.screen !== 'records') showRecords();
    return;
  }
  if (parsed.view === 'room') {
    if (state.inRoom && state.room?.code === parsed.roomCode) return;
    el.codeInput.value = parsed.roomCode;
    if (!state.inRoom) {
      showHome();
      announce(`Room code ${parsed.roomCode} loaded. Enter your name to join.`);
      el.codeInput.focus();
    }
    return;
  }
  if (!state.inRoom && state.screen !== 'home') showHome();
});

function parseHash() {
  const raw = location.hash.replace(/^#/, '');
  if (raw.startsWith('/room/')) {
    const code = normalizeCode(raw.slice('/room/'.length));
    if (code.length === 6) return { view: 'room', roomCode: code };
  }
  if (raw === '/records') return { view: 'records' };
  return { view: 'home' };
}

document.querySelector('.brand')?.addEventListener('click', async (event) => {
  if (!state.inRoom) return;
  event.preventDefault();
  const playing = ['COUNTDOWN', 'PLAYING'].includes(state.room?.phase);
  if (playing) {
    const ok = await leaveCurrentRoom({ confirm: true });
    if (ok) showHome();
    return;
  }
  if (state.room?.phase === 'FINISHED') {
    const ok = await leaveCurrentRoom({ confirm: false });
    if (ok) showHome();
    return;
  }
  const ok = await leaveCurrentRoom({ confirm: true });
  if (ok) showHome();
});

document.querySelectorAll('.quiet-link').forEach((link) => {
  link.addEventListener('click', (event) => {
    if (!state.inRoom) return;
    event.preventDefault();
    announce('Leave the room first to see records without losing your seat.');
  });
});

/* ---------------------------------- boot -------------------------------- */

async function loadConfig() {
  try {
    const response = await fetch('/api/config', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('config');
    state.config = await response.json();
    if (state.config.sendPerSecond) {
      el.rateFact.textContent = `Up to ${state.config.sendPerSecond} per second`;
    }
    if (state.config.maxNameLength) el.nameInput.maxLength = state.config.maxNameLength;
  } catch {
    state.config = {
      durations: [30, 60, 90],
      sendPerSecond: 10,
      maxNameLength: 16,
    };
  }
}

async function loadCatalog() {
  try {
    const response = await fetch('/api/stickers', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('catalog');
    const payload = await response.json();
    state.catalog = Array.isArray(payload.stickers) ? payload.stickers : [];
    state.stickerById = new Map(state.catalog.map((sticker) => [sticker.id, sticker]));
    preload(state.catalog.slice(0, 6).map((sticker) => sticker.src));
  } catch {
    state.catalog = [];
    state.stickerById = new Map();
  }
}

async function boot() {
  refreshRecordUI();
  renderRecords();

  const storedName = readStoredName();
  if (storedName) {
    const check = validateNameClient(storedName);
    if (check.ok) el.nameInput.value = check.name;
  }

  await Promise.all([loadConfig(), loadCatalog()]);
  buildDurationOptions();
  refreshRecordUI();

  const parsed = parseHash();
  if (parsed.view === 'records') {
    showRecords();
  } else {
    showHome();
    if (parsed.view === 'room') {
      el.codeInput.value = parsed.roomCode;
      announce(`Room code ${parsed.roomCode} loaded. Enter your name to join.`);
    }
  }

  if (!state.catalog.length) {
    setError(
      el.homeError,
      'No stickers are available on this deployment, so matches cannot start. Add sticker files or configure a manifest.',
    );
  }

  let session = loadSession();
  if (session && parsed.view === 'room' && parsed.roomCode !== session.code) {
    // An invitation to a different room wins over the stored session.
    clearSession();
    session = null;
  }

  ensureSocket();
  if (session) {
    state.session = session;
    await new Promise((resolve) => {
      if (state.socket.connected) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 4000);
      state.socket.socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      state.socket.connect();
    });
    if (state.socket.connected) await resumeSession();
  }

  handleConnectionChange(state.socket.connected ? 'connected' : 'connecting');
  window.addEventListener('online', () => {
    state.socket?.connect();
  });
  window.addEventListener('offline', () => handleConnectionChange('offline'));
}

boot().catch((error) => {
  ensureSocket();
  setError(el.homeError, 'The game could not start. Reload the page to try again.');
  console.error('Boot failed', error?.name || 'Error');
});
