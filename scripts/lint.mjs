#!/usr/bin/env node
/**
 * Zero dependency syntax check. Runs node --check over every JavaScript file in
 * the project, treating public/js files as ES modules.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['src', 'scripts', 'tests', 'public/js'];
let failures = 0;
let checked = 0;

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) await check(full);
  }
}

async function check(file) {
  const isModule = file.endsWith('.mjs') || file.startsWith('public/js');
  const args = isModule ? ['--input-type=module', '--check'] : ['--check', file];
  const result = isModule
    ? spawnSync(process.execPath, args, {
        input: await readFile(file, 'utf8'),
        encoding: 'utf8',
      })
    : spawnSync(process.execPath, args, { encoding: 'utf8' });

  checked += 1;
  if (result.status !== 0) {
    failures += 1;
    console.error(`FAIL ${file}\n${result.stderr}`);
  }
}

for (const root of roots) await walk(root);

if (failures > 0) {
  console.error(`${failures} file(s) failed, ${checked} checked.`);
  process.exit(1);
}
console.log(`Syntax check passed for ${checked} files.`);
