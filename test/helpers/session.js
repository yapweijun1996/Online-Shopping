// A signed-in seller session for tests that call createApi directly: makes sure the first Owner exists, then signs in as it.
import { createSession, ensureAdmin, sampleAccount } from '../../src/auth.js';

export async function ownerSession(store) {
  await ensureAdmin(store, 'fixture_owner', 'SyntheticTestPass123!');
  return createSession(store, (await sampleAccount(store)).id);
}
