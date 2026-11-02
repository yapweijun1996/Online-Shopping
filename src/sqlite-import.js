import { createHash } from 'node:crypto';

export const importTables = ['admin', 'seller_account', 'account_event', 'session', 'general_code', 'company_setting', 'shop_setup', 'option_type', 'option_value', 'listing', 'product',
  'product_option', 'product_gallery_image', 'order_sequence', 'shop_order', 'delivery', 'order_item', 'order_event', 'order_note', 'product_event',
  'checkout_idempotency', 'rate_limit_attempt', 'integration_connection', 'integration_audit', 'webhook_receipt', 'message_outbox', 'message_inbound',
  'oauth_client', 'oauth_authorization_request', 'oauth_grant', 'oauth_authorization_code', 'oauth_token', 'mcp_audit', 'ai_setting', 'ai_usage', 'ai_suggestion_audit'];

// QR device identity, sealed peers and reply intents must not reactivate after a restore.
// Keep the fresh OFF/IDLE session; do not import auth, QR material or dependent history.
export const excludedImportTables = ['whatsapp_qr_session', 'whatsapp_qr_auth', 'message_peer_suppression', 'message_thread', 'message_thread_message'];

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
    const defaults = new Set(['company_setting', 'shop_setup', 'order_sequence', 'ai_setting']);
    for (const table of importTables) {
      const rows = await target.all(`SELECT * FROM ${table}`);
      if ((!defaults.has(table) && rows.length) || (defaults.has(table) && rows.length !== 1)) throw new Error('Import destination must be a fresh baseline.');
    }
    const qr = await target.get('SELECT * FROM whatsapp_qr_session WHERE id = 1');
    if (!qr || qr.desired !== 'OFF' || qr.state !== 'IDLE' || qr.generation !== 1 || qr.auth_version !== 0 ||
      qr.revision !== 1 || qr.qr_text !== null || qr.peer_key_sealed !== null || qr.lease_owner !== null) {
      throw new Error('Import destination must have a fresh QR session.');
    }
    for (const table of excludedImportTables.filter(table => table !== 'whatsapp_qr_session')) {
      if (await target.get(`SELECT 1 AS found FROM ${table} LIMIT 1`)) throw new Error('Import destination must have no QR history or auth.');
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
