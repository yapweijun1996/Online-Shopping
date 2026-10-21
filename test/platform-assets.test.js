import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, lstat, realpath, readFile, access } from 'node:fs/promises';
import path from 'node:path';
const publicRoot = path.resolve('public');
test('platform symlinks and relative stylesheet assets resolve inside public', async () => {
  const visited = new Set();
  async function asset(file) {
    file = path.resolve(file);
    assert.ok(file.startsWith(publicRoot + path.sep), file);
    await access(file);
    const actual = await realpath(file);
    assert.ok(actual.startsWith(publicRoot + path.sep), actual);
    if (visited.has(file) || !/\.(css|html|js)$/.test(file)) return;
    visited.add(file);
    const text = await readFile(file, 'utf8');
    const references = file.endsWith('.css') ? [...text.matchAll(/(?:url\(\s*['"]?)([^'"\s)]+)/g)].map(m => m[1]) : file.endsWith('.html') ? [...text.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]) : [...text.matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g)].map(m => m[1]);
    for (const ref of references) {
      if (/^(?:https?:|data:|#)/.test(ref) || ref === './') continue;
      await asset(ref.startsWith('/') ? path.join(publicRoot, ref) : path.resolve(path.dirname(file), ref.split(/[?#]/)[0]));
    }
  }
  async function walk(dir) {
    for (const entry of await readdir(dir)) {
      const file = path.join(dir, entry), stat = await lstat(file);
      if (stat.isDirectory()) await walk(file);
      else await asset(file);
    }
  }
  await walk(path.join(publicRoot, 'platform'));
});
