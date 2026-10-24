'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');

const { catalogForClient } = require('../stickers/catalog');
const { loadLegalTemplates, renderLegalPage, PAGES } = require('../legal/pages');

/**
 * Express application. The frontend and the Socket.IO endpoint are served from
 * this same origin, which keeps CORS and WebSocket configuration simple.
 */
async function createApp({ config, catalog, store, logger }) {
  const app = express();
  const rootDir = path.resolve(__dirname, '..', '..');
  const publicDir = path.join(rootDir, 'public');
  const legalTemplates = await loadLegalTemplates(rootDir);
  const socketOrigins = new Set();
  for (const origin of [...config.allowedOrigins, config.publicOrigin].filter(Boolean)) {
    try {
      const url = new URL(origin);
      const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      socketOrigins.add(`${protocol}//${url.host}`);
    } catch {
      /* ignore malformed optional origin */
    }
  }

  const assetOrigins = new Set();
  if (config.stickerAssetBase) {
    try {
      assetOrigins.add(new URL(config.stickerAssetBase).origin);
    } catch {
      /* ignore malformed optional base */
    }
  }

  app.disable('x-powered-by');
  if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);

  const cspDirectives = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    imgSrc: ["'self'", 'data:', ...assetOrigins],
    connectSrc: ["'self'", ...socketOrigins, ...assetOrigins],
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'self'"],
    upgradeInsecureRequests: config.isProduction ? [] : null,
  };

  // The hosted preview renders the app inside a frame, so development keeps
  // framing open. Production defaults to same-origin and can be widened through
  // EMBED_ORIGINS when someone intentionally embeds the game.
  if (!config.isProduction) {
    cspDirectives.frameAncestors = ["'self'", 'https:', 'http:'];
  }
  if (config.embedOrigins && config.embedOrigins.length) {
    cspDirectives.frameAncestors = ["'self'", ...config.embedOrigins];
  }

  app.use(
    helmet({
      contentSecurityPolicy: { directives: cspDirectives },
      frameguard: config.isProduction ? { action: 'sameorigin' } : false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: config.isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '4kb', strict: true }));

  // Coarse HTTP rate limiting for unauthenticated endpoints.
  const httpHits = new Map();
  app.use((req, res, next) => {
    if (req.path.startsWith('/stickers/') || req.path.startsWith('/css/') || req.path.startsWith('/js/')) {
      return next();
    }
    const ip = req.ip || 'unknown';
    const now = Date.now();
    let entry = httpHits.get(ip);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + 60_000 };
      httpHits.set(ip, entry);
    }
    entry.count += 1;
    if (entry.count > 240) {
      return res.status(429).type('text/plain').send('Too many requests. Try again shortly.');
    }
    return next();
  });

  app.get('/healthz', (req, res) => {
    const stats = store.stats();
    res.set('cache-control', 'no-store').json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      rooms: stats.rooms,
      players: stats.players,
      catalog: catalog.stickers.length,
      node: process.version,
    });
  });

  app.get('/api/config', (req, res) => {
    res.set('cache-control', 'no-store').json({
      durations: config.allowedDurations,
      sendPerSecond: config.sendPerSecond,
      sendBurst: config.sendBurst,
      minNameLength: config.minNameLength,
      maxNameLength: config.maxNameLength,
      countdownMs: config.countdownMs,
      disconnectGraceMs: config.disconnectGraceMs,
      contactUrl: config.contactUrl,
      repoUrl: config.repoUrl,
      legalEffectiveDate: config.legalEffectiveDate,
      production: config.isProduction,
    });
  });

  app.get('/api/stickers', (req, res) => {
    res
      .set('cache-control', 'public, max-age=300, stale-while-revalidate=600')
      .json(catalogForClient(catalog));
  });

  for (const page of PAGES) {
    app.get(`/legal/${page}`, (req, res) => {
      const template = legalTemplates.get(page);
      if (!template) return res.status(404).type('text/plain').send('Not found');
      res
        .set('cache-control', 'public, max-age=60')
        .type('html')
        .send(renderLegalPage(template, config));
    });
  }

  app.get('/legal', (req, res) => res.redirect(302, '/legal/privacy'));

  app.use(
    express.static(publicDir, {
      index: false,
      dotfiles: 'ignore',
      setHeaders(res, filePath) {
        const relative = path.relative(publicDir, filePath);
        if (relative.startsWith(`stickers${path.sep}`)) {
          res.setHeader('cache-control', 'public, max-age=604800, immutable');
        } else if (relative.startsWith(`css${path.sep}`) || relative.startsWith(`js${path.sep}`)) {
          res.setHeader('cache-control', 'public, max-age=300, must-revalidate');
        } else if (relative.startsWith(`legal${path.sep}`)) {
          res.setHeader('cache-control', 'public, max-age=60');
        } else {
          res.setHeader('cache-control', 'no-cache');
        }
        res.setHeader('x-content-type-options', 'nosniff');
      },
    }),
  );

  app.get('/', (req, res) => {
    res.set('cache-control', 'no-cache').sendFile(path.join(publicDir, 'index.html'));
  });

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res
      .status(404)
      .type('html')
      .send(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found</title>' +
          '<meta name="viewport" content="width=device-width, initial-scale=1">' +
          '<link rel="stylesheet" href="/css/styles.css"></head><body>' +
          '<main class="shell legal-doc"><h1>Page not found</h1>' +
          '<p>That address does not exist. <a href="/">Return to the game</a>.</p></main></body></html>',
      );
  });

  // Errors are logged with a code only. Clients never see stack traces.
  app.use((err, req, res, next) => {
    const code = err?.type === 'entity.too.large' ? 413 : 500;
    logger.error('http_error', { code, path: req.path, error: err?.name || 'Error' });
    if (res.headersSent) return next(err);
    if (req.path.startsWith('/api/')) {
      return res.status(code).json({ error: code === 413 ? 'payload_too_large' : 'server_error' });
    }
    return res
      .status(code)
      .type('text/plain')
      .send(code === 413 ? 'Payload too large.' : 'Something went wrong. Try again.');
  });

  return { app, legalTemplates };
}

module.exports = { createApp };
