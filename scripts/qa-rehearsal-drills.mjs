// Real fault injection against only the inspected, private compose rehearsal.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { totpCode } from '../src/platform/totp.js';
import { loadRehearsal, proveRehearsalScope, dockerRehearsal, rehearsalProject, createRehearsalClient } from './qa-rehearsal-client.mjs';
const check = (value, message) => { if (!value) throw new Error(message); };
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const state = loadRehearsal(); await proveRehearsalScope(state);
const pg = rehearsalProject + '-postgres-1', backend = rehearsalProject + '-backend-1';
const intentFile = join(state.scratch, 'drill-recovery.json');
let intent = existsSync(intentFile) ? JSON.parse(readFileSync(intentFile, 'utf8')) : { project: rehearsalProject };
check(intent.project === rehearsalProject, 'Unexpected drill recovery scope');
const save = () => { const path = intentFile + '.new'; writeFileSync(path, JSON.stringify(intent), { mode: 0o600 }); renameSync(path, intentFile); };
const sql = (database, text) => dockerRehearsal(['exec', '-i', pg, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'online_shopping', '-d', database], { input: text });
const databaseName = (name) => { check(/^(?:platform|t_[a-z0-9]{3,30}_[a-f0-9]{8})$/.test(name), 'Unexpected drill database'); return '"' + name + '"'; };
const recover = async () => {
  if (intent.database) { await sql('postgres', 'ALTER DATABASE ' + databaseName(intent.database) + ' ALLOW_CONNECTIONS true;'); delete intent.database; save(); }
  if (intent.backendStopped) { await dockerRehearsal(['start', backend]); delete intent.backendStopped; save(); }
  if (intent.provisionerCode) {
    check(/^drillkill[a-z0-9]+$/.test(intent.provisionerCode), 'Unexpected provisioner operation');
    // The exact operation is durable before launch, so an unknown PID/launch outcome is also recoverable.
    await dockerRehearsal(['exec', backend, 'node', '-e', `const fs=require('fs');for(const n of fs.readdirSync('/proc')){if(!/^[0-9]+$/.test(n)||Number(n)<=1)continue;try{const a=fs.readFileSync('/proc/'+n+'/cmdline','utf8').split('\\0');if(a[1]==='scripts/qa-rehearsal-provisioner.mjs'&&a[2]==='${intent.provisionerCode}')process.kill(Number(n),'SIGKILL')}catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')process.exit(1)}}`]);
    delete intent.provisionerCode; delete intent.provisionerPid; save();
  }
  if (intent.lockName) {
    check(/^mt-qa-lock-[a-f0-9]{12}$/.test(intent.lockName), 'Unexpected lock operation');
    await sql('postgres', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='${intent.lockName}';`);
    delete intent.lockName; delete intent.lockPid; save();
  }
  if (intent.paused) { await maintenance(false); delete intent.paused; save(); }
};
async function maintenance(enabled) {
  await dockerRehearsal(['run', '--rm', '--user', '0', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--network', rehearsalProject + '_private', '-v', rehearsalProject + '_deployment_state:/run/deployment',
    '-v', process.cwd() + '/src:/app/src:ro', '-v', process.cwd() + '/scripts/deployment-maintenance.mjs:/app/scripts/deployment-maintenance.mjs:ro',
    '-e', 'DEPLOYMENT_STATE_DIR=/run/deployment', '-e', 'MAINTENANCE_HEALTH_URL=http://backend:3000/health', '--entrypoint', 'node', state.backendImage,
    '/app/scripts/deployment-maintenance.mjs', enabled ? 'enter' : 'exit'], { timeout: 210_000 });
}
await recover(); await proveRehearsalScope(state);
const clients = [];
const client = (surface, base = '') => { const value = createRehearsalClient(state, surface, base); clients.push(value); return value; };
const admin = client('admin'), defaultBuyer = client('shop');
const platform = (path, options) => admin.call('/api/v1/platform' + path, options);
const password = readFileSync(state.envValues.PLATFORM_ADMIN_PASSWORD_FILE_HOST, 'utf8').trim();
await dockerRehearsal(['exec', '-e', 'NEW_PLATFORM_ADMIN_PASSWORD', backend, 'node', 'scripts/reset-platform-admin.js'], { env: { ...process.env, NEW_PLATFORM_ADMIN_PASSWORD: password } });
await platform('/csrf'); await platform('/session', { method: 'POST', body: { username: state.envValues.PLATFORM_ADMIN_USERNAME, password } });
const setup = (await platform('/totp/enrol', { method: 'POST', body: {} })).data;
await platform('/totp/confirm', { method: 'POST', body: { code: totpCode(setup.setupKey, Math.floor(Date.now() / 30_000)) } });
const report = { project: rehearsalProject, sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), checks: [] };
const until = async (work, timeout = 45_000) => { const end = Date.now() + timeout; while (Date.now() < end) { const result = await work(); if (result) return result; await wait(200); } throw new Error('Drill observation deadline'); };
const rowFor = async (code) => { check(/^[a-z0-9]{3,30}$/.test(code), 'Unexpected drill code'); const text = (await sql('platform', `SELECT row_to_json(t) FROM (SELECT id,status,revision,database_name,database_role FROM tenant WHERE code='${code}') t;`)).trim(); return text ? JSON.parse(text) : null; };
const healthyDefault = async () => { await defaultBuyer.call('/ready'); await defaultBuyer.call('/api/v1/products?limit=10'); };
async function holdCreateDatabase() {
  intent.lockName = 'mt-qa-lock-' + randomBytes(6).toString('hex'); save();
  const child = spawn('docker', ['--context', 'orbstack', 'exec', '-i', pg, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'online_shopping', '-d', 'postgres'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  const pid = new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Catalog lock unavailable')), 15_000);
    lines.once('line', (line) => { clearTimeout(timer); const value = Number(line); if (Number.isInteger(value) && value > 0) done(value); else reject(new Error('Invalid catalog lock PID')); });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Catalog lock process failed')); });
  });
  child.stdin.write(`SET application_name='${intent.lockName}'; BEGIN; SET LOCAL idle_in_transaction_session_timeout='60s'; LOCK TABLE pg_database IN SHARE MODE; SELECT pg_backend_pid();\n`);
  try { intent.lockPid = await pid; save(); }
  catch (error) { child.stdin.end('ROLLBACK;\n\\q\n'); throw error; }
  return async () => { child.stdin.end('ROLLBACK;\n\\q\n'); await recover(); lines.close(); };
}
const input = (code) => ({ code, name: 'Fictional ' + code, currency: 'MYR', sellerUsername: code + '.owner' });
const create = (code) => platform('/shops', { method: 'POST', expected: [201, 409], body: input(code) });
const suffix = randomBytes(3).toString('hex'); let phase = 'shop database outage', releaseLock;
try {
  let shop = (await platform('/shops')).data.items.find((row) => !row.isDefault && row.status === 'ACTIVE'); check(shop, 'Active fictional shop missing');
  const row = await rowFor(shop.code), buyer = client('shop', '/' + shop.code);
  await buyer.call('/api/v1/products?limit=10');
  intent.database = row.database_name; save();
  await sql('postgres', 'ALTER DATABASE ' + databaseName(row.database_name) + ' ALLOW_CONNECTIONS false;');
  await sql('postgres', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${row.database_name}' AND pid<>pg_backend_pid();`);
  const outage = await buyer.call('/api/v1/products?limit=10', { expected: [500, 503] }); check(!JSON.stringify(outage.data).includes('postgres'), 'Database internals leaked'); await healthyDefault();
  await recover(); await until(async () => { try { await buyer.call('/api/v1/products?limit=10'); return true; } catch { return false; } });
  report.checks.push({ drill: 'one shop database down', status: outage.status, legacyUnaffected: true, recovered: true });

  phase = 'platform database outage'; intent.database = 'platform'; save();
  await sql('postgres', 'ALTER DATABASE platform ALLOW_CONNECTIONS false;'); await sql('postgres', "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='platform' AND pid<>pg_backend_pid();");
  const platformOutage = await platform('/session', { expected: [503] }); check(platformOutage.data.error?.code === 'PLATFORM_UNAVAILABLE', 'Platform outage response incorrect'); await healthyDefault();
  await recover(); await until(async () => { try { await platform('/shops'); return true; } catch { return false; } });
  report.checks.push({ drill: 'platform database down', legacyUnaffected: true, recovered: true });

  phase = 'concurrent same-code create'; const raceCode = 'drillrace' + suffix;
  const results = await Promise.all([create(raceCode), create(raceCode)]);
  check(results.map((row) => row.status).sort().join(',') === '201,409', 'Concurrent creation did not produce exactly one winner');
  check((await rowFor(raceCode)).status === 'ACTIVE', 'Concurrent winner not active'); report.checks.push({ drill: 'concurrent same-code creates', winners: 1, conflicts: 1 });

  phase = 'provisioner killed midway'; intent.paused = true; save(); await maintenance(true); releaseLock = await holdCreateDatabase();
  const killCode = 'drillkill' + suffix; intent.provisionerCode = killCode; save();
  const runner = spawn('docker', ['--context', 'orbstack', 'exec', '-e', 'QA_REHEARSAL=1', backend, 'node', 'scripts/qa-rehearsal-provisioner.mjs', killCode], { stdio: ['ignore', 'pipe', 'ignore'] });
  const processLines = createInterface({ input: runner.stdout });
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Provisioner PID unavailable')), 10_000);
    processLines.once('line', (line) => { clearTimeout(timer); try { const pid = JSON.parse(line).pid; check(Number.isInteger(pid) && pid > 1, 'Invalid provisioner PID'); intent.provisionerPid = pid; save(); done(); } catch { reject(new Error('Invalid provisioner PID')); } });
    runner.once('error', () => { clearTimeout(timer); reject(new Error('Provisioner launch failed')); });
  });
  await until(async () => { const reserved = await rowFor(killCode); if (!reserved || reserved.status !== 'PROVISIONING') return false; return (await sql('postgres', "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='platform_provisioner' AND wait_event_type='Lock');")).trim() === 't'; }, 15_000);
  await recover(); await releaseLock(); releaseLock = null; processLines.close();
  await until(async () => (await rowFor(killCode))?.status === 'FAILED');
  check((await create(killCode)).status === 201, 'Killed provisioner did not recover on retry');
  report.checks.push({ drill: 'provisioner killed midway', durableReservation: true, catalogWriterBlocked: true, interruptedFailed: true, retriedActive: true });

  phase = 'backend restart during creation'; releaseLock = await holdCreateDatabase(); const restartCode = 'drillrestart' + suffix;
  const pendingCreate = create(restartCode).then((row) => ({ status: row.status }), () => ({ disconnected: true }));
  await until(async () => { const reserved = await rowFor(restartCode); if (!reserved || reserved.status !== 'PROVISIONING') return false; return (await sql('postgres', "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='platform_provisioner' AND wait_event_type='Lock');")).trim() === 't'; }, 15_000);
  intent.backendStopped = true; save(); await dockerRehearsal(['kill', '--signal', 'KILL', backend]);
  await releaseLock(); releaseLock = null; await recover();
  check((await pendingCreate).disconnected, 'Interrupted create unexpectedly completed');
  await until(async () => { try { await healthyDefault(); return true; } catch { return false; } });
  await until(async () => (await rowFor(restartCode))?.status === 'FAILED');
  check((await create(restartCode)).status === 201, 'Backend restart creation did not recover on retry');
  report.checks.push({ drill: 'backend restart during creation', durableReservation: true, disconnected: true, interruptedFailed: true, retriedActive: true });
  await healthyDefault(); await proveRehearsalScope(state);
  report.verifiedAt = new Date().toISOString(); report.complete = true;
  writeFileSync('output/qa/multi-tenant/r4-failure-drills.json', JSON.stringify(report, null, 2), { mode: 0o600 }); rmSync(intentFile);
  console.log('Five real rehearsal failure drills verified.');
} catch { throw new Error('Failure rehearsal failed during ' + phase + '.'); }
finally { if (releaseLock) await releaseLock(); await recover(); for (const value of clients) value.close(); }
