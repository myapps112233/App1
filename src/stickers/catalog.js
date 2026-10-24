'use strict';

/**
 * Sticker catalogue.
 *
 * Two supported modes:
 *  1. Local, version-controlled directory (default): public/stickers
 *  2. Remote manifest (STICKER_MANIFEST_URL) plus an optional approved asset base
 *     (STICKER_ASSET_BASE). The remote path never accepts arbitrary hosts.
 *
 * The catalogue is validated once at boot and served to clients from the same
 * origin through /api/stickers.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const ALLOWED_EXTENSIONS = new Set(['.webp', '.png', '.jpg', '.jpeg']);
const MIN_BYTES = 512;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_STICKERS = 500;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function slug(value) {
  return path
    .basename(value, path.extname(value))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function isAllowedRelativePath(src) {
  if (typeof src !== 'string' || !src.startsWith('/') || src.startsWith('//')) return false;
  if (src.includes('..') || src.includes('\\') || /\s/.test(src)) return false;
  return ALLOWED_EXTENSIONS.has(path.extname(src).toLowerCase());
}

function buildRemoteSrc(src, base) {
  if (!base) return src;
  try {
    const baseUrl = new URL(base);
    return new URL(src.replace(/^\/+/, ''), `${baseUrl.origin}${baseUrl.pathname.replace(/\/?$/, '/')}`)
      .href;
  } catch {
    return src;
  }
}

async function loadRemoteCatalog(config, logger) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  timeout.unref?.();
  try {
    const response = await fetch(config.stickerManifestUrl, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`manifest responded ${response.status}`);
    const payload = await response.json();
    const list = Array.isArray(payload?.stickers) ? payload.stickers : [];
    const seen = new Set();
    const stickers = [];

    for (const entry of list.slice(0, MAX_STICKERS)) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) continue;
      if (seen.has(entry.id)) continue;
      const rawSrc = entry.src || entry.file;
      if (!isAllowedRelativePath(rawSrc)) continue;
      const src = config.stickerAssetBase ? buildRemoteSrc(rawSrc, config.stickerAssetBase) : rawSrc;
      const alt =
        typeof entry.alt === 'string' && entry.alt.trim()
          ? entry.alt.trim().slice(0, 120)
          : 'Sticker';
      seen.add(entry.id);
      stickers.push({ id: entry.id, src, alt });
    }

    if (!stickers.length) throw new Error('manifest contained no usable stickers');
    logger.info('sticker_catalog_loaded', { source: 'remote', count: stickers.length });
    return {
      version: Number(payload?.version) || 1,
      source: 'remote',
      stickers,
    };
  } catch (error) {
    logger.warn('sticker_catalog_remote_failed', { error: String(error.message || error) });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadLocalCatalog(config, logger, rootDir) {
  const dir = config.stickerDir
    ? path.resolve(config.stickerDir)
    : path.join(rootDir, 'public', 'stickers');

  let files;
  try {
    files = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    logger.error('sticker_dir_unreadable', { error: String(error.code || error) });
    return { version: 1, source: 'none', stickers: [] };
  }

  let manifestAlt = new Map();
  try {
    const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw);
    for (const entry of parsed?.stickers || []) {
      if (entry && typeof entry.file === 'string' && typeof entry.alt === 'string') {
        manifestAlt.set(entry.file, entry.alt.slice(0, 120));
      }
    }
  } catch {
    // A manifest is optional; the directory itself is the source of truth.
  }

  const stickers = [];
  const usedIds = new Set();
  for (const dirent of files) {
    if (!dirent.isFile()) continue;
    const ext = path.extname(dirent.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) continue;
    if (dirent.name.startsWith('.')) continue;

    const fullPath = path.join(dir, dirent.name);
    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size < MIN_BYTES || stat.size > MAX_BYTES) continue;

    let id = slug(dirent.name);
    if (!ID_PATTERN.test(id)) continue;
    if (usedIds.has(id)) id = `${id}-${stickers.length + 1}`;
    usedIds.add(id);

    stickers.push({
      id,
      src: `/stickers/${encodeURIComponent(dirent.name)}`,
      alt: manifestAlt.get(dirent.name) || 'Reaction sticker',
      bytes: stat.size,
    });
  }

  stickers.sort((a, b) => (a.id < b.id ? -1 : 1));

  if (!stickers.length) {
    logger.warn('sticker_catalog_empty', { dir: path.relative(rootDir, dir) });
  } else {
    logger.info('sticker_catalog_loaded', { source: 'local', count: stickers.length });
  }

  return { version: 1, source: 'local', stickers };
}

async function loadStickerCatalog({ config, logger, rootDir = process.cwd() }) {
  if (config.stickerManifestUrl) {
    const remote = await loadRemoteCatalog(config, logger);
    if (remote) return remote;
  }
  return loadLocalCatalog(config, logger, rootDir);
}

function catalogForClient(catalog) {
  return {
    version: catalog.version,
    source: catalog.source,
    stickers: catalog.stickers.map(({ id, src, alt }) => ({ id, src, alt })),
  };
}

module.exports = {
  loadStickerCatalog,
  catalogForClient,
  ALLOWED_EXTENSIONS,
  isAllowedRelativePath,
  slug,
};
