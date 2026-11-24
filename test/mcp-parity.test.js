import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { catalogue } from '../src/mcp/tools.js';
import { createOperationTools } from '../src/mcp/operation-tools.js';
import { defaultOperationEntries } from '../src/mcp/routes.js';
import { mediaToolsFixture } from './helpers/mcp-media-tools-fixture.js';

function matrixRows(markdown) {
  const section = markdown.split('## MCP parity matrix (R3)')[1]?.split('\n## ')[0];
  assert.ok(section, 'Missing MCP parity matrix');
  const lines = section.split('\n').filter(line => line.startsWith('|'));
  assert.match(lines[0] ?? '', /^\| Capability \| Seller backend \| MCP \| Gap \|$/);
  assert.match(lines[1] ?? '', /^\|(?:\s*-+\s*\|){4}$/);
  const rows = lines.slice(2).map(line => {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    assert.equal(cells.length, 4, `Invalid matrix row: ${line}`);
    const [capability, backend, cell] = cells;
    assert.ok(capability && backend, `Missing capability or backend: ${line}`);
    if (cell === 'no') return { capability, backend, tools: [] };
    assert.match(cell, /^`[a-z]+\.[a-z_]+`(?:, `[a-z]+\.[a-z_]+`)*$/, `Use exact MCP tool names: ${line}`);
    return { capability, backend, tools: [...cell.matchAll(/`([^`]+)`/g)].map(match => match[1]) };
  });
  assert.ok(rows.length, 'Empty MCP parity matrix');
  return rows;
}

function checkParity(rows, names) {
  for (const { capability, tools } of rows) {
    for (const name of tools) assert.ok(names.has(name), `${capability}: MCP tool ${name} is missing from the default catalog`);
  }
}

test('documented Seller capabilities name existing default MCP tools', async t => {
  const f = await mediaToolsFixture(t, 'sqlite');
  const entries = defaultOperationEntries({ mediaOptions: {}, runtime: f.runtime,
    catalogUpdateEnabled: false, catalogCreateEnabled: false, mediaEnabled: true });
  const extensions = createOperationTools({ store: f.store, binding: f.binding, config: f.config,
    tenantGuard: f.guard, quickLogin: false, entries });
  const names = new Set([...catalogue, ...extensions.catalogue].map(tool => tool.name));
  const rows = matrixRows(await readFile(new URL('../docs/CLIENT_REQUIREMENTS_2026_11.md', import.meta.url), 'utf8'));
  for (const row of rows) t.diagnostic(`${row.capability} | Seller: ${row.backend} | MCP: ${row.tools.join(', ') || 'no'}`);
  checkParity(rows, names);
  const missing = new Set(names);
  missing.delete('catalog.commit_create_category');
  assert.throws(() => checkParity(rows, missing), /catalog\.commit_create_category.*missing/);
  assert.throws(() => matrixRows('| no table |'), /Missing MCP parity matrix/);
  assert.throws(() => matrixRows('## MCP parity matrix (R3)\n| Capability | Seller backend | MCP | Gap |\n| --- | --- | --- | --- |\n| Image | yes | `media.*` | none |'), /Use exact MCP tool names/);
});
