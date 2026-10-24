'use strict';

const http = require('node:http');
const { Server } = require('socket.io');

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { loadStickerCatalog } = require('./stickers/catalog');
const { createRoomStore } = require('./game/rooms');
const { createApp } = require('./http/app');
const { createSocketServer } = require('./socket');
const { createOriginPolicy } = require('./security/origin');

/**
 * Builds the full application. Returned object is intentionally testable: the
 * caller decides which port to listen on, and close() shuts everything down.
 */
async function createGameServer(options = {}) {
  const config = loadConfig(options.env || process.env);
  const logger = options.logger || createLogger('sticker-showdown', options.logLevel || 'info');
  const catalog = await loadStickerCatalog({
    config,
    logger,
    rootDir: options.rootDir || process.cwd(),
  });
  const stickerIds = new Set(catalog.stickers.map((sticker) => sticker.id));

  const store = createRoomStore({
    config,
    logger,
    stickerIds,
    codeGenerator: options.codeGenerator,
    clock: options.clock,
    useTimers: options.useTimers !== false,
  });

  const { app } = await createApp({ config, catalog, store, logger });
  const httpServer = http.createServer(app);
  const originPolicy = createOriginPolicy(config);

  const io = new Server(httpServer, {
    path: '/socket.io',
    serveClient: true,
    maxHttpBufferSize: 10_000,
    pingInterval: 20_000,
    pingTimeout: 15_000,
    transports: ['websocket', 'polling'],
    perMessageDeflate: {
      threshold: 1024,
      zlibDeflateOptions: { level: 6, memLevel: 7 },
    },
    allowRequest: (req, callback) => {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const origin = req.headers.origin;
      if (!originPolicy.isAllowed(origin, host)) {
        logger.warn('socket_origin_rejected', { origin: origin ? 'present' : 'absent' });
        callback('origin_not_allowed', false);
        return;
      }
      callback(null, true);
    },
  });

  io.engine.on('connection_error', (error) => {
    logger.debug('engine_connection_error', { code: error?.code || 'unknown' });
  });

  const socketLayer = createSocketServer({ io, store, config, logger });

  const tickInterval = setInterval(() => {
    try {
      store.tick();
    } catch (error) {
      logger.error('tick_loop_failed', { error: error?.name || 'Error' });
    }
  }, config.tickIntervalMs);
  tickInterval.unref?.();

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(tickInterval);
    socketLayer.close();
    await new Promise((resolve) => io.close(resolve));
    store.close();
    if (httpServer.listening) {
      await new Promise((resolve) => httpServer.close(resolve));
    }
  }

  return {
    config,
    logger,
    app,
    httpServer,
    io,
    store,
    catalog,
    originPolicy,
    close,
  };
}

function listen(server, { host, port }) {
  return new Promise((resolve, reject) => {
    server.httpServer.once('error', reject);
    server.httpServer.listen(port, host, () => {
      server.httpServer.removeListener('error', reject);
      resolve(server.httpServer.address());
    });
  });
}

module.exports = { createGameServer, listen };
