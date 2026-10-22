import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { icon } from '../public/shared/icons.js';

test('UI chrome does not depend on symbol fonts', async () => {
  // These are prose relationships and arithmetic, not control affordances.
  const textSymbols = {
    'public/demo/app.js': '×',
    'public/shop/app.js': '×',
    'public/seller/orders.js': '×',
    'public/seller/product-import.js': '→',
    'public/seller/products.js': '→',
    'public/seller/team.js': '→',
    'public/seller/tracking-import.js': '←→',
    'public/seller/whatsapp-connection.js': '→',
    'public/seller/whatsapp-qr-copy.js': '→',
  };
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await scan(path);
      else if (/\.(html|js|css)$/.test(path)) {
        const text = await readFile(path, 'utf8');
        assert.doesNotMatch(text, /[⌄▾▼˅›‹❯✕✓✔↑↓•★☆☰🔍⚠✦➕📦🔒📋✉⚙✎▶◀●○🗑▧↺☐⧉−]/u, path);
        for (const glyph of text.match(/[×←→]/gu) || []) assert.ok(textSymbols[path]?.includes(glyph), `${path}: unexpected ${glyph}`);
      }
    }
  }
  await scan('public');
});

test('icons build namespaced, hidden SVGs without parsing markup', t => {
  const old = globalThis.document;
  t.after(() => { globalThis.document = old; });
  globalThis.document = { createElementNS(namespaceURI, localName) {
    return { namespaceURI, localName, attributes: {}, children: [], setAttribute(key, value) { this.attributes[key] = value; }, append(child) { this.children.push(child); } };
  } };
  for (const name of ['up', 'down', 'left', 'right', 'close', 'plus', 'minus', 'reset', 'image', 'copy', 'square', 'user', 'more']) {
    const svg = icon(name);
    assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(svg.localName, 'svg');
    assert.equal(svg.attributes.viewBox, '0 0 24 24');
    assert.equal(svg.attributes['aria-hidden'], 'true');
    assert.equal(svg.attributes.focusable, 'false');
    assert.equal(svg.attributes.stroke, 'currentColor');
    assert.equal(svg.children[0].localName, 'path');
    assert.equal(svg.children[0].namespaceURI, svg.namespaceURI);
    assert.match(svg.children[0].attributes.d, /^M|^m/);
  }
  assert.throws(() => icon('unknown'), RangeError);
});
