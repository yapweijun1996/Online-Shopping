import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('account menu lists "Check for updates" right after Settings and wires it to the update check', () => {
  const html = readFileSync(new URL('../public/shop/index.html', import.meta.url), 'utf8');
  const menu = html.match(/<nav id="profile-menu"[\s\S]*?<\/nav>/)[0];
  const order = [...menu.matchAll(/data-i18n="(\w+)"/g)].map(match => match[1]);
  assert.deepEqual(order, ['customerProfile', 'myOrders', 'myAddresses', 'settings', 'checkUpdates']);
  assert.match(menu, /<button type="button" id="profile-menu-check-updates"/);
  const script = readFileSync(new URL('../public/shop/app.js', import.meta.url), 'utf8');
  assert.match(script, /profile-menu-check-updates[\s\S]{0,200}location\.hash = '#settings'[\s\S]{0,200}shop-update-settings/);
});
