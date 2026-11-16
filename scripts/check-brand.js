import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(root, file));
const text = file => read(file).toString('utf8');
const fail = message => { throw new Error(message); };
const svg = ['pomelo-compact.svg', 'pomelo-icon-square.svg', 'pomelo-icon-maskable.svg', 'pomelo-master-detailed.svg', 'pomelo-placeholder-loader.svg', 'pomelo-placeholder-loader-dark.svg', 'pomelo-placeholder-static.svg', 'pomelo-placeholder-static-dark.svg', 'pomelo-loader.svg'];
const png = ['pomelo-icon-square-192.png', 'pomelo-icon-square-512.png', 'pomelo-icon-maskable-192.png', 'pomelo-icon-maskable-512.png'];
const all = [...svg, ...png];
const checksums = JSON.parse(text('brand/CHECKSUMS.json'));
for (const file of all) {
  const digest = createHash('sha256').update(read(`brand/${file}`)).digest('hex');
  if (digest !== checksums[file]) fail(`Incorrect checksum for brand/${file}`);
  if (!read(`public/shared/brand/${file}`).equals(read(`brand/${file}`))) fail(`Published asset differs from brand/${file}`);
}
for (const app of ['seller', 'shop']) {
  const html = text(`public/${app}/index.html`);
  const manifest = JSON.parse(text(`public/${app}/manifest.webmanifest`));
  for (const icon of manifest.icons) if (!existsSync(path.join(root, 'public', icon.src.replace(/^\//, '')))) fail(`Missing ${app} manifest icon ${icon.src}`);
  if (!html.includes('/shared/brand/pomelo-compact.svg')) fail(`${app} favicon/header must use compact brand artwork`);
  const mobileNavIcons = html.match(/<[^>]*class=["'][^"']*\bmobile-nav-icon\b[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/g) || [];
  if (mobileNavIcons.some(icon => icon.includes('pomelo-compact.svg'))) fail(`${app} navigation icons must not use compact brand artwork`);
  for (const detailed of ['pomelo-master-detailed.svg', 'pomelo-loader.svg']) {
    if (html.includes(detailed)) fail(`${app} must not use detailed/animated artwork as a small UI logo`);
  }
  const source = html.match(/(?:src|href)=["'][^"']*(?:pomelo-master-detailed|pomelo-loader)\.svg[^"']*["']/g) || [];
  if (source.length) fail(`${app} has detailed artwork below a verified 128px size`);
}
for (const app of ['seller', 'shop']) {
  const manifest = JSON.parse(text(`public/${app}/manifest.webmanifest`));
  if (!manifest.icons.some(icon => icon.purpose?.split(/\s+/).includes('maskable'))) fail(`${app} manifest is missing a maskable icon`);
  if (!manifest.icons.some(icon => icon.purpose?.split(/\s+/).includes('any'))) fail(`${app} manifest is missing an any icon`);
}
console.log('Brand source, published copies, and seller/shop references verified.');
