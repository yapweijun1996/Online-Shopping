import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openNodeStore } from './store.js';
import { openPostgresStore } from './postgres-store.js';
import { planShopPromotion, applyShopPromotion } from './shop-promotion.js';

const invalid = () => { throw new Error('Invalid promotion invocation.'); };
export function parsePromotionArguments(args) {
  const [action, ...rest] = args;
  if (!['plan', 'apply'].includes(action)) invalid();
  const options = {};
  const allowed = action === 'plan' ? ['expected-mode', 'expected-name', 'shop-name'] : ['plan-file', 'approve', 'receipt', 'backup-reference', 'writers-stopped'];
  for (const value of rest) {
    const match = /^--([a-z-]+)=(.+)$/.exec(value);
    if (!match || !allowed.includes(match[1]) || Object.hasOwn(options, match[1])) invalid();
    options[match[1]] = match[2];
  }
  if (allowed.some(key => !Object.hasOwn(options, key))) invalid();
  if (action === 'apply' && (options['writers-stopped'] !== 'yes' || !/^[a-f0-9]{64}$/.test(options.approve) ||
      !/^[A-Za-z0-9._:/-]{1,200}$/.test(options['backup-reference']))) invalid();
  return { action, options };
}
async function privateDirectory(file) {
  if (!path.isAbsolute(file) || file !== path.resolve(file)) invalid();
  const repository = path.resolve(import.meta.dirname, '..');
  if (file === repository || file.startsWith(repository + path.sep)) invalid();
  // Resolve every path component without traversing a symlink.
  let current = path.parse(file).root;
  for (const part of path.dirname(file).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!(await lstat(current)).isDirectory() || (await lstat(current)).isSymbolicLink()) invalid();
  }
  const stat = await lstat(path.dirname(file));
  if (stat.uid !== process.getuid() || (stat.mode & 0o077)) invalid();
}
async function privateJson(file) {
  await privateDirectory(file);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 8192) invalid();
  return JSON.parse(await readFile(file, 'utf8'));
}
async function writeJournal(file, value, replace = false) {
  const temporary = replace ? file + '.' + randomUUID() : file;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
  if (replace) {
    try { await rename(temporary, file); } catch (error) { await unlink(temporary); throw error; }
  }
  const directory = await open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
// The caller must stop all writers and verify a restorable backup first. These
// explicit references are operator attestations, not automated backup proofs.
export async function runShopPromotion({ config, action, options }, dependencies = {}) {
  const openStore = dependencies.openStore ?? (async () => {
    if (config.databaseUrl) return openPostgresStore(config.databaseUrl, { max: 1 });
    if (!(await lstat(config.dbPath)).isFile()) invalid();
    return openNodeStore(config.dbPath);
  });
  let plan;
  const receipt = options.receipt;
  if (action === 'apply') {
    plan = await privateJson(options['plan-file']);
    if (plan.planHash !== options.approve) invalid();
    await privateDirectory(receipt);
    // A crash after DB commit leaves a PREPARED journal. An exact retry can
    // recover it; another plan or backup reference cannot overwrite it.
    const journal = { version: 1, planHash: plan.planHash, backupReference: options['backup-reference'] };
    try { await writeJournal(receipt, { ...journal, status: 'PREPARED', at: new Date().toISOString() }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await privateJson(receipt);
      if (previous.version !== 1 || previous.planHash !== journal.planHash || previous.backupReference !== journal.backupReference ||
          !['PREPARED', 'APPLIED'].includes(previous.status)) invalid();
    }
  }
  const store = await openStore();
  try {
    if (action === 'plan') return await planShopPromotion(store, config, {
      expectedMode: options['expected-mode'], expectedName: options['expected-name'], shopName: options['shop-name'],
    });
    const result = await applyShopPromotion(store, config, plan, options.approve);
    await writeJournal(receipt, { version: 1, status: 'APPLIED', at: new Date().toISOString(),
      planHash: plan.planHash, backupReference: options['backup-reference'], ...result }, true);
    return { ...result, receipt };
  } finally { await store.close(); }
}
