// Separate-process platform row-lock fixture; opens only a synthetic database.
import pg from 'pg';

const url = new URL(process.env.SHOP_TEST_DATABASE_URL || 'http://invalid');
if (process.env.NODE_ENV !== 'test' || !process.send || url.hostname !== '127.0.0.1' ||
    !/^\/shopping_test_platform_guard_[0-9a-f]{32}$/.test(url.pathname) ||
    !/^mcp_v2_worker_[0-9a-f]{32}$/.test(url.searchParams.get('application_name') || '')) {
  throw new Error('Only a dedicated loopback synthetic platform database may be used.');
}
const client = new pg.Client({ connectionString: url.href });
await client.connect();
process.send({ type: 'ready' });
const command = await new Promise((resolve) => process.once('message', resolve));
if (command?.type !== 'start' || command.tenantId !== 'synthetic') throw new Error('Invalid synthetic tenant command.');
await client.query('BEGIN');
process.send({ type: 'attempt' });
await client.query("UPDATE tenant SET status = 'SUSPENDED', revision = revision + 1 WHERE id = $1", [command.tenantId]);
await client.query('COMMIT');
process.send({ type: 'committed' });
await client.end();
process.disconnect();
