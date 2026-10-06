import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);

test('backend image copies every public/ file that src/ imports', () => {
  const dockerfile = readFileSync(new URL('Dockerfile.backend', root), 'utf8');
  const copied = new Set(dockerfile.split('\n').filter(line => line.startsWith('COPY '))
    .flatMap(line => line.split(/\s+/).slice(1, -1)));
  const needed = new Set();
  for (const file of readdirSync(new URL('src/', root)).filter(name => name.endsWith('.js'))) {
    const source = readFileSync(new URL(`src/${file}`, root), 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\()\s*['"]\.\.\/(public\/[^'"]+)['"]/g)) needed.add(match[1]);
  }
  assert.ok(needed.size > 0, 'expected src/ to import public/ files');
  for (const path of needed) assert.ok(copied.has(path), `Dockerfile.backend must COPY ${path}`);
});
