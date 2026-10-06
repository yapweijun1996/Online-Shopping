import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');

test('the logo is one colour in tints, so it can follow the palette', () => {
  const svg = read('../public/favicon.svg');
  assert.match(svg, /<g id="mark" fill="currentColor">/);
  assert.match(svg, /<svg[^>]* color="#087f83"/, 'standalone fallback is the default teal');
  assert.doesNotMatch(svg, /fill="#(?!fff")[0-9a-f]{3,6}"/i, 'only white and currentColor fills; no fixed brand colours');
  assert.doesNotMatch(svg, /style=|<style|<linearGradient/, 'no inline styles, which the CSP would block');
});

test('the shop draws the logo with <use> and colours it from the palette', () => {
  const html = read('../public/shop/index.html');
  assert.equal((html.match(/<use href="\/favicon\.svg#mark"\/>/g) || []).length, 3, 'boot mark, header and mobile navigation');
  assert.doesNotMatch(html, /<img[^>]*src="\/favicon\.svg"/);
  const css = read('../public/shop/style.css');
  assert.match(css, /\.shop-brand-logo\{[^}]*color:var\(--ui-primary\)/);
  assert.match(css, /\.shop-boot-mark\{[^}]*color:var\(--ui-primary\)/);
  assert.match(read('../public/shop/sw.js'), /'\/favicon\.svg'/, 'the shared file is cached for offline use');
});
