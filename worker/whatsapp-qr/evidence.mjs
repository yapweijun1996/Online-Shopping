import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
await mkdir('evidence', { recursive: true });
for (const [name, args] of [
  ['metadata', ['view', '@whiskeysockets/baileys@6.7.24', '--json']],
  ['tree', ['ls', '--all']], ['audit', ['audit', '--json']],
  ['signatures', ['audit', 'signatures']]
]) {
  const r = spawnSync('npm', args, { encoding: 'utf8', env: process.env });
  await writeFile(`evidence/${name}.txt`, `exit=${r.status}\n${r.stdout}${r.stderr}`);
  console.log(`${name}: exit=${r.status}`);
}
const lock = JSON.parse(await readFile('package-lock.json'));
const inventory = [];
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path) continue;
  let manifest;
  try { manifest = JSON.parse(await readFile(`${path}/package.json`)); } catch { /* Other-platform optional binary. */ }
  inventory.push({ path, version: entry.version, resolved: entry.resolved, integrity: entry.integrity,
    license: manifest?.license ?? entry.license, optional: entry.optional ?? false,
    scripts: manifest?.scripts, hasInstallScript: entry.hasInstallScript ?? false,
    native: manifest ? (await readdir(path)).filter(n => /binding|prebuild|vendor/.test(n)) : [],
    unpackedSize: entry.size });
}
await writeFile('evidence/inventory.json', JSON.stringify(inventory, null, 2) + '\n');
const url = 'https://registry.npmjs.org/-/npm/v1/attestations/@whiskeysockets%2fbaileys@6.7.24';
const response = await fetch(url, { redirect: 'error' });
await writeFile('evidence/attestations.json', await response.text());
console.log(`attestations: HTTP ${response.status}`);
