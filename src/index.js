'use strict';

const { createGameServer, listen } = require('./server');
const { createLogger } = require('./logger');

async function main() {
  const logger = createLogger('sticker-showdown', process.env.LOG_LEVEL || 'info');
  const server = await createGameServer({ logger });
  const { config } = server;

  const address = await listen(server, { host: config.host, port: config.port });
  const shownHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
  logger.info('server_listening', {
    host: config.host,
    port: address.port,
    env: config.nodeEnv,
    stickers: server.catalog.stickers.length,
    url: `http://${shownHost}:${address.port}`,
  });

  if (!server.catalog.stickers.length) {
    logger.warn('no_stickers_available', {
      hint: 'Add .webp/.png/.jpg files to public/stickers or configure STICKER_MANIFEST_URL.',
    });
  }
  if (config.allowAnyOrigin) {
    logger.warn('origin_check_relaxed', {
      hint: 'DEV_ALLOW_ANY_ORIGIN is set. Do not use this in production.',
    });
  }
  if (config.isProduction && !config.allowedOrigins.length && !config.publicOrigin) {
    logger.info('origin_policy_same_origin_only', {
      hint: 'Set ALLOWED_ORIGINS if the game is served from more than one origin.',
    });
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown_started', { signal });
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await server.close();
      logger.info('shutdown_complete');
      process.exit(0);
    } catch (error) {
      logger.error('shutdown_failed', { error: error?.name || 'Error' });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled_rejection', { error: reason instanceof Error ? reason.name : 'unknown' });
  });
  process.on('uncaughtException', (error) => {
    logger.error('uncaught_exception', { error: error?.name || 'Error' });
    shutdown('uncaughtException');
  });
}

main().catch((error) => {
  const logger = createLogger('sticker-showdown', 'error');
  logger.error('startup_failed', { error: error?.message || 'unknown' });
  process.exit(1);
});
