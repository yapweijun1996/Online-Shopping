import test from 'node:test';
import assert from 'node:assert/strict';
import { initializePostgresSchema12, postgresSchema12Sql, postgresUpgradeTo12Sql } from '../deploy/postgres/schema12.js';

// Protocol tests establish decisions and transaction ordering, not PostgreSQL
// SQL execution or native-worker/API compatibility. Real engine QA is separate.
function fixture({ version, tables = 0, fail } = {}) {
  const calls = [];
  const query = sql => {
    calls.push(sql);
    if (fail?.(sql)) throw new Error('synthetic migration fault');
    if (sql.includes('to_regclass')) return [{ name: version === undefined ? null : 'schema_meta' }];
    if (sql.startsWith('SELECT version')) return [{ version }];
    if (sql.includes('FROM pg_tables')) return [{ count: tables }];
    return [];
  };
  return { calls, query };
}

test('fresh PostgreSQL schema12 initializes under a transaction-scoped lock', () => {
  const f = fixture(); initializePostgresSchema12(f.query);
  assert.equal(f.calls[0], 'BEGIN'); assert.match(f.calls[1], /pg_advisory_xact_lock/);
  assert.ok(f.calls.includes(postgresSchema12Sql)); assert.equal(f.calls.at(-1), 'COMMIT');
});

test('existing schema12 is read without rebuilding any application table', () => {
  const f = fixture({ version: 12 }); initializePostgresSchema12(f.query);
  assert.ok(!f.calls.some(sql => /ALTER TABLE|CREATE TABLE|UPDATE schema_meta/.test(sql)));
  assert.equal(f.calls.at(-1), 'COMMIT');
});

test('schema10 and11 require explicit boolean upgrade authorization', () => {
  for (const version of [10, 11]) for (const allowUpgrade of [undefined, false, 'true']) {
    const f = fixture({ version });
    assert.throws(() => initializePostgresSchema12(f.query, { allowUpgrade }), /explicit approval/);
    assert.equal(f.calls.at(-1), 'ROLLBACK'); assert.ok(!f.calls.some(sql => /ALTER TABLE/.test(sql)));
  }
});

test('authorized schema10 and11 upgrades guard their source version inside the transaction', () => {
  for (const version of [10, 11]) {
    const f = fixture({ version }); initializePostgresSchema12(f.query, { allowUpgrade: true });
    const sql = postgresUpgradeTo12Sql(version);
    assert.ok(f.calls.includes(sql)); assert.equal(f.calls.at(-1), 'COMMIT');
    assert.match(sql, new RegExp(`version = ${version}`));
    assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM|UPDATE (?:product\b|shop_order\b|order_item\b)|TRUNCATE/i);
  }
});

test('unknown, future and malformed version metadata fails closed without schema writes', () => {
  for (const version of [0, 9, 13, null, '10']) {
    const f = fixture({ version }); assert.throws(() => initializePostgresSchema12(f.query, { allowUpgrade: true }), /Unsupported/);
    assert.equal(f.calls.at(-1), 'ROLLBACK'); assert.ok(!f.calls.some(sql => /ALTER TABLE|CREATE TABLE/.test(sql)));
  }
  assert.throws(() => postgresUpgradeTo12Sql(13), /Unsupported/);
});

test('nonempty unversioned databases refuse adoption and schema faults roll back', () => {
  const unknown = fixture({ tables: 1 }); assert.throws(() => initializePostgresSchema12(unknown.query), /not empty/);
  assert.equal(unknown.calls.at(-1), 'ROLLBACK');
  for (const version of [undefined, 10, 11]) {
    const f = fixture({ version, fail: sql => /CREATE TABLE|ALTER TABLE/.test(sql) });
    assert.throws(() => initializePostgresSchema12(f.query, { allowUpgrade: true }), /synthetic migration fault/);
    assert.equal(f.calls.at(-1), 'ROLLBACK'); assert.ok(!f.calls.includes('COMMIT'));
  }
});
