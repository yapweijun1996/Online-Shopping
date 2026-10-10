// Private rehearsal requests always connect to loopback; no production origin can be selected.
import https from 'node:https';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const rehearsalProject = 'online-shopping-rehearsal';
const execute = promisify(execFile);
const inside = (path, parent) => path.startsWith(parent + sep);
const requirePrivate = (path) => {
  if (statSync(path).mode & 0o077) throw new Error('Rehearsal files must remain private.');
};

export function validateRehearsalFiles(state, environment) {
  if (state.project !== rehearsalProject || !Number.isInteger(state.port) || state.port < 1024 || state.port > 65535) {
    throw new Error('Unexpected rehearsal project or loopback port.');
  }
  const parent = realpathSync(environment.scratch), scratch = realpathSync(state.scratch);
  if (!/online-shopping-mt-[^/]+$/.test(parent) || !inside(scratch, parent)) throw new Error('Unexpected rehearsal scratch scope.');
  requirePrivate(parent); requirePrivate(scratch);
  for (const file of [state.env, state.override]) {
    if (!inside(realpathSync(file), scratch)) throw new Error('Rehearsal configuration escaped scratch scope.');
    requirePrivate(file);
  }
  const env = Object.fromEntries(readFileSync(state.env, 'utf8').split(/\r?\n/).filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  if (env.PLATFORM_ADMIN_HOST !== `admin.gmb01.xyz:${state.port}` || env.PLATFORM_ENABLED !== '1') {
    throw new Error('Unexpected rehearsal admin origin.');
  }
  for (const [name, value] of Object.entries(env)) {
    if (!name.endsWith('_FILE_HOST')) continue;
    if (!inside(realpathSync(value), scratch)) throw new Error('Rehearsal secret escaped scratch scope.');
    requirePrivate(value);
  }
  const override = JSON.parse(readFileSync(state.override, 'utf8'));
  for (const name of ['tunnel', 'tunnel-admin']) {
    if (!override.services?.[name]?.profiles?.includes('disabled') || override.services[name].deploy?.replicas !== 0) {
      throw new Error('Both rehearsal tunnels must be disabled.');
    }
  }
  for (const name of ['TUNNEL_CREDENTIALS_FILE_HOST', 'TUNNEL_ADMIN_CREDENTIALS_FILE_HOST']) {
    if (!env[name] || readFileSync(env[name], 'utf8').trim() !== '{}') throw new Error('Real tunnel credentials are forbidden.');
  }
  return { ...state, scratch, envValues: env };
}

export function loadRehearsal() {
  return validateRehearsalFiles(JSON.parse(readFileSync(resolve(root, 'output/qa/multi-tenant/rehearsal.json'), 'utf8')),
    JSON.parse(readFileSync(resolve(root, 'output/qa/multi-tenant/environment.json'), 'utf8')));
}

export function requireIdleProduction(state) {
  if (state.last_status !== 'up_to_date' || state.pending || state.migration || state.maintenance_resume) {
    throw new Error('Production updater must be idle and up_to_date before heavy rehearsal work.');
  }
}

export function validateRehearsalContainers(state, containers) {
  if (containers.length !== 3) throw new Error('Capacity work requires only the three rehearsal application containers.');
  for (const service of ['backend', 'frontend', 'postgres']) {
    const row = containers.find((item) => item.Name === `/${rehearsalProject}-${service}-1`);
    if (!row || row.Config?.Labels?.['com.docker.compose.project'] !== rehearsalProject || !row.State?.Running) {
      throw new Error('Unexpected rehearsal container scope.');
    }
    if (service === 'postgres' && !row.Mounts?.some((mount) => mount.Destination === '/var/lib/postgresql/data' &&
        mount.Type === 'volume' && mount.Name === `${rehearsalProject}_pg_data`)) {
      throw new Error('Rehearsal PostgreSQL must use its own volume.');
    }
    if (!Object.keys(row.NetworkSettings?.Networks || {}).length ||
        Object.keys(row.NetworkSettings.Networks).some((name) => !name.startsWith(rehearsalProject + '_')) ||
        row.Mounts?.some((mount) => mount.Type === 'volume' && !mount.Name.startsWith(rehearsalProject + '_'))) {
      throw new Error('Rehearsal containers must use only project networks and volumes.');
    }
    const secretNames = service === 'backend' ? { admin_password: 'ADMIN_PASSWORD_FILE_HOST', database_password: 'DATABASE_PASSWORD_FILE_HOST',
      integration_keys: 'INTEGRATION_KEY_FILE_HOST', platform: 'PLATFORM_DATABASE_PASSWORD_FILE_HOST', provisioner: 'PLATFORM_PROVISIONER_PASSWORD_FILE_HOST',
      platform_admin: 'PLATFORM_ADMIN_PASSWORD_FILE_HOST' } : service === 'postgres' ? {
      database_password: 'DATABASE_PASSWORD_FILE_HOST', database_owner_password: 'DATABASE_OWNER_PASSWORD_FILE_HOST' } : {};
    const mounts = row.Mounts?.filter((mount) => mount.Destination.startsWith('/run/secrets/')) || [];
    if (mounts.length !== Object.keys(secretNames).length || Object.entries(secretNames).some(([name, key]) =>
      !mounts.some((mount) => mount.Destination === '/run/secrets/' + name && mount.Type === 'bind' && mount.RW === false &&
        state.envValues[key] && realpathSync(mount.Source) === realpathSync(state.envValues[key])))) {
      throw new Error('Rehearsal containers must mount only the private fixture secrets.');
    }
    if (service === 'frontend') {
      const bindings = Object.values(row.NetworkSettings?.Ports || {}).flatMap((value) => value || []);
      if (bindings.length !== 1 || bindings[0].HostIp !== '127.0.0.1' || Number(bindings[0].HostPort) !== state.port) {
        throw new Error('Rehearsal frontend must expose only its selected loopback port.');
      }
    }
  }
}

export async function dockerRehearsal(args, options = {}) {
  try {
    const { input, ...settings } = options;
    const pending = execute('docker', ['--context', 'orbstack', ...args], { timeout: 30_000, maxBuffer: 2_000_000, ...settings });
    if (input !== undefined) pending.child.stdin.end(input);
    return (await pending).stdout;
  } catch { throw new Error('Rehearsal Docker operation failed.'); }
}

export async function proveRehearsalScope(state) {
  const ids = (await dockerRehearsal(['ps', '-q', '--filter', 'label=com.docker.compose.project=' + rehearsalProject])).trim().split(/\s+/).filter(Boolean);
  if (ids.length !== 3 || ids.some((id) => !/^[0-9a-f]{12,64}$/.test(id))) throw new Error('Unexpected running rehearsal services.');
  const containers = JSON.parse(await dockerRehearsal(['inspect', ...ids]));
  validateRehearsalContainers(state, containers);
}

export function createRehearsalClient(state, surface, base = '') {
  if (state.project !== rehearsalProject || !Number.isInteger(state.port) || state.port < 1024 || state.port > 65535 ||
      !['shop', 'seller', 'admin'].includes(surface) || (base && !/^\/[a-z0-9]{3,30}$/.test(base)) || (surface === 'admin' && base)) {
    throw new Error('Unexpected rehearsal client origin.');
  }
  const host = surface + '.gmb01.xyz', origin = `https://${host}:${state.port}`;
  const agent = new https.Agent({ keepAlive: true, maxSockets: 8, rejectUnauthorized: false });
  const cookies = new Map(); let csrf = null;
  return {
    close: () => { cookies.clear(); csrf = null; agent.destroy(); },
    async call(path, { method = 'GET', body, expected = [200] } = {}) {
      if (!/^\/(?:api\/v1\/|health$|ready$)/.test(path) || path.includes('://') || /[\r\n]/.test(path)) throw new Error('Unexpected rehearsal request path.');
      const payload = body === undefined ? undefined : JSON.stringify(body), target = base + path;
      const value = await new Promise((resolveResult, reject) => {
        const request = https.request({ hostname: '127.0.0.1', port: state.port, servername: host, path: target, method, agent,
          headers: { host: `${host}:${state.port}`, origin, 'cache-control': 'no-store',
            cookie: [...cookies].filter(([, item]) => target.startsWith(item.path)).map(([name, item]) => name + '=' + item.value).join('; '),
            ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
            ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }) } }, (response) => {
          let length = 0; const chunks = [];
          response.on('data', (chunk) => { length += chunk.length; if (length > 2_000_000) request.destroy(); else chunks.push(chunk); });
          response.on('error', () => reject(new Error('Rehearsal response failed.')));
          response.on('end', () => resolveResult({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
        });
        request.setTimeout(60_000, () => request.destroy());
        request.on('error', () => reject(new Error('Rehearsal request failed.')));
        request.end(payload);
      });
      for (const header of value.headers['set-cookie'] || []) {
        const [pair, ...attributes] = header.split(';'), split = pair.indexOf('=');
        const pathAttribute = attributes.map((part) => part.trim()).find((part) => part.toLowerCase().startsWith('path='));
        cookies.set(pair.slice(0, split), { value: pair.slice(split + 1), path: pathAttribute?.slice(5) || '/' });
      }
      if (!expected.includes(value.status)) throw new Error('Rehearsal HTTP status ' + value.status);
      let data;
      try { data = JSON.parse(value.text); } catch { throw new Error('Invalid rehearsal JSON response.'); }
      if (typeof data.csrfToken === 'string') csrf = data.csrfToken;
      return { status: value.status, headers: value.headers, data };
    },
  };
}
