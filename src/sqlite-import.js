import { createHash } from 'node:crypto';

export const importTables = ['admin', 'seller_account', 'account_event', 'session', 'general_code', 'company_setting', 'shop_setup', 'option_type', 'option_value', 'listing', 'product',
  'product_option', 'product_gallery_image', 'order_sequence', 'shop_order', 'delivery', 'order_item', 'order_event',
  'checkout_idempotency', 'rate_limit_attempt'];

export function rowsDigest(rows) {
  const normalized = rows.map(row => Object.fromEntries(Object.keys(row).sort().map(key =>
    [key, ArrayBuffer.isView(row[key]) ? { bytes: Buffer.from(row[key]).toString('base64') } : row[key]])));
  const ordered = normalized.map(row => JSON.stringify(row)).sort();
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

/* Import only into a fresh baseline. No source data is deleted and no existing
 * destination shop may be overwritten. The caller supplies an isolated SQLite copy. */
export async function importSqlite(source, target) {
  if (source.dialect !== 'sqlite' || target.dialect !== 'postgres') throw new Error('Expected SQLite source and PostgreSQL target.');
  if (await source.schemaVersion() !== await target.schemaVersion()) throw new Error('Schema versions do not match.');
  return target.transaction(async () => {
    const defaults = new Set(['company_setting', 'shop_setup', 'order_sequence']);
    for (const table of importTables) {
      const rows = await target.all(`SELECT * FROM ${table}`);
      if ((!defaults.has(table) && rows.length) || (defaults.has(table) && rows.length !== 1)) throw new Error('Import destination must be a fresh baseline.');
    }
    const setting = await target.get('SELECT mode FROM shop_setup WHERE id = 1');
    const sequence = await target.get('SELECT value FROM order_sequence WHERE id = 1');
    if (setting.mode !== null || sequence.value !== 0) throw new Error('Import destination is already configured.');
    for (const table of defaults) await target.run(`DELETE FROM ${table}`);
    // Historical products may refer to categories subsequently deactivated. Restore
    // those exact rows, then reinstate the normal write-time category constraint.
    await target.exec('ALTER TABLE product DISABLE TRIGGER USER');
    const evidence = [];
    for (const table of importTables) {
      const rows = await source.all(`SELECT * FROM ${table}`);
      for (const row of rows) {
        const keys = Object.keys(row);
        if (keys.some(key => !/^[a-z_][a-z_0-9]*$/.test(key))) throw new Error('Unexpected import column.');
        await target.run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
          ...keys.map(key => ArrayBuffer.isView(row[key]) ? Buffer.from(row[key]) : row[key]));
      }
      const restored = await target.all(`SELECT * FROM ${table}`);
      const digest = rowsDigest(rows);
      if (rows.length !== restored.length || digest !== rowsDigest(restored)) throw new Error(`Import verification failed for ${table}.`);
      evidence.push({ table, rows: rows.length, sha256: digest });
    }
    await target.exec('ALTER TABLE product ENABLE TRIGGER USER');
    for (const table of ['order_event', 'rate_limit_attempt']) {
      await target.get(`SELECT setval(pg_get_serial_sequence('${table}', 'id'),
        COALESCE((SELECT MAX(id) FROM ${table}), 1), EXISTS(SELECT 1 FROM ${table}))`);
    }
    return { schemaVersion: await target.schemaVersion(), tables: evidence };
  });
}
