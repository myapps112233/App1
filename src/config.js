'use strict';

/**
 * Central configuration. Everything tunable lives here so that behaviour can be
 * verified in tests and documented in the README without hunting through code.
 */

const ALLOWED_DURATIONS = Object.freeze([30, 60, 90]);

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeOrigin(origin) {
  if (!origin) return '';
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

/**
 * @param {Record<string, string | undefined>} env
 */
function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV === 'production' ? 'production' : 'development';
  const isProduction = nodeEnv === 'production';

  return Object.freeze({
    nodeEnv,
    isProduction,
    host: env.HOST || '0.0.0.0',
    port: parseInteger(env.PORT, 3000, { min: 1, max: 65535 }),
    trustProxy: parseInteger(env.TRUST_PROXY, isProduction ? 1 : 0, { min: 0, max: 5 }),

    // Origin handling. Browsers always send an Origin header on the WebSocket
    // handshake, so the same-origin check plus this allowlist is the default.
    allowedOrigins: parseList(env.ALLOWED_ORIGINS).map(normalizeOrigin).filter(Boolean),
    publicOrigin: normalizeOrigin(env.PUBLIC_ORIGIN || ''),
    requireOrigin: parseBool(env.REQUIRE_ORIGIN, false),
    // Development only: hosted preview proxies sometimes rewrite the Host header,
    // which would break the same-origin check. This flag is ignored in production.
    allowAnyOrigin: !isProduction && parseBool(env.DEV_ALLOW_ANY_ORIGIN, false),
    embedOrigins: parseList(env.EMBED_ORIGINS).map(normalizeOrigin).filter(Boolean),

    // Timing
    countdownMs: parseInteger(env.COUNTDOWN_MS, 3200, { min: 1000, max: 10000 }),
    roomIdleTtlMs: parseInteger(env.ROOM_IDLE_TTL_MS, 20 * 60 * 1000, { min: 60_000 }),
    roomFinishedTtlMs: parseInteger(env.ROOM_FINISHED_TTL_MS, 5 * 60 * 1000, { min: 30_000 }),
    tickIntervalMs: parseInteger(env.TICK_INTERVAL_MS, 500, { min: 100, max: 5000 }),
    disconnectGraceMs: parseInteger(env.DISCONNECT_GRACE_MS, 30_000, { min: 5_000 }),

    // Limits
    maxRooms: parseInteger(env.MAX_ROOMS, 500, { min: 10 }),
    maxRoomsPerIp: parseInteger(env.MAX_ROOMS_PER_IP, 15, { min: 1 }),
    maxSocketsPerIp: parseInteger(env.MAX_SOCKETS_PER_IP, 12, { min: 2 }),
    joinAttemptsPerMinute: parseInteger(env.JOIN_ATTEMPTS_PER_MINUTE, 30, { min: 5 }),
    sendBurst: parseInteger(env.SEND_BURST, 14, { min: 3, max: 200 }),
    sendPerSecond: parseFloat(env.SEND_PER_SECOND) > 0 ? Math.min(30, parseFloat(env.SEND_PER_SECOND)) : 10,
    dedupeWindow: parseInteger(env.DEDUPE_WINDOW, 400, { min: 50, max: 5000 }),

    // Sticker catalogue
    stickerManifestUrl: (env.STICKER_MANIFEST_URL || '').trim(),
    stickerAssetBase: (env.STICKER_ASSET_BASE || '').trim().replace(/\/+$/, ''),
    stickerDir: env.STICKER_DIR || '',

    // Legal / contact configuration
    contactEmail: (env.PRIVACY_CONTACT_EMAIL || '').trim(),
    contactUrl: (env.CONTACT_URL || 'https://github.com/myapps112233/App1/issues').trim(),
    operatorName: (env.OPERATOR_NAME || 'the Sticker Showdown maintainers').trim(),
    legalEffectiveDate: (env.LEGAL_EFFECTIVE_DATE || '24 October 2026').trim(),
    repoUrl: (env.REPO_URL || 'https://github.com/myapps112233/App1').trim(),

    allowedDurations: ALLOWED_DURATIONS,
    maxNameLength: 16,
    minNameLength: 2,
  });
}

module.exports = { loadConfig, ALLOWED_DURATIONS, normalizeOrigin };
