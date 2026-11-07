// Host-authorized configuration repair. Never used by an HTTP/MCP handler.
import { createHash } from 'node:crypto';
import { SCHEMA_VERSION } from './db.js';
import { boundedText } from './validation.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deny = () => { throw new Error('Shop promotion preconditions failed.'); };
function target(config) {
  if (config?.production !== true || config.shopMode !== 'manual' || config.sellerQuickLogin !== false) deny();
  const origin = value => { try { const url = new URL(value); if (url.protocol !== 'https:' || url.origin !== value) deny(); return value; } catch { deny(); } };
  const publicOrigin = origin(config.publicOrigin), sellerOrigin = origin(config.sellerOrigin);
  // Bind the plan to a database identity without persisting credentials.
  let database;
  if (config.databaseUrl) {
    const url = new URL(config.databaseUrl);
    database = [url.protocol, url.hostname, url.port || '5432', url.pathname, url.username];
  } else if (typeof config.dbPath === 'string' && config.dbPath.startsWith('/')) database = ['sqlite', config.dbPath];
  else deny();
  return digest({ publicOrigin, sellerOrigin, database });
}
function name(value) {
  const result = boundedText(value, 'shopName', 80);
  if (/\b(preview|demo)\b/i.test(result)) deny();
  return result;
}
function checked(plan, config) {
  if (!plan || Object.keys(plan).sort().join(',') !== 'after,before,planHash,schemaVersion,targetHash,version' ||
      plan.version !== 1 || plan.schemaVersion !== SCHEMA_VERSION || plan.targetHash !== target(config) ||
      plan.before?.mode !== 'demo' || typeof plan.before.shopName !== 'string' ||
      Object.keys(plan.before).sort().join(',') !== 'mode,shopName' ||
      Object.keys(plan.after || {}).sort().join(',') !== 'mode,shopName' ||
      plan.after.mode !== 'production' || name(plan.after.shopName) !== plan.after.shopName) deny();
  const { planHash, ...body } = plan;
  if (planHash !== digest(body)) deny();
  return plan;
}
async function setup(store) {
  if (await store.schemaVersion() !== SCHEMA_VERSION) deny();
  const row = await store.get('SELECT mode, shop_name FROM shop_setup WHERE id = 1');
  if (!row) deny();
  return { mode: row.mode, shopName: row.shop_name };
}
export async function planShopPromotion(store, config, { expectedMode, expectedName, shopName }) {
  const targetHash = target(config), destination = name(shopName);
  if (expectedMode !== 'demo' || typeof expectedName !== 'string') deny();
  return store.transaction(async () => {
    const before = await setup(store);
    if (before.mode !== expectedMode || before.shopName !== expectedName) deny();
    const body = { version: 1, schemaVersion: SCHEMA_VERSION, targetHash, before,
      after: { mode: 'production', shopName: destination } };
    return { ...body, planHash: digest(body) };
  });
}
export async function applyShopPromotion(store, config, input, approvedHash) {
  const plan = checked(input, config);
  if (approvedHash !== plan.planHash) deny();
  return store.transaction(async () => {
    const current = await setup(store);
    if (JSON.stringify(current) === JSON.stringify(plan.after)) return { planHash: plan.planHash, replayed: true, setup: current };
    if (JSON.stringify(current) !== JSON.stringify(plan.before)) deny();
    // Existing stores serialize writers; retain an explicit compare-and-set as well.
    await store.run('UPDATE shop_setup SET mode = ?, shop_name = ? WHERE id = 1 AND mode = ? AND shop_name = ?',
      plan.after.mode, plan.after.shopName, plan.before.mode, plan.before.shopName);
    const after = await setup(store);
    if (JSON.stringify(after) !== JSON.stringify(plan.after)) deny();
    return { planHash: plan.planHash, replayed: false, setup: after };
  });
}
