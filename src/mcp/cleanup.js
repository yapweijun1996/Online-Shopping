import { stamp } from './credentials.js';

// One bounded pass. Keep every token generation until absolute family expiry + one day,
// including spent refresh tokens needed to detect replay against a live successor.
export async function cleanupOAuth(store) {
  return store.transaction(async () => {
    const now = stamp(), cutoff = stamp(-86400000);
    await store.run('DELETE FROM oauth_authorization_request WHERE id IN (SELECT id FROM oauth_authorization_request WHERE expires_at <= ? ORDER BY expires_at, id LIMIT 100)', now);
    await store.run('DELETE FROM oauth_authorization_code WHERE code_hash IN (SELECT code_hash FROM oauth_authorization_code WHERE expires_at <= ? ORDER BY expires_at, code_hash LIMIT 100)', now);
    // Leaf-first deletion respects the RESTRICT predecessor FK on both engines.
    await store.run(`DELETE FROM oauth_token WHERE token_hash IN (SELECT t.token_hash FROM oauth_token t
      JOIN oauth_grant g ON g.id = t.grant_id WHERE g.absolute_expires_at <= ?
      AND NOT EXISTS (SELECT 1 FROM oauth_token child WHERE child.predecessor_hash = t.token_hash)
      ORDER BY g.absolute_expires_at, t.token_hash LIMIT 100)`, cutoff);
    await store.run(`DELETE FROM oauth_grant WHERE id IN (SELECT g.id FROM oauth_grant g WHERE absolute_expires_at <= ?
      AND NOT EXISTS (SELECT 1 FROM oauth_token t WHERE t.grant_id = g.id)
      AND NOT EXISTS (SELECT 1 FROM oauth_authorization_code c WHERE c.grant_id = g.id)
      ORDER BY absolute_expires_at, id LIMIT 100)`, cutoff);
    await store.run(`DELETE FROM oauth_client WHERE id IN (SELECT c.id FROM oauth_client c WHERE expires_at <= ?
      AND NOT EXISTS (SELECT 1 FROM oauth_grant g WHERE g.client_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM oauth_authorization_request r WHERE r.client_id = c.id)
      ORDER BY expires_at, id LIMIT 100)`, now);
  });
}
