'use strict';

const { io } = require('socket.io-client');
const { createGameServer } = require('../src/server');
const { createLogger } = require('../src/logger');

function createFakeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
    set(value) {
      now = value;
    },
  };
}

const quietLogger = createLogger('test', 'silent');

const BASE_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  ALLOWED_ORIGINS: '',
  PRIVACY_CONTACT_EMAIL: 'privacy@example.test',
  OPERATOR_NAME: 'Test Operator',
  CONTACT_URL: 'https://example.test/contact',
};

async function startServer(envOverrides = {}, options = {}) {
  const clock = options.clock || createFakeClock();
  const server = await createGameServer({
    env: { ...BASE_ENV, ...envOverrides },
    logger: quietLogger,
    clock,
    useTimers: false,
    rootDir: process.cwd(),
    ...options,
  });

  await new Promise((resolve, reject) => {
    server.httpServer.once('error', reject);
    server.httpServer.listen(0, '127.0.0.1', () => {
      server.httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const { port } = server.httpServer.address();
  return {
    server,
    clock,
    store: server.store,
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await server.close();
    },
  };
}

function connect(url, extra = {}) {
  const socket = io(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    timeout: 4000,
    ...extra,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 5000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function request(socket, event, payload = {}, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout for ${event}`)), timeout);
    socket.timeout(timeout).emit(event, payload, (error, response) => {
      clearTimeout(timer);
      if (error) return reject(new Error(`ack error for ${event}`));
      return resolve(response);
    });
  });
}

function once(socket, event, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for ${event}`));
    }, timeout);
    function handler(payload) {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

/**
 * Records every server event a socket receives so tests can wait for a
 * particular broadcast instead of racing the ack.
 */
function track(socket) {
  const log = {
    states: [],
    starts: [],
    ends: [],
    stickers: [],
    scores: [],
    notices: [],
    closed: [],
  };
  socket.on('room:state', (payload) => log.states.push(payload));
  socket.on('match:started', (payload) => log.starts.push(payload));
  socket.on('match:ended', (payload) => log.ends.push(payload));
  socket.on('sticker:event', (payload) => log.stickers.push(payload));
  socket.on('scores', (payload) => log.scores.push(payload));
  socket.on('notice', (payload) => log.notices.push(payload));
  socket.on('room:closed', (payload) => log.closed.push(payload));

  log.waitFor = async (key, matcher, timeout = 4000) => {
    const bucket = log[key];
    if (!Array.isArray(bucket)) throw new Error(`unknown event bucket ${key}`);
    const start = Date.now();
    for (;;) {
      const hit = bucket.find(matcher);
      if (hit) return hit;
      if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${key}`);
      await wait(20);
    }
  };
  log.latestState = () => log.states[log.states.length - 1] || null;
  return log;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createAndJoin(server, url, options = {}) {
  const host = await connect(url);
  const created = await request(host, 'room:create', { name: options.hostName || 'Ada' });
  if (!created.ok) throw new Error(`create failed: ${created.code}`);

  const guest = await connect(url);
  const joined = await request(guest, 'room:join', {
    code: created.state.code,
    name: options.guestName || 'Bo',
  });
  if (!joined.ok) throw new Error(`join failed: ${joined.code}`);

  return {
    host,
    guest,
    code: created.state.code,
    hostToken: created.token,
    guestToken: joined.token,
    hostId: created.playerId,
    guestId: joined.playerId,
  };
}

module.exports = {
  BASE_ENV,
  quietLogger,
  createFakeClock,
  startServer,
  connect,
  request,
  once,
  wait,
  createAndJoin,
  track,
};
