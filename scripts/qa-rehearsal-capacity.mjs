// Twenty-shop capacity proof on the isolated compose stack; never run while production is deploying.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, renameSync, existsSync, statSync } from 'node:fs';
import { homedir, loadavg, availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { totpCode } from '../src/platform/totp.js';
import { loadRehearsal, requireIdleProduction, proveRehearsalScope, dockerRehearsal, rehearsalProject, createRehearsalClient } from './qa-rehearsal-client.mjs';

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const check = (condition, message) => { if (!condition) throw new Error(message); };
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));

export function activeUpdaterHeavyWork(launch, commands, job = 'auto-update') {
  if (!/state = running/.test(launch)) return false;
  if (job === 'backup') return true;
  return commands.some((command) => /(?:\bbuild\b|--backup(?:\s|$)|backup-postgres\.py|upgrade-database\.mjs|upgrade-platform\.mjs|restore-postgres\.py)/.test(command));
}

export async function recoverColdShop(platform, id) {
  check(/^[0-9a-f-]{36}$/.test(id), 'Invalid cold fixture identifier.');
  const shop = (await platform('/shops/' + id)).data;
  check(shop.id === id && !shop.isDefault && ['ACTIVE', 'SUSPENDED'].includes(shop.status), 'Cold fixture cannot be recovered automatically.');
  if (shop.status === 'SUSPENDED') await platform('/shops/' + id + '/resume', { method: 'POST', body: { expectedRevision: shop.revision } });
}

function requireSafeHost() {
  check(loadavg()[0] <= availableParallelism(), 'Host load is too high for capacity work.');
  requireIdleProduction(JSON.parse(readFileSync(join(homedir(), 'Library/Application Support/Online-Shopping/auto-deploy/state.json'), 'utf8')));
  const commandOptions = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 };
  for (const job of ['auto-update', 'backup']) {
    const launch = execFileSync('launchctl', ['print', `gui/${process.getuid()}/com.gmb01.online-shopping.${job}`], commandOptions);
    const pid = /\bpid = (\d+)/.exec(launch)?.[1], commands = [];
    if (pid && job === 'auto-update') {
      const pending = [pid];
      while (pending.length) {
        const current = pending.shift();
        try { commands.push(execFileSync('ps', ['-p', current, '-o', 'command='], commandOptions)); }
        catch (error) { if (error.status === 1) continue; throw new Error('Updater process inspection unavailable.'); }
        try { pending.push(...execFileSync('pgrep', ['-P', current], commandOptions).trim().split(/\s+/).filter(Boolean)); }
        catch (error) { if (error.status !== 1) throw new Error('Updater child inspection unavailable.'); }
      }
    }
    check(!activeUpdaterHeavyWork(launch, commands, job), 'Production updater or backup is doing heavy work.');
  }
}

export async function runCapacity() {
  check(!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), 'Capacity proof requires committed candidate source.');
  const state = loadRehearsal();
  requireSafeHost();
  await proveRehearsalScope(state);
  const privateRun = mkdtempSync(join(state.scratch, 'capacity-'));
  const clients = [], report = { project: rehearsalProject, sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    checks: [], samples: [], peakConnections: 0, requests: 0, errors: 0 };
  let phase = 'fixture authentication', samplePending = null, samplingError = null, timer, cold;
  const admin = createRehearsalClient(state, 'admin'); clients.push(admin);
  const platform = (path, options) => admin.call('/api/v1/platform' + path, options);
  const recoveryFile = join(state.scratch, 'capacity-cold-recovery.json');
  const progress = () => console.log(JSON.stringify({ phase, requests: report.requests, samples: report.samples.length, peakConnections: report.peakConnections }));
  const productionIdle = requireSafeHost;
  const sample = () => {
    if (samplePending || samplingError) return samplePending || Promise.resolve();
    try { productionIdle(); } catch (error) { samplingError = error; return Promise.resolve(); }
    samplePending = dockerRehearsal(['exec', `${rehearsalProject}-postgres-1`, 'psql', '-XqAt', '-U', 'online_shopping', '-d', 'postgres',
      '-c', "SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend';"])
      .then((output) => {
        const count = Number(output.trim()); check(Number.isSafeInteger(count) && count > 0, 'Invalid PostgreSQL connection sample.');
        report.samples.push({ elapsedMs: Date.now() - started, connections: count });
        report.peakConnections = Math.max(report.peakConnections, count);
        check(count <= 80, 'PostgreSQL connection budget exceeded.');
      }).catch((error) => { samplingError = error; }).finally(() => { samplePending = null; });
    return samplePending;
  };
  let started;
  try {
    // Reset only the inspected rehearsal administrator, so this standalone fixture does not persist TOTP keys.
    const password = readFileSync(state.envValues.PLATFORM_ADMIN_PASSWORD_FILE_HOST, 'utf8').trim();
    await dockerRehearsal(['exec', '-e', 'NEW_PLATFORM_ADMIN_PASSWORD', `${rehearsalProject}-backend-1`, 'node', 'scripts/reset-platform-admin.js'],
      { env: { ...process.env, NEW_PLATFORM_ADMIN_PASSWORD: password } });
    await platform('/csrf');
    await platform('/session', { method: 'POST', body: { username: state.envValues.PLATFORM_ADMIN_USERNAME, password } });
    const setup = (await platform('/totp/enrol', { method: 'POST', body: {} })).data;
    await platform('/totp/confirm', { method: 'POST', body: { code: totpCode(setup.setupKey, Math.floor(Date.now() / 30_000)) } });
    if (existsSync(recoveryFile)) {
      check(!(statSync(recoveryFile).mode & 0o077), 'Cold recovery intent must remain private.');
      const prior = JSON.parse(readFileSync(recoveryFile, 'utf8'));
      check(prior.project === rehearsalProject, 'Unexpected cold recovery project.');
      await recoverColdShop(platform, prior.id); rmSync(recoveryFile);
    }
    let shops = (await platform('/shops')).data.items;
    check(shops.filter((shop) => shop.isDefault).length === 1 && shops.every((shop) => shop.status === 'ACTIVE'), 'Capacity fixture requires only ACTIVE shops.');
    phase = 'create twenty-shop fixture';
    for (let number = 1; shops.length < 20 && number <= 40; number++) {
      const code = 'capacity' + String(number).padStart(3, '0');
      if (shops.some((shop) => shop.code === code)) continue;
      productionIdle();
      await platform('/shops', { method: 'POST', expected: [201], body: { code, name: 'Fictional capacity ' + number, currency: 'MYR', sellerUsername: code + '.owner' } });
      shops = (await platform('/shops')).data.items; progress();
    }
    check(shops.length === 20, 'Twenty shops were not provisioned.');
    const limit = await platform('/shops', { method: 'POST', expected: [409], body: { code: 'capacityextra', name: 'Fictional extra shop', currency: 'MYR', sellerUsername: 'capacityextra.owner' } });
    check(limit.data.error?.code === 'TENANT_LIMIT', 'The twenty-first shop was not rejected by capacity.');
    report.checks.push('twenty shops including default; twenty-first refused');

    phase = 'authenticated seller and buyer fixtures';
    const traffic = [];
    for (const shop of shops) {
      const base = shop.isDefault ? '' : '/' + shop.code;
      const seller = createRehearsalClient(state, 'seller', base), buyer = createRehearsalClient(state, 'shop', base); clients.push(seller, buyer);
      let username, temporary;
      if (shop.isDefault) { username = state.envValues.ADMIN_USERNAME; temporary = readFileSync(state.envValues.ADMIN_PASSWORD_FILE_HOST, 'utf8').trim(); }
      else {
        const detail = (await platform('/shops/' + shop.id)).data;
        const reset = await platform('/shops/' + shop.id + '/reset-seller-password', { method: 'POST', body: { expectedRevision: detail.revision } });
        username = detail.sellerUsername; temporary = reset.data.sellerPassword;
      }
      const session = await seller.call('/api/v1/seller/session', { method: 'POST', body: { username, password: temporary } });
      if (session.data.mustChangePassword) {
        const file = join(privateRun, shop.id + '-password');
        writeFileSync(file, execFileSync('openssl', ['rand', '-hex', '24']), { mode: 0o600 });
        await seller.call('/api/v1/seller/account/password', { method: 'POST', body: { currentPassword: temporary, newPassword: readFileSync(file, 'utf8').trim() } });
      }
      await buyer.call('/api/v1/products?limit=10');
      await seller.call('/api/v1/seller/products?limit=10');
      traffic.push({ shop, buyer, seller });
    }
    report.checks.push('buyer and authenticated seller requests work for all twenty shops');
    const maximum = await dockerRehearsal(['exec', `${rehearsalProject}-postgres-1`, 'psql', '-XqAt', '-U', 'online_shopping', '-d', 'postgres', '-c', 'SHOW max_connections;']);
    check(Number(maximum.trim()) === 100, 'Capacity proof requires max_connections 100.');
    started = Date.now(); timer = setInterval(sample, 500); await sample();
    const load = async (entries, durationMs) => {
      const until = Date.now() + durationMs;
      let failed = false;
      const result = await Promise.allSettled(Array.from({ length: 40 }, async (_, index) => {
        let turn = index;
        while (Date.now() < until && !samplingError && !failed) {
          const entry = entries[turn++ % entries.length], seller = index % 2 === 1;
          try { await (seller ? entry.seller : entry.buyer).call(seller ? '/api/v1/seller/products?limit=10' : '/api/v1/products?limit=10'); report.requests++; }
          catch { failed = true; report.errors++; throw new Error('Mixed capacity traffic failed.'); }
          await wait(100);
        }
      }));
      if (result.some((item) => item.status === 'rejected')) throw new Error('Mixed capacity traffic failed.');
      if (samplingError) throw samplingError;
    };
    phase = 'all-twenty concurrent mixed traffic';
    await load(traffic, 60_000); productionIdle(); progress();
    report.checks.push('forty concurrent clients exercised twenty shops');

    phase = 'idle eviction under remaining-shop load';
    cold = traffic.find((entry) => !entry.shop.isDefault); check(cold, 'Non-default cold shop missing.');
    const original = (await cold.buyer.call('/api/v1/products?limit=10')).data;
    const detail = (await platform('/shops/' + cold.shop.id)).data;
    writeFileSync(recoveryFile, JSON.stringify({ project: rehearsalProject, id: cold.shop.id }), { mode: 0o600 });
    const suspended = await platform('/shops/' + cold.shop.id + '/suspend', { method: 'POST', body: { expectedRevision: detail.revision } });
    cold.revision = suspended.data.tenant.revision;
    // ACTIVE workers poll every 15 s. Suspension skips that worker, allowing the real five-minute idle timer to expire.
    for (let part = 0; part < 12; part++) { await load(traffic.filter((entry) => entry !== cold), 30_000); productionIdle(); progress(); }
    const status = (await platform('/status')).data;
    check(status.poolSize <= 18, 'Suspended idle shop pool did not evict.');
    check(/^[0-9a-f-]{36}$/.test(cold.shop.id), 'Invalid cold fixture identifier.');
    const coldConnections = await dockerRehearsal(['exec', '-i', `${rehearsalProject}-postgres-1`, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1',
      '-v', 'cold_id=' + cold.shop.id, '-U', 'online_shopping', '-d', 'platform'],
      { input: "SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend' AND datname=(SELECT database_name FROM tenant WHERE id=:'cold_id');\n" });
    check(Number(coldConnections.trim()) === 0, 'Idle shop database connections remain open.');
    await platform('/shops/' + cold.shop.id + '/resume', { method: 'POST', body: { expectedRevision: cold.revision } });
    rmSync(recoveryFile); cold = null;
    const reopened = traffic.find((entry) => entry.shop.id === detail.id);
    const after = (await reopened.buyer.call('/api/v1/products?limit=10')).data;
    check(JSON.stringify(after) === JSON.stringify(original), 'Reopened route did not retain the catalog result.');
    await reopened.seller.call('/api/v1/seller/products?limit=10');
    report.checks.push('idle pool removed its connections; resumed buyer/seller routes reopened with unchanged catalog');
    await sample(); check(!samplingError && report.samples.length > 100 && report.errors === 0, 'Capacity evidence incomplete.');
    report.elapsedMs = Date.now() - started; report.maxConnections = 100;
    report.verifiedAt = new Date().toISOString();
    const output = join(root, 'output/qa/multi-tenant'), name = 'r4-capacity-' + report.sourceSha.slice(0, 12) + '-' + Date.now() + '.json';
    writeFileSync(join(output, name), JSON.stringify(report, null, 2), { mode: 0o600 });
    writeFileSync(join(output, '.capacity-current.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    renameSync(join(output, '.capacity-current.json'), join(output, 'r4-capacity.json'));
    phase = 'verified'; progress(); return report;
  } catch (error) {
    throw new Error('Capacity rehearsal failed during ' + phase + ' (' + (error?.name || 'Error') + ').');
  } finally {
    clearInterval(timer); await samplePending;
    if (cold) {
      try { await recoverColdShop(platform, cold.shop.id); rmSync(recoveryFile, { force: true }); }
      catch { console.error('Rehearsal cold shop still needs recovery.'); }
    }
    for (const client of clients) client.close();
    rmSync(privateRun, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCapacity().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
