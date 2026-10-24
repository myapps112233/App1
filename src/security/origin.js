'use strict';

/**
 * Origin policy shared by HTTP and the Socket.IO handshake.
 *
 * Requests with no Origin header (curl, health probes, tests) are allowed unless
 * REQUIRE_ORIGIN=true. Browser requests always carry Origin, and those must be
 * either the same host that served the page or an explicitly configured origin.
 */

function hostFromHeader(value) {
  if (!value) return '';
  return String(value).split(',')[0].trim();
}

function createOriginPolicy(config) {
  const allowlist = new Set(config.allowedOrigins);
  if (config.publicOrigin) allowlist.add(config.publicOrigin);

  function isAllowed(origin, requestHost) {
    if (!origin) return !config.requireOrigin;
    if (config.allowAnyOrigin) return true;
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    if (allowlist.has(parsed.origin)) return true;

    const host = hostFromHeader(requestHost);
    if (host && parsed.host === host) return true;

    return false;
  }

  return { isAllowed, allowlist };
}

module.exports = { createOriginPolicy };
