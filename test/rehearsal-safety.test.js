import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rehearsalProject, validateRehearsalFiles, validateRehearsalContainers, requireIdleProduction, createRehearsalClient } from '../scripts/qa-rehearsal-client.mjs';
import { activeUpdaterHeavyWork, recoverColdShop } from '../scripts/qa-rehearsal-capacity.mjs';

function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'online-shopping-mt-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const scratch = join(parent, 'rehearsal'); mkdirSync(scratch, { mode: 0o700 });
  const port = 61000, env = join(scratch, 'fixture.env'), override = join(scratch, 'override.json');
  const values = { PLATFORM_ENABLED: '1', PLATFORM_ADMIN_HOST: 'admin.gmb01.xyz:' + port };
  for (const name of ['ADMIN_PASSWORD', 'DATABASE_PASSWORD', 'DATABASE_OWNER_PASSWORD', 'INTEGRATION_KEY',
    'PLATFORM_DATABASE_PASSWORD', 'PLATFORM_PROVISIONER_PASSWORD', 'PLATFORM_ADMIN_PASSWORD', 'TUNNEL_CREDENTIALS', 'TUNNEL_ADMIN_CREDENTIALS']) {
    values[name + '_FILE_HOST'] = join(scratch, name);
    writeFileSync(values[name + '_FILE_HOST'], name.startsWith('TUNNEL_') ? '{}' : 'fictional fixture', { mode: 0o600 });
  }
  const writeEnv = () => writeFileSync(env, Object.entries(values).map(([name, value]) => name + '=' + value).join('\n'), { mode: 0o600 });
  writeEnv();
  const disabled = { profiles: ['disabled'], deploy: { replicas: 0 } };
  writeFileSync(override, JSON.stringify({ services: { tunnel: disabled, 'tunnel-admin': disabled } }), { mode: 0o600 });
  return { state: { project: rehearsalProject, scratch, port, env, override }, environment: { scratch: parent }, values, writeEnv, parent };
}

function containers(state) {
  const secrets = {
    backend: { admin_password: 'ADMIN_PASSWORD_FILE_HOST', database_password: 'DATABASE_PASSWORD_FILE_HOST', integration_keys: 'INTEGRATION_KEY_FILE_HOST',
      platform: 'PLATFORM_DATABASE_PASSWORD_FILE_HOST', provisioner: 'PLATFORM_PROVISIONER_PASSWORD_FILE_HOST', platform_admin: 'PLATFORM_ADMIN_PASSWORD_FILE_HOST' },
    frontend: {}, postgres: { database_password: 'DATABASE_PASSWORD_FILE_HOST', database_owner_password: 'DATABASE_OWNER_PASSWORD_FILE_HOST' },
  };
  return ['backend', 'frontend', 'postgres'].map((name) => ({ Name: '/' + rehearsalProject + '-' + name + '-1',
    Config: { Labels: { 'com.docker.compose.project': rehearsalProject } }, State: { Running: true },
    NetworkSettings: { Networks: { [rehearsalProject + '_private']: {} }, Ports: name === 'frontend' ? {
      '443/tcp': [{ HostIp: '127.0.0.1', HostPort: String(state.port) }] } : {} },
    Mounts: [...Object.entries(secrets[name]).map(([secret, key]) => ({ Type: 'bind', Destination: '/run/secrets/' + secret,
      Source: state.envValues[key], RW: false })), ...(name === 'postgres' ? [{ Type: 'volume', Destination: '/var/lib/postgresql/data', Name: rehearsalProject + '_pg_data' }] : [])],
  }));
}

test('rehearsal scope rejects production project, escaped private secrets, real tunnel credentials and public files', (t) => {
  const f = fixture(t);
  assert.equal(validateRehearsalFiles(f.state, f.environment).scratch, realpathSync(f.state.scratch));
  assert.throws(() => validateRehearsalFiles({ ...f.state, project: 'online-shopping-production' }, f.environment), /project/);
  const outside = join(f.parent, 'outside-secret'); writeFileSync(outside, 'fictional', { mode: 0o600 });
  f.values.ADMIN_PASSWORD_FILE_HOST = outside; f.writeEnv();
  assert.throws(() => validateRehearsalFiles(f.state, f.environment), /escaped/);
  const link = join(f.state.scratch, 'secret-link'); symlinkSync(outside, link);
  f.values.ADMIN_PASSWORD_FILE_HOST = link; f.writeEnv();
  assert.throws(() => validateRehearsalFiles(f.state, f.environment), /escaped/);
  f.values.ADMIN_PASSWORD_FILE_HOST = join(f.state.scratch, 'ADMIN_PASSWORD'); f.writeEnv();
  writeFileSync(f.values.TUNNEL_CREDENTIALS_FILE_HOST, '{"TunnelID":"fictional-real-format"}');
  assert.throws(() => validateRehearsalFiles(f.state, f.environment), /Real tunnel/);
  writeFileSync(f.values.TUNNEL_CREDENTIALS_FILE_HOST, '{}'); chmodSync(f.state.env, 0o644);
  assert.throws(() => validateRehearsalFiles(f.state, f.environment), /private/);
});

test('actual container inspection rejects production storage, network, secret mounts, extra tunnels and non-loopback listeners', (t) => {
  const f = fixture(t), state = validateRehearsalFiles(f.state, f.environment);
  validateRehearsalContainers(state, containers(state));
  const volume = containers(state); volume[2].Mounts.at(-1).Name = 'online-shopping-production_pg_data';
  assert.throws(() => validateRehearsalContainers(state, volume), /own volume/);
  const secret = containers(state); secret[0].Mounts[0].Source = f.state.env;
  assert.throws(() => validateRehearsalContainers(state, secret), /fixture secrets/);
  const network = containers(state); network[0].NetworkSettings.Networks = { 'online-shopping-production_private': {} };
  assert.throws(() => validateRehearsalContainers(state, network), /networks/);
  const publicPort = containers(state); publicPort[1].NetworkSettings.Ports['443/tcp'][0].HostIp = '0.0.0.0';
  assert.throws(() => validateRehearsalContainers(state, publicPort), /loopback/);
  assert.throws(() => validateRehearsalContainers(state, [...containers(state), { Name: '/' + rehearsalProject + '-tunnel-1' }]), /three/);
});

test('capacity refuses pending or failed production deployment and detects an updater backup between polls', () => {
  requireIdleProduction({ last_status: 'up_to_date', pending: null });
  for (const state of [{ last_status: 'check_failed' }, { last_status: 'up_to_date', pending: {} },
    { last_status: 'up_to_date', migration: {} }, { last_status: 'up_to_date', maintenance_resume: {} }]) assert.throws(() => requireIdleProduction(state), /idle/);
  assert.equal(activeUpdaterHeavyWork('state = running', ['python3 auto-update.py --backup']), true);
  assert.equal(activeUpdaterHeavyWork('state = running', ['docker compose -p online-shopping-production build backend']), true);
  assert.equal(activeUpdaterHeavyWork('state = running', ['python3 auto-update.py', 'git ls-remote origin main']), false);
  assert.equal(activeUpdaterHeavyWork('state = not running', ['docker compose build']), false);
  assert.equal(activeUpdaterHeavyWork('state = running', [], 'backup'), true);
  assert.equal(activeUpdaterHeavyWork('state = not running', [], 'backup'), false);
});

test('rehearsal HTTP client cannot select a production project or an absolute external URL', async () => {
  const state = { project: rehearsalProject, port: 61000 };
  assert.throws(() => createRehearsalClient({ ...state, project: 'online-shopping-production' }, 'admin'), /origin/);
  assert.throws(() => createRehearsalClient(state, 'admin', '/alpha'), /origin/);
  const client = createRehearsalClient(state, 'shop', '/alpha');
  try {
    await assert.rejects(client.call('https://shop.gmb01.xyz/api/v1/products'), /path/);
    await assert.rejects(client.call('/api/v1/products\r\nHost: example.test'), /path/);
  } finally { client.close(); }
});

test('lost suspend response recovery reads the committed revision, leaves ACTIVE shops alone and refuses default/deleting shops', async () => {
  const id = '00000000-0000-4000-8000-000000000001', calls = [];
  await recoverColdShop(async (path, options) => {
    calls.push({ path, options }); return { data: { id, isDefault: false, status: 'SUSPENDED', revision: 9 } };
  }, id);
  assert.equal(calls[1].path, '/shops/' + id + '/resume'); assert.equal(calls[1].options.body.expectedRevision, 9);
  let mutations = 0;
  await recoverColdShop(async (path, options) => {
    if (options) mutations++; return { data: { id, isDefault: false, status: 'ACTIVE', revision: 10 } };
  }, id);
  assert.equal(mutations, 0);
  for (const row of [{ isDefault: true, status: 'SUSPENDED' }, { isDefault: false, status: 'DELETING' }]) {
    await assert.rejects(recoverColdShop(async () => ({ data: { id, ...row } }), id), /cannot be recovered/);
  }
});
