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

test('the shop uses the shared compact logo and palette-aware tab icon', () => {
  const html = read('../public/shop/index.html');
  assert.equal((html.match(/src="\/shared\/brand\/pomelo-compact\.svg"/g) || []).length, 1, 'header uses the shared compact logo');
  assert.match(html, /pomelo-placeholder-loader\.svg/);
  assert.match(html, /pomelo-placeholder-static\.svg/);
  const css = read('../public/shop/style.css');
  assert.match(css, /\.shop-topbar \.brand-mark\{[^}]*width:42px;height:42px/);
  assert.match(read('../public/shared/tab-icon.js'), /fetch\('\/shared\/brand\/pomelo-compact\.svg'\)/);
  assert.match(read('../public/shop/sw.js'), /pomelo-compact\.svg/);
});

test('seller branding uses the shared logo in the header, login and sidebar', () => {
  const html = read('../public/seller/index.html');
  assert.equal((html.match(/src="\/shared\/brand\/pomelo-compact\.svg"/g) || []).length, 5);
  assert.doesNotMatch(html, /studio-leaf\.svg/);
  assert.match(read('../public/seller/sw.js'), /pomelo-compact\.svg/);
  assert.match(read('../public/seller/brand.css'), /\.seller-brand-logo\{/);
  assert.match(read('../public/seller/sw.js'), /'\.\/brand\.css'/);
});
