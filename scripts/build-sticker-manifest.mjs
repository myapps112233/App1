#!/usr/bin/env node
/**
 * Rebuilds public/stickers/manifest.json from the files on disk, preserving any
 * alt text already present for a file name.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve('public/stickers');
const allowed = new Set(['.webp', '.png', '.jpg', '.jpeg']);
const manifestPath = path.join(dir, 'manifest.json');

let previous = new Map();
try {
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const entry of parsed.stickers || []) {
    if (entry?.file && entry?.alt) previous.set(entry.file, entry.alt);
  }
} catch {
  previous = new Map();
}

const entries = await readdir(dir, { withFileTypes: true });
const files = entries
  .filter((entry) => entry.isFile() && allowed.has(path.extname(entry.name).toLowerCase()))
  .map((entry) => entry.name)
  .sort();

const stickers = files.map((file, index) => ({
  file,
  alt: previous.get(file) || `Reaction sticker ${index + 1}`,
}));

await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      version: 1,
      note: 'Local sticker catalogue. Edit alt text here; the server reads alt overrides from this file at boot.',
      stickers,
    },
    null,
    2,
  )}\n`,
);

console.log(`Wrote ${stickers.length} stickers to ${path.relative(process.cwd(), manifestPath)}`);
