import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

test('PostgreSQL constraint proof canonicalizes dump/restore grouping and retains changed bounds', { skip: !process.env.SHOP_TEST_DATABASE_URL }, async () => {
  const client = new pg.Client({ connectionString: process.env.SHOP_TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query(`CREATE TEMP TABLE proof_nested (value text CHECK (value IS NULL OR (length(value) BETWEEN 8 AND 15 AND value ~ '^[0-9]+$')));
      CREATE TEMP TABLE proof_flat (value text CHECK (value IS NULL OR (length(value) >= 8 AND length(value) <= 15 AND value ~ '^[0-9]+$')));
      CREATE TEMP TABLE proof_changed (value text CHECK (value IS NULL OR (length(value) >= 8 AND length(value) <= 16 AND value ~ '^[0-9]+$')));`);
    const { rows } = await client.query(`SELECT c.relname, pg_get_constraintdef(k.oid) AS raw, pg_get_constraintdef(k.oid, true) AS canonical
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace=pg_my_temp_schema() AND k.contype='c' ORDER BY c.relname;`);
    const definitions = Object.fromEntries(rows.map((row) => [row.relname, row]));
    assert.notEqual(definitions.proof_nested.raw, definitions.proof_flat.raw);
    assert.equal(definitions.proof_nested.canonical, definitions.proof_flat.canonical);
    assert.notEqual(definitions.proof_nested.canonical, definitions.proof_changed.canonical);
  } finally { await client.end(); }
});
