import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tabIconHref } from '../public/shared/tab-icon.js';

const favicon = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8');
const decode = (href) => decodeURIComponent(href.replace('data:image/svg+xml,', ''));

test('the tab icon is the logo with the palette colour as its fallback colour', () => {
  const href = tabIconHref(favicon, '#7c426a');
  assert.ok(href.startsWith('data:image/svg+xml,'));
  const svg = decode(href);
  assert.match(svg, /<svg[^>]* color="#7c426a"/);
  assert.doesNotMatch(svg, /#087f83/);
  assert.equal(svg.replace(/ color="#7c426a"/, ' color="#087f83"'), favicon, 'nothing else changes');
});

test('unusable inputs leave the icon alone', () => {
  assert.equal(tabIconHref(favicon, 'rebeccapurple'), null);
  assert.equal(tabIconHref(favicon, '#12345'), null);
  assert.equal(tabIconHref('<svg/>', '#7c426a'), null);
  assert.equal(tabIconHref(null, '#7c426a'), null);
});

test('shop and seller start it with their palette and cache it offline', () => {
  assert.match(readFileSync(new URL('../public/shop/app.js', import.meta.url), 'utf8'), /mountTabIcon\(window\.shopPalette\)/);
  assert.match(readFileSync(new URL('../public/seller/app.js', import.meta.url), 'utf8'), /mountTabIcon\(window\.sellerPalette\)/);
  for (const worker of ['shop', 'seller']) assert.match(readFileSync(new URL(`../public/${worker}/sw.js`, import.meta.url), 'utf8'), /\/shared\/tab-icon\.js/);
});
