import makeWASocket from '@whiskeysockets/baileys';
import { setTimeout as sleep } from 'node:timers/promises';
import { readConfig } from './config.js';
import { Client } from './client.js';
import { Session } from './session.js';
let session;
let stopping = false;
const abort = new AbortController();
async function stop() { stopping = true; abort.abort(); await session?.stop(); }
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
process.on('unhandledRejection', () => { session?.end(); process.exit(1); });
try {
  session = new Session({ client: new Client(readConfig()), makeSocket: makeWASocket });
  while (!stopping) {
    let delay = 10000;
    try { delay = await session.tick(); }
    catch { session.end(); }
    try { await sleep(delay, undefined, { signal: abort.signal }); } catch { if (!stopping) throw new Error('SLEEP_FAILED'); }
  }
} catch { console.error(JSON.stringify({ state: 'ERROR', code: 'WORKER_FAILED' })); process.exitCode = 1; }
