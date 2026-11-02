import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:net';
const command = promisify(execFile);
export async function docker(args, options = {}) { return command('docker', ['--context', 'orbstack', ...args], { timeout: 120_000, maxBuffer: 2_000_000, ...options }); }
export async function startCaddyFixture(mode) {
  if (!process.env.QA_BACKEND_IMAGE || !process.env.QA_FRONTEND_IMAGE) throw new Error('Set QA_BACKEND_IMAGE and QA_FRONTEND_IMAGE to disposable QA images.');
  const tag = `online-shopping-qa-${randomBytes(4).toString('hex')}`, scratch = await mkdtemp(join(tmpdir(), tag + '-'));
  const listener = createServer(); await new Promise((r) => listener.listen(0, '127.0.0.1', r)); const port = listener.address().port; await new Promise((r) => listener.close(r));
  const names = [tag + '-frontend', tag + '-backend'];
  const close = async () => { for (const name of names) await docker(['rm', '-f', name]).catch(() => {}); await docker(['network', 'rm', tag]).catch(() => {}); await rm(scratch, { recursive: true, force: true }); };
  try {
    let caddy = await readFile(resolve('deploy/Caddyfile.production'), 'utf8');
    caddy = caddy.replace('auto_https off', 'auto_https disable_redirects');
    caddy = caddy.replace(/http:\/\/(shop|seller|admin)\.gmb01\.xyz \{/g, 'https://$1.gmb01.xyz {\n  tls internal').replace(/:80 \{[\s\S]*$/, '');
    const config = join(scratch, 'Caddyfile'); await writeFile(config, caddy);
    const publicDir = join(scratch, 'public'); await cp(resolve('public'), publicDir, { recursive: true });
    await docker(['network', 'create', tag]);
    await docker(['run', '-d', '--name', names[1], '--network', tag, '--network-alias', 'backend', '-e', `QA_HOST_PORT=${port}`, '-e', `QA_MODE=${mode}`,
      '-v', `${resolve('src')}:/app/src:ro`, '-v', `${resolve('scripts/qa-caddy-backend.mjs')}:/app/scripts/qa-caddy-backend.mjs:ro`,
      process.env.QA_BACKEND_IMAGE, 'node', 'scripts/qa-caddy-backend.mjs']);
    await docker(['run', '-d', '--name', names[0], '--network', tag, '-p', `127.0.0.1:${port}:443`, '-v', `${config}:/etc/caddy/Caddyfile:ro`,
      '-v', `${publicDir}:/srv/public:ro`, process.env.QA_FRONTEND_IMAGE]);
    const request = async (host, path, { method = 'GET', body, headers = {} } = {}) => {
      const result = await command('curl', ['-k', '-sS', '--noproxy', '*', '--path-as-is', '--max-time', '15', '--resolve', `${host}:${port}:127.0.0.1`,
        '-X', method, '-D', '-', ...Object.entries(headers).flatMap(([key, value]) => ['-H', `${key}: ${value}`]), ...(body ? ['--data-binary', body] : []), `https://${host}:${port}${path}`], { maxBuffer: 2_000_000 });
      const split = result.stdout.indexOf('\r\n\r\n'), head = result.stdout.slice(0, split), text = result.stdout.slice(split + 4);
      return { status: Number(head.split(' ')[1]), headers: Object.fromEntries(head.split('\r\n').slice(1).map((line) => { const i = line.indexOf(':'); return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()]; })), text };
    };
    let ready = false, lastResult;
    for (let attempt = 0; attempt < 30; attempt++) { try { lastResult = await request('shop.gmb01.xyz', '/health'); if (lastResult.status === 200) { ready = true; break; } } catch (error) { lastResult = error.message; } await new Promise((r) => setTimeout(r, 250)); }
    if (!ready) {
      const diagnostics = await Promise.all(names.map(async (name) => { const r = await docker(['logs', name]); return r.stdout + r.stderr; }));
      throw new Error(`Disposable Caddy failed readiness: ${JSON.stringify(lastResult)}. ${diagnostics.join('\n')}`);
    }
    const certPath = join(scratch, 'qa-root.crt'), pubPath = join(scratch, 'qa-root.pub');
    await writeFile(certPath, (await docker(['exec', names[0], 'cat', '/data/caddy/pki/authorities/local/root.crt'])).stdout);
    await writeFile(pubPath, (await command('openssl', ['x509', '-in', certPath, '-pubkey', '-noout'])).stdout);
    const publicKey = (await command('openssl', ['pkey', '-pubin', '-in', pubPath, '-outform', 'DER'], { encoding: 'buffer' })).stdout;
    const pins = [createHash('sha256').update(publicKey).digest('base64')];
    // Chrome app windows need the leaf pin too: the untrusted root is not sent in the TLS chain.
    for (const host of ['shop', 'seller', 'admin']) {
      const peer = command('openssl', ['s_client', '-connect', `127.0.0.1:${port}`, '-servername', `${host}.gmb01.xyz`, '-showcerts']);
      peer.child.stdin.end();
      await writeFile(certPath, (await peer).stdout);
      await writeFile(pubPath, (await command('openssl', ['x509', '-in', certPath, '-pubkey', '-noout'])).stdout);
      const leafKey = (await command('openssl', ['pkey', '-pubin', '-in', pubPath, '-outform', 'DER'], { encoding: 'buffer' })).stdout;
      pins.push(createHash('sha256').update(leafKey).digest('base64'));
    }
    const tlsSpki = pins.join(',');
    return { port, scratch, publicDir, tlsSpki, request, close, origin: (host) => `https://${host}:${port}` };
  } catch (error) { await close(); throw error; }
}
