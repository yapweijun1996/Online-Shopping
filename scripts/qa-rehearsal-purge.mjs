// Exercise the actual manual purge after a database drop but a role dependency failure, on fictional fixtures only.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { totpCode } from '../src/platform/totp.js';
import { loadRehearsal, proveRehearsalScope, dockerRehearsal, rehearsalProject, createRehearsalClient } from './qa-rehearsal-client.mjs';
const check = (value, message) => { if (!value) throw new Error(message); };
const state = loadRehearsal(); await proveRehearsalScope(state);
const pg = rehearsalProject + '-postgres-1', backend = rehearsalProject + '-backend-1';
const sql = (database, input) => dockerRehearsal(['exec', '-i', pg, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'online_shopping', '-d', database], { input });
const intentFile = join(state.scratch, 'purge-recovery.json');
const save = (value) => { writeFileSync(intentFile + '.new', JSON.stringify(value), { mode: 0o600 }); renameSync(intentFile + '.new', intentFile); };
const rowFor = async (code) => {
  check(/^purgeqa[a-f0-9]{12}$/.test(code), 'Unexpected purge fixture');
  const result = (await sql('platform', `SELECT row_to_json(t) FROM (SELECT id,code,status,revision,database_name,database_role FROM tenant WHERE code='${code}') t;`)).trim();
  return result ? JSON.parse(result) : null;
};
const purge = (intent) => {
  const result = spawnSync('python3', ['deploy/purge-tenant.py', '--code', intent.code, '--confirm', intent.code,
    '--container', pg, '--owner', 'online_shopping', '--env-file', state.env, '--directory', intent.directory],
  { encoding: 'utf8', timeout: 180_000, maxBuffer: 2_000_000 });
  check(!result.error, 'Purge operator deadline or launch failed'); return result.status;
};
const recover = async (intent) => {
  check(/^purge_block_[a-f0-9]{12}$/.test(intent.table), 'Unexpected purge dependency');
  check(intent.directory.startsWith(state.scratch + '/purge-'), 'Unexpected purge archive scope');
  await sql('platform', `DROP TABLE IF EXISTS "${intent.table}";`);
  const row = await rowFor(intent.code);
  if (row?.status === 'DELETING') {
    await sql('platform', `UPDATE tenant SET delete_after='2000-01-01T00:00:00.000Z' WHERE id='${row.id}' AND status='DELETING';`);
    check(purge(intent) === 0, 'Pending fictional purge recovery failed');
  } else if (row?.status === 'SUSPENDED') await platform('/shops/' + row.id + '/resume', { method: 'POST', body: { expectedRevision: row.revision } });
  rmSync(intentFile, { force: true });
};
const admin = createRehearsalClient(state, 'admin');
const platform = (path, options) => admin.call('/api/v1/platform' + path, options);
const password = readFileSync(state.envValues.PLATFORM_ADMIN_PASSWORD_FILE_HOST, 'utf8').trim();
let intent, phase = 'authentication';
try {
  await dockerRehearsal(['exec', '-e', 'NEW_PLATFORM_ADMIN_PASSWORD', backend, 'node', 'scripts/reset-platform-admin.js'], { env: { ...process.env, NEW_PLATFORM_ADMIN_PASSWORD: password } });
  await platform('/csrf'); await platform('/session', { method: 'POST', body: { username: state.envValues.PLATFORM_ADMIN_USERNAME, password } });
  const setup = (await platform('/totp/enrol', { method: 'POST', body: {} })).data;
  await platform('/totp/confirm', { method: 'POST', body: { code: totpCode(setup.setupKey, Math.floor(Date.now() / 30_000)) } });
  if (existsSync(intentFile)) await recover(JSON.parse(readFileSync(intentFile, 'utf8')));
  const suffix = randomBytes(6).toString('hex'), code = 'purgeqa' + suffix;
  phase = 'fictional eligibility';
  const created = (await platform('/shops', { method: 'POST', expected: [201], body: { code, name: 'Fictional purge recovery', currency: 'MYR', sellerUsername: code + '.owner' } })).data;
  const id = created.tenant.id;
  intent = { code, table: 'purge_block_' + suffix, directory: mkdtempSync(join(state.scratch, 'purge-')) }; save(intent);
  let shop = (await platform('/shops/' + id)).data;
  await platform('/shops/' + id + '/suspend', { method: 'POST', body: { expectedRevision: shop.revision } });
  shop = (await platform('/shops/' + id)).data;
  await platform('/shops/' + id + '/request-deletion', { method: 'POST', body: { expectedRevision: shop.revision, code } });
  const row = await rowFor(code);
  check(/^t_[a-z0-9]{3,30}_[a-f0-9]{8}$/.test(row.database_role), 'Unexpected fixture role');
  await sql('platform', `UPDATE tenant SET delete_after='2000-01-01T00:00:00.000Z' WHERE id='${id}' AND status='DELETING'; CREATE TABLE "${intent.table}"(id integer); ALTER TABLE "${intent.table}" OWNER TO "${row.database_role}";`);
  phase = 'close fictional tenant connections';
  await dockerRehearsal(['restart', backend]);
  const deadline = Date.now() + 45_000;
  while (true) {
    try { await platform('/shops'); break; }
    catch { check(Date.now() < deadline, 'Rehearsal backend did not recover'); await new Promise((done) => setTimeout(done, 250)); }
  }
  check((await sql('postgres', `SELECT COUNT(*) FROM pg_stat_activity WHERE datname='${row.database_name}';`)).trim() === '0', 'Fictional tenant still connected');
  phase = 'partial drop'; check(purge(intent) === 1, 'Role dependency did not stop actual purge');
  check((await sql('postgres', `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname='${row.database_name}');`)).trim() === 'f', 'First purge did not drop fixture database');
  check((await rowFor(code)).status === 'DELETING', 'Partial purge incorrectly completed');
  const checkpoint = join(intent.directory, 'purge-' + id + '.json'), checkpointText = readFileSync(checkpoint, 'utf8'), saved = JSON.parse(checkpointText);
  const proof = JSON.parse(readFileSync(saved.backup.evidence, 'utf8'));
  check(proof.restoreVerified, 'Actual final archive not restore verified');
  phase = 'checkpoint retry'; await sql('platform', `DROP TABLE "${intent.table}";`);
  check(purge(intent) === 0, 'Actual checkpoint retry failed');
  check((await rowFor(code)).status === 'PURGED', 'Retry did not persist PURGED');
  check(readFileSync(checkpoint, 'utf8') === checkpointText, 'Purge checkpoint unexpectedly replaced');
  check((await sql('platform', `SELECT COUNT(*) FROM platform_audit WHERE tenant_id='${id}' AND action='TENANT_PURGED';`)).trim() === '1', 'Purge audit missing or duplicated');
  const report = { sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), verifiedAt: new Date().toISOString(),
    actualDatabaseDrop: true, actualRoleDependencyFailure: true, retainedVerifiedArchive: true, checkpointReused: true, retriedPurged: true, auditRows: 1, complete: true };
  writeFileSync('output/qa/multi-tenant/r4-purge-recovery.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  rmSync(intentFile); intent = null; console.log('Actual fictional purge partial-drop retry verified.');
} catch { throw new Error('Purge recovery rehearsal failed during ' + phase + '.'); }
finally { if (intent) await recover(intent); admin.close(); }
