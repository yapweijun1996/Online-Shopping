import { Browsers, DisconnectReason } from '@whiskeysockets/baileys';
import { loadAuth } from './auth-state.js';
import { filterMessages } from './filters.js';
export const backoff = attempt => [1000, 2000, 4000, 8000, 16000, 30000][Math.min(attempt, 5)];
export const silentLogger = { level: 'silent', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
export class Session {
  constructor({ client, makeSocket, log = line => process.stdout.write(`${line}\n`), now = Date.now }) {
    Object.assign(this, { client, makeSocket, log, now });
    this.generation = null; this.desired = 'OFF'; this.state = 'IDLE'; this.attempt = 0; this.nextConnect = 0; this.failureSince = null; this.lastClaim = -Infinity; this.epoch = 0; this.events = Promise.resolve(); this.halted = false;
  }
  async report(state, extra = {}) {
    if (this.state !== state) { this.log(JSON.stringify({ state, ...(extra.reason ? { code: extra.reason } : {}) })); this.state = state; }
    await this.client.request('/v1/state', { generation: this.generation, state, ...extra });
  }
  end() { const socket = this.socket; this.socket = null; this.epoch++; if (socket) socket.end(new Error('SESSION_STOP')); }
  fail(error) {
    this.end();
    const conflict = error?.code === 'AUTH_VERSION';
    this.halted = !conflict;
    this.nextConnect = this.now() + 1000;
    this.failureCode = conflict ? 'AUTH_VERSION' : 'PERSISTENCE_FAILED';
  }
  async stop() { this.stopped = true; this.end(); await this.events; await this.auth?.flush(); }
  async tick() {
    let control;
    try { control = await this.client.request('/v1/control'); }
    catch (error) { this.end(); throw error; }
    if (!Number.isSafeInteger(control.generation) || !['OFF', 'PAIR', 'RUN'].includes(control.desired)) throw new Error('CONTROL_INVALID');
    if (control.generation !== this.generation || control.desired === 'OFF') {
      const old = this.socket; const connected = this.state === 'CONNECTED';
      this.socket = null; this.epoch++;
      if (old) {
        let timer;
        try {
          if (connected || control.generation !== this.generation) {
            await Promise.race([old.logout(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('LOGOUT_TIMEOUT')), 10000); })]);
          }
        } catch {} finally { clearTimeout(timer); old.end(new Error('SESSION_STOP')); }
      }
      if (control.generation !== this.generation) { this.halted = false; this.attempt = 0; this.failureSince = null; this.nextConnect = 0; }
      this.generation = control.generation;
      if (control.desired === 'OFF') await this.report('IDLE');
    }
    this.desired = control.desired;
    if (this.stopped || this.desired === 'OFF') return 10000;
    if (this.failureCode) { const reason = this.failureCode; this.failureCode = null; await this.report('ERROR', { reason }); }
    if (!this.socket && !this.halted && this.failureSince !== null && this.now() - this.failureSince >= 300000) {
      this.halted = true;
      await this.report('ERROR', { reason: 'RECONNECT_LIMIT' });
    }
    if (!this.socket && !this.halted && this.now() >= this.nextConnect) {
      try { await this.connect(); }
      catch { await this.connection({ connection: 'close' }); }
    }
    if (this.state === 'CONNECTED' && this.socket && this.now() - this.lastClaim >= 5000) await this.reply();
    return Math.min(10000, Math.max(250, Number(control.pollMs) || 2000));
  }
  async connect() {
    const epoch = ++this.epoch;
    const generation = this.generation;
    const auth = await loadAuth(this.client, generation, error => { if (epoch === this.epoch) this.fail(error); });
    this.auth = auth;
    if (this.stopped || epoch !== this.epoch) return;
    await this.report('CONNECTING');
    const socket = this.makeSocket({ auth: this.auth.state, logger: silentLogger, browser: Browsers.ubuntu('Online Shopping'), syncFullHistory: false, shouldSyncHistoryMessage: () => false, markOnlineOnConnect: false, generateHighQualityLinkPreview: false, getMessage: async () => undefined });
    this.socket = socket;
    socket.ev.process(events => {
      this.events = this.events.then(async () => {
        if (epoch !== this.epoch || this.stopped) return;
        if (events['creds.update']) await auth.saveCreds(events['creds.update']);
        if (epoch !== this.epoch) return;
        if (events['connection.update']) await this.connection(events['connection.update'], socket);
        if (epoch !== this.epoch) return;
        if (events['messages.upsert']) {
          const messages = filterMessages(events['messages.upsert']);
          // Counts only (never a number, name or text) so an operator can tell "nothing arrived" from "arrived but filtered".
          this.log(JSON.stringify({ inbound: { type: String(events['messages.upsert'].type).slice(0, 16), received: events['messages.upsert'].messages?.length ?? 0, accepted: messages.length } }));
          const envelopeBytes = Buffer.byteLength(JSON.stringify({ generation, messages: [] }));
          let batch = []; let bytes = envelopeBytes;
          for (const message of messages) {
            if (epoch !== this.epoch) break;
            const messageBytes = Buffer.byteLength(JSON.stringify(message));
            if (batch.length && (batch.length === 50 || bytes + 1 + messageBytes > 60 * 1024)) {
              await this.client.request('/v1/inbound', { generation, messages: batch });
              batch = []; bytes = envelopeBytes;
              if (epoch !== this.epoch) break;
            }
            bytes += messageBytes + (batch.length ? 1 : 0);
            batch.push(message);
          }
          if (batch.length && epoch === this.epoch) {
            await this.client.request('/v1/inbound', { generation, messages: batch });
          }
        }
      }).catch(error => { if (epoch === this.epoch) this.fail(error); });
      return this.events;
    });
  }
  async connection(update, socket) {
    if (update.qr) await this.report('PAIRING', { qr: update.qr });
    if (update.connection === 'open') {
      const phone = socket.user?.id?.split('@')[0].split(':')[0];
      if (!/^[0-9]{8,15}$/.test(phone || '')) throw new Error('PHONE_INVALID');
      this.attempt = 0; this.failureSince = null;
      await this.report('CONNECTED', { phone });
    }
    if (update.connection === 'close') {
      this.end();
      if (update.lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) { this.halted = true; await this.report('LOGGED_OUT'); return; }
      this.failureSince ??= this.now();
      if (this.now() - this.failureSince >= 300000) { this.halted = true; await this.report('ERROR', { reason: 'RECONNECT_LIMIT' }); return; }
      this.nextConnect = this.now() + backoff(this.attempt++);
      await this.report('RECONNECTING');
    }
  }
  async reply() {
    this.lastClaim = this.now();
    const { reply } = await this.client.request('/v1/replies/claim', { generation: this.generation });
    if (!reply) return;
    let result;
    const socket = this.socket;
    if (!socket || this.state !== 'CONNECTED') result = { status: 'FAILED', code: 'SOCKET_CLOSED' };
    else {
      let timer;
      try {
        const sent = await Promise.race([
          socket.sendMessage(reply.peer, { text: reply.text }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SEND_TIMEOUT')), 10000); })
        ]);
        result = sent?.key?.id ? { status: 'SENT', providerMessageId: sent.key.id } : { status: 'UNKNOWN' };
      } catch { result = { status: 'UNKNOWN' }; }
      finally { clearTimeout(timer); }
    }
    if (result.status === 'UNKNOWN' && this.socket === socket) {
      // A timed-out dispatch can still be pending; close before any later claim.
      await this.connection({ connection: 'close' });
    }
    await this.client.request(`/v1/replies/${encodeURIComponent(reply.id)}/result`, { generation: this.generation, ...result });
  }
}
