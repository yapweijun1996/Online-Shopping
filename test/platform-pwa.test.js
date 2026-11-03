import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { shellAssets, shellFingerprint } from './helpers/shell-assets.js';

const file = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(file('platform/manifest.webmanifest'));

test('platform manifest is installable, has its own scope and real icon sizes', () => {
  assert.equal(manifest.id, '/platform/'); assert.equal(manifest.scope, '/platform/'); assert.equal(manifest.start_url, '/platform/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.name && manifest.short_name && manifest.short_name.length <= 12);
  for (const surface of ['shop', 'seller']) assert.notEqual(JSON.parse(file(`${surface}/manifest.webmanifest`)).id, manifest.id);
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ['192x192', '512x512']);
  for (const icon of manifest.icons) {
    const png = readFileSync(new URL(`../public${icon.src}`, import.meta.url)), size = Number.parseInt(icon.sizes, 10);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
  }
});

test('the worker cache version equals the loaded application version', () => {
  const app = file('platform/version.js').match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1], worker = file('platform/sw.js').match(/version:\s*'([^']+)'/)?.[1];
  assert.ok(app && worker); assert.equal(worker, app);
});

test('system chrome: solid status bar, safe-area viewport and one theme colour in HTML, offline page and manifest', () => {
  for (const page of ['platform/index.html', 'platform/offline.html']) {
    const html = file(page);
    assert.match(html, /name="viewport"[^>]*viewport-fit=cover/, `${page} uses the full screen under the notch`);
    const light = html.match(/<meta name="theme-color" content="(#[0-9a-f]{6})" media="\(prefers-color-scheme: light\)">/i)?.[1];
    const dark = html.match(/<meta name="theme-color" content="(#[0-9a-f]{6})" media="\(prefers-color-scheme: dark\)">/i)?.[1];
    assert.ok(light && dark, `${page} has light and dark theme-color`);
    assert.equal(manifest.theme_color, light);
  }
  const html = file('platform/index.html');
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /name="apple-mobile-web-app-status-bar-style" content="default"/, 'a solid status bar, never black-translucent');
  assert.doesNotMatch(html, /black-translucent/);
  assert.match(html, /<link rel="manifest" href="\.\/manifest\.webmanifest">/);
});

test('the worker caches exactly the files the page needs, and never an API response', () => {
  const sw = file('platform/sw.js'), core = file('shared/sw-core.js');
  const listed = [...sw.slice(sw.indexOf('assets: [')).matchAll(/'([^']+)'/g)].map((match) => match[1])
    .map((path) => new URL(path, 'https://example.test/platform/sw.js').pathname).sort();
  const needed = shellAssets({ extra: ['/platform/offline.html'] });
  assert.deepEqual(listed, needed, 'sw.js asset list drifted from the files the page imports');
  assert.ok(listed.every((path) => !path.includes('/api/')));
  assert.ok(listed.every((path) => path.startsWith('/platform/')), 'everything the worker needs lives under /platform/, so a host that serves only /platform/* can install it');
  assert.match(sw, /importScripts\('\.\/shared\/sw-core\.js'\)/, 'the worker script itself imports from inside /platform/');
  assert.match(core, /pathname\.includes\('\/api\/'\)\) return/, 'sw-core never intercepts /api/');
  assert.match(core, /request\.method !== 'GET'\) return/, 'mutations are never intercepted');
  assert.match(core, /cache: 'reload'/, 'install stores fresh copies, not HTTP-cache copies of the previous release');
});

test('SSOT: platform styles use shared tokens, with no raw colours, z-index numbers or safe-area calls of their own', () => {
  const css = file('platform/style.css'), tokens = file('shop/tokens.css');
  const withoutDeclarations = css.replace(/--[a-z0-9-]+\s*:\s*[^;}]*[;}]?/g, '');
  assert.deepEqual([...new Set(withoutDeclarations.match(/#[0-9a-fA-F]{3,8}\b/g) || [])], [], 'raw colours belong in tokens');
  assert.deepEqual(css.match(/z-index:\s*\d+/g) || [], [], 'layers use --ui-z-* tokens');
  assert.doesNotMatch(css, /env\(safe-area/, 'safe-area insets come from the --ui-safe-* tokens');
  for (const name of ['--ui-z-topbar', '--ui-z-banner', '--ui-z-loader', '--ui-motion-fast', '--ui-radius-md', '--ui-shadow-raised', '--ui-on-action']) assert.match(tokens, new RegExp(`${name}:`));
  for (const side of ['top', 'right', 'bottom', 'left']) assert.match(tokens, new RegExp(`--ui-safe-${side}: env\\(safe-area-inset-${side}, 0px\\)`));
  assert.match(css, /@import url\('\.\/seller\/style\.css'\)/); assert.match(css, /@import url\('\.\/commerce\.css'\)/);
});

test('every cached platform module imports through the symlinked shared files, which resolve to the single shared source', () => {
  for (const name of ['pwa.js', 'i18n.js', 'update-guard.js', 'icons.js', 'modal.js']) {
    assert.equal(file(`platform/shared/${name}`), file(`shared/${name}`), `${name} must be the shared file, not a copy`);
  }
});

test('the platform shell cannot change without a new version: installed browsers would keep the old cached files', () => {
  const version = file('platform/version.js').match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1];
  const record = JSON.parse(readFileSync(new URL('./platform-shell.fingerprint.json', import.meta.url), 'utf8'));
  const advice = 'Bump APP_VERSION in public/platform/version.js and `version` in public/platform/sw.js, then run: node scripts/platform-shell-fingerprint.mjs';
  if (record.version === version) assert.equal(record.fingerprint, shellFingerprint(), `A cached platform file changed but the version is still ${version}. ${advice}`);
  else assert.fail(`The version is ${version} but the recorded fingerprint belongs to ${record.version}. ${advice}`);
});
