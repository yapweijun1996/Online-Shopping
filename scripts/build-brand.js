import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'brand');
const shared = path.join(root, 'public/shared/brand');
const svgFiles = ['pomelo-compact.svg', 'pomelo-icon-square.svg', 'pomelo-icon-maskable.svg', 'pomelo-master-detailed.svg', 'pomelo-placeholder-loader.svg', 'pomelo-placeholder-loader-dark.svg', 'pomelo-placeholder-static.svg', 'pomelo-placeholder-static-dark.svg', 'pomelo-loader.svg'];
const pngFiles = ['pomelo-icon-square-192.png', 'pomelo-icon-square-512.png', 'pomelo-icon-maskable-192.png', 'pomelo-icon-maskable-512.png'];
mkdirSync(shared, { recursive: true });
for (const name of [...svgFiles, ...pngFiles]) copyFileSync(path.join(source, name), path.join(shared, name));
for (const app of ['seller', 'shop']) {
  const icons = path.join(root, `public/${app}/icons`);
  mkdirSync(icons, { recursive: true });
  for (const [input, output] of [['pomelo-icon-square-192.png', 'icon-192.png'], ['pomelo-icon-square-512.png', 'icon-512.png'], ['pomelo-icon-maskable-192.png', 'icon-maskable-192.png'], ['pomelo-icon-maskable-512.png', 'icon-maskable-512.png']]) copyFileSync(path.join(source, input), path.join(icons, output));
}
const checksums = Object.fromEntries([...svgFiles, ...pngFiles].map(name => [name, createHash('sha256').update(readFileSync(path.join(source, name))).digest('hex')]));
writeFileSync(path.join(source, 'CHECKSUMS.json'), `${JSON.stringify(checksums, null, 2)}\n`);
