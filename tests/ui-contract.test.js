'use strict';

/**
 * Static contract checks between the HTML shell, the client scripts, the design
 * system and the sticker folder. These catch the kind of breakage that unit tests
 * on the server cannot see: a renamed element id, a missing label, a forbidden
 * visual pattern, or a sticker that no longer exists.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('public/index.html');
const appJs = read('public/js/app.js');
const css = read('public/css/styles.css');

test('every element id referenced by the client exists exactly once', () => {
  const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const duplicates = htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index);
  assert.deepEqual(duplicates, [], 'duplicate ids in index.html');

  const referenced = new Set([...appJs.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]));
  const missing = [...referenced].filter((id) => !htmlIds.includes(id));
  assert.deepEqual(missing, [], 'client references ids that are not in index.html');

  for (const heading of ['home-title', 'lobby-title', 'arena-title', 'results-title', 'records-title']) {
    assert.ok(htmlIds.includes(heading), `${heading} screen heading is missing`);
  }
});

test('every form control has an accessible label', () => {
  const inputs = [...html.matchAll(/<(input|select|textarea)\b[^>]*>/g)].map((match) => match[0]);
  const labelsFor = new Set(
    [...html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((match) => match[1]),
  );
  for (const input of inputs) {
    const id = /id="([^"]+)"/.exec(input)?.[1];
    const hasAria = /aria-label=/.test(input);
    assert.ok((id && labelsFor.has(id)) || hasAria, `unlabelled control: ${input.slice(0, 80)}`);
    assert.ok(!/type="hidden"/.test(input), 'hidden inputs are not used');
  }
});

test('the shell has the structural and accessibility basics', () => {
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /<main id="main"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /id="live-score"/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, 'stylesheet must honour reduced motion');
  const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].filter(
    (match) => match[1].trim().length > 0,
  );
  assert.deepEqual(inlineScripts, [], 'no inline scripts (CSP forbids them)');
  assert.ok(!/\sstyle="/.test(html), 'no inline style attributes');
  assert.match(html, /role="alert"/);
});

test('the interface copy avoids em dashes and emojis', () => {
  const files = ['public/index.html'];
  for (const file of fs.readdirSync(path.join(root, 'public/legal'))) {
    files.push(`public/legal/${file}`);
  }
  files.push('public/js/app.js', 'public/js/legal.js');

  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
  for (const file of files) {
    const text = read(file);
    assert.ok(!text.includes('\u2014'), `${file} contains an em dash`);
    assert.ok(!emoji.test(text), `${file} contains an emoji`);
  }
});

test('the stylesheet follows the visual restrictions', () => {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const banned of ['linear-gradient', 'radial-gradient', 'conic-gradient', 'box-shadow', 'text-shadow']) {
    assert.ok(!withoutComments.includes(banned), `stylesheet must not use ${banned}`);
  }
  for (const font of ['Inter', 'Geist', 'Space Grotesk']) {
    assert.ok(!new RegExp(`font-family:[^;]*${font}`).test(withoutComments), `must not use ${font}`);
  }
  for (const match of withoutComments.matchAll(/border-radius:\s*([^;]+);/g)) {
    assert.equal(match[1].trim(), '0', 'controls stay rectangular');
  }
  assert.ok(
    !/(?:background(?:-color)?|color)\s*:\s*(?:#fff\b|#ffffff\b|white\b|rgba?\(255,\s*255,\s*255)/i.test(
      withoutComments,
    ),
    'no pure white surfaces',
  );
  assert.ok(!/animation:\s*[a-z]/i.test(withoutComments), 'no decorative keyframe animation');
});

test('the installed sticker set matches the manifest and the served catalogue rules', () => {
  const dir = path.join(root, 'public/stickers');
  const files = fs
    .readdirSync(dir)
    .filter((file) => /\.(webp|png|jpe?g)$/i.test(file))
    .sort();
  assert.ok(files.length >= 6, 'expected a usable sticker collection');

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.deepEqual(
    manifest.stickers.map((entry) => entry.file).sort(),
    files,
  );

  for (const file of files) {
    const stats = fs.statSync(path.join(dir, file));
    assert.ok(stats.size >= 512 && stats.size <= 2 * 1024 * 1024, `${file} size is outside limits`);
  }
  assert.ok(fs.existsSync(path.join(dir, 'LICENSE.md')), 'asset licence notice is missing');
});

test('legal pages cover the required topics', () => {
  const privacy = read('public/legal/privacy.html');
  for (const topic of ['retention', 'local storage', 'Render', 'GitHub', 'contact', 'deletion', 'children']) {
    assert.match(privacy, new RegExp(topic, 'i'), `privacy policy should mention ${topic}`);
  }
  const terms = read('public/legal/terms.html');
  for (const topic of ['Acceptable use', 'limitation of liability', 'governed by', 'independent']) {
    assert.match(terms, new RegExp(topic, 'i'), `terms should mention ${topic}`);
  }
  const cookies = read('public/legal/cookies.html');
  assert.match(cookies, /sets no cookies/i);
  assert.match(cookies, /id="legal-clear"/);
  const contact = read('public/legal/contact.html');
  assert.match(contact, /privacy/i);
});

test('the server never exposes development files through the static root', () => {
  const appSource = read('src/http/app.js');
  assert.match(appSource, /express\.static\(publicDir/);
  assert.ok(!appSource.includes("express.static(rootDir"), 'must not serve the repository root');
  assert.match(appSource, /dotfiles: 'ignore'/);
});
