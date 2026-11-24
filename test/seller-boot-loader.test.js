import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const publicRoot = new URL('../public/', import.meta.url);
const read = (path) => readFileSync(new URL(path, publicRoot), 'utf8');
const html = read('seller/index.html').replace(/<!--[\s\S]*?-->/g, '');
const loaderImages = [
  '/shared/brand/pomelo-placeholder-loader.svg',
  '/shared/brand/pomelo-placeholder-loader-dark.svg',
];

function attributes(tag) {
  return Object.fromEntries(Array.from(tag.matchAll(/\s([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g),
    ([, name, doubleQuoted, singleQuoted, unquoted]) => [name.toLowerCase(), doubleQuoted ?? singleQuoted ?? unquoted ?? '']));
}

function loaderMarkup() {
  const openings = Array.from(html.matchAll(/<div\b[^>]*>/gi))
    .filter(([tag]) => attributes(tag).id === 'seller-boot-loader');
  assert.equal(openings.length, 1, 'the static Seller shell contains exactly one loader div');
  const [opening] = openings;
  const tail = html.slice(opening.index + opening[0].length);
  let depth = 1;
  for (const tag of tail.matchAll(/<\/?div\b[^>]*>/gi)) {
    depth += tag[0].startsWith('</') ? -1 : 1;
    if (depth === 0) {
      const markup = tail.slice(0, tag.index);
      const images = Array.from(markup.matchAll(/<img\b[^>]*>/gi), ([img]) => attributes(img).src);
      return { attrs: attributes(opening[0]), images };
    }
  }
  assert.fail('the Seller loader div is not closed');
}

test('Seller serves an accessible boot loader before JavaScript runs', () => {
  const body = attributes(html.match(/<body\b[^>]*>/i)?.[0] ?? '');
  assert.ok(body.class?.split(/\s+/).includes('seller-booting'), 'the static body is in boot state');

  const { attrs, images } = loaderMarkup();
  assert.ok(attrs.class?.split(/\s+/).includes('seller-boot-overlay'));
  assert.equal(attrs.role, 'status');
  assert.equal(attrs['aria-live'], 'polite');
  assert.ok(!Object.hasOwn(attrs, 'hidden'), 'the static loader has no hidden attribute');
  for (const image of loaderImages) assert.ok(images.includes(image), `${image} is inside the loader`);
});

test('Seller clears the loader when the first screen is ready or bootstrap fails', () => {
  const loader = read('seller/boot-loader.js');
  assert.match(loader, /\bloader\.hidden\s*=\s*true\b/);
  assert.match(loader, /\bbody\.classList\.remove\(['"]seller-booting['"]\)/);

  const app = read('seller/app.js');
  const login = app.match(/function showLogin\([\s\S]*?^}/m)?.[0] ?? '';
  const dashboard = app.match(/async function renderDashboard\([\s\S]*?^}/m)?.[0] ?? '';
  assert.match(login, /loginView\.hidden\s*=\s*false;[\s\S]*?\bhideBootLoader\(\)/, 'show the login screen before clearing the loader');
  assert.match(dashboard, /finally\s*{[\s\S]*?\bhideBootLoader\(\)/, 'clear the loader after rendering the dashboard shell');
  assert.match(read('seller/bootstrap.js'), /catch\s*\(\w+\)\s*{\s*hideBootLoader\(\);\s*showBootstrapError\(/,
    'clear the loader before presenting a bootstrap error');
});

test('Seller precaches the boot loader assets for default and tenant shops', () => {
  const { images } = loaderMarkup();
  const files = ['./boot-loader.css', './boot-loader.js', ...images];
  for (const file of files) {
    const asset = new URL(file, 'https://example.test/seller/').pathname;
    assert.ok(existsSync(new URL(asset.slice(1), publicRoot)), `missing loader asset: ${asset}`);
  }

  for (const prefix of ['', '/alpha']) {
    const scope = `https://example.test${prefix}/seller/`;
    let config;
    runInNewContext(read('seller/sw.js'), {
      URL, importScripts() {}, self: { registration: { scope }, setupOfflineWorker(value) { config = value; } },
    });
    for (const file of files) {
      const asset = new URL(file, scope).pathname;
      assert.ok(config.assets.includes(asset), `${asset} is not in the Seller precache`);
    }
  }
});
