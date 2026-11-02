import { stamp } from './credentials.js';

// Each statement has its own <=100-row writer transaction. Yield between batches;
// callers must not wrap cleanup in a writer transaction. Retain live replay history.
export async function cleanupOAuth(store) {
  const now = stamp(), cutoff = stamp(-86400000);
  const batches = [
    ['DELETE FROM oauth_authorization_request WHERE id IN (SELECT id FROM oauth_authorization_request WHERE expires_at <= ? ORDER BY expires_at, id LIMIT 100)', now],
    ['DELETE FROM oauth_authorization_code WHERE code_hash IN (SELECT code_hash FROM oauth_authorization_code WHERE expires_at <= ? ORDER BY expires_at, code_hash LIMIT 100)', now],
    [`DELETE FROM oauth_token WHERE token_hash IN (SELECT t.token_hash FROM oauth_token t
      JOIN oauth_grant g ON g.id = t.grant_id WHERE g.absolute_expires_at <= ?
      AND NOT EXISTS (SELECT 1 FROM oauth_token child WHERE child.predecessor_hash = t.token_hash)
      ORDER BY g.absolute_expires_at, t.token_hash LIMIT 100)`, cutoff],
    [`DELETE FROM oauth_grant WHERE id IN (SELECT g.id FROM oauth_grant g WHERE absolute_expires_at <= ?
      AND NOT EXISTS (SELECT 1 FROM oauth_token t WHERE t.grant_id = g.id)
      AND NOT EXISTS (SELECT 1 FROM oauth_authorization_code c WHERE c.grant_id = g.id)
      ORDER BY absolute_expires_at, id LIMIT 100)`, cutoff],
    [`DELETE FROM oauth_client WHERE id IN (SELECT c.id FROM oauth_client c WHERE expires_at <= ?
      AND NOT EXISTS (SELECT 1 FROM oauth_grant g WHERE g.client_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM oauth_authorization_request r WHERE r.client_id = c.id)
      ORDER BY expires_at, id LIMIT 100)`, now],
  ];
  for (const [sql, value] of batches) {
    await store.transaction(() => store.run(sql, value));
    await new Promise((resolve) => setImmediate(resolve));
  }
}
