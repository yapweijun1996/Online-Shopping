// Separate-process fixture for synthetic PostgreSQL race tests only.
// The guarded name/host checks prevent this helper from opening a live store.
import { openPostgresStore } from '../../src/postgres-store.js';
import { deleteSession } from '../../src/auth.js';
import { invalidateOAuth, revokeGrant } from '../../src/mcp/credentials.js';

const url = new URL(process.env.SHOP_TEST_DATABASE_URL || 'http://invalid');
if (process.env.NODE_ENV !== 'test' || !process.send || url.hostname !== '127.0.0.1' ||
    !/^\/shopping_test_engine_[0-9a-f]{32}$/.test(url.pathname) ||
    !/^mcp_v2_worker_[0-9a-f]{32}$/.test(url.searchParams.get('application_name') || '')) {
  throw new Error('Only a dedicated loopback synthetic database may be used.');
}
const store = openPostgresStore(url.href);
const message = (type) => process.send({ type });
const nextMessage = () => new Promise((resolve) => process.once('message', resolve));
message('ready');
const command = await nextMessage();
if (command?.type !== 'start' || !['revoke', 'disable', 'downgrade', 'logout'].includes(command.action)) {
  throw new Error('Invalid synthetic worker command.');
}
message('attempt');
await store.transaction(async () => {
  if (command.action === 'revoke') {
    await revokeGrant(store, command.grantId, 'SYNTHETIC_TEST');
  } else if (command.action === 'logout') {
    await deleteSession(store, command.sessionToken);
  } else {
    if (command.action === 'disable') {
      await store.run('UPDATE seller_account SET active = 0 WHERE id = ?', command.accountId);
    } else {
      await store.run("UPDATE seller_account SET role = 'STAFF' WHERE id = ?", command.accountId);
    }
    await invalidateOAuth(store, command.accountId);
  }
  // Install the listener before notifying the parent to avoid missing release.
  const resume = command.hold ? nextMessage() : null;
  message('mutated');
  if (resume && (await resume)?.type !== 'release') throw new Error('Invalid synthetic release.');
});
message('committed');
await store.close();
process.disconnect();
