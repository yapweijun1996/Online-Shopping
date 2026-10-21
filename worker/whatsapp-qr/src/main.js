import { setTimeout as sleep } from 'node:timers/promises';
import { readConfig } from './config.js';
import { Client } from './client.js';
// Dependencies must not expose Signal keys through their own console calls.
for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) console[method] = () => {};
const log = line => process.stdout.write(`${line}\n`);
let session;
let stopping = false;
const abort = new AbortController();
async function stop() { stopping = true; abort.abort(); await session?.stop(); }
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
process.on('unhandledRejection', () => { session?.end(); process.exit(1); });
try {
  const [{ default: makeWASocket }, { Session }] = await Promise.all([
    import('@whiskeysockets/baileys'), import('./session.js')
  ]);
  session = new Session({ client: new Client(readConfig()), makeSocket: makeWASocket, log });
  while (!stopping) {
    let delay = 10000;
    try { delay = await session.tick(); }
    catch (error) {
      session.end();
      if (error?.code === 'QR_REVOKED') {
        await session.stop().catch(() => {});
        log(JSON.stringify({ state: 'OFF', code: 'QR_REVOKED' }));
        await session.client.request('/v1/stopped', {}).catch(() => {});
      }
    }
    try { await sleep(delay, undefined, { signal: abort.signal }); } catch { if (!stopping) throw new Error('SLEEP_FAILED'); }
  }
} catch { log(JSON.stringify({ state: 'ERROR', code: 'WORKER_FAILED' })); process.exitCode = 1; }
