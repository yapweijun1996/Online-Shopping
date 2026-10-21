export const GRAPH_VERSION = 'v21.0';   // one version for verify and send; slice 7 re-checks it against Meta's docs
const GRAPH_HOST = 'https://graph.facebook.com';
const MAX_BODY_BYTES = 16 * 1024;
const unavailable = () => ({ ok: false, reason: 'UNAVAILABLE' });

export function createWhatsAppTransport({ fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  async function get(url, accessToken) {
    const controller = new AbortController();
    let reader, timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(unavailable()); }, timeoutMs);
    });
    const request = async () => {
      try {
        const target = new URL(url);
        if (target.origin !== GRAPH_HOST || target.username || target.password) return unavailable();
        const response = await fetchImpl(target.href, { method: 'GET', redirect: 'manual',
          signal: controller.signal, headers: { Authorization: `Bearer ${accessToken}` } });
        reader = response.body?.getReader();
        if (controller.signal.aborted || response.redirected) return unavailable();
        if ([400, 401, 403].includes(response.status)) return { ok: false, reason: 'REJECTED' };
        if (response.status !== 200 || !reader) return unavailable();
        const chunks = []; let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY_BYTES) return unavailable();
          chunks.push(value);
        }
        const body = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
        return body && typeof body === 'object' && !Array.isArray(body) ? { ok: true, body } : unavailable();
      } catch { return unavailable(); }
      finally { if (reader) void reader.cancel().catch(() => {}); }
    };
    try { return await Promise.race([request(), timeout]); }
    finally { clearTimeout(timer); controller.abort(); if (reader) void reader.cancel().catch(() => {}); }
  }
  return {
    /* Sends one message. Always resolves { status, body }: status 0 and a null body mean "no usable answer"
     * (timeout, network error, redirect, oversized or non-JSON body), which the caller must treat as an UNKNOWN outcome. */
    async send({ accessToken, phoneNumberId, message }) {
      if (typeof phoneNumberId !== 'string' || !/^[0-9]{5,32}$/.test(phoneNumberId) || typeof accessToken !== 'string' || !accessToken) return { status: 0, body: null };
      try {
        const response = await fetchImpl(`${GRAPH_HOST}/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message),
        });
        if (response.status >= 300 && response.status < 400) return { status: 0, body: null };
        const reader = response.body?.getReader();
        const chunks = []; let size = 0;
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY_BYTES) { void reader.cancel().catch(() => {}); return { status: 0, body: null }; }
          chunks.push(value);
        }
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch { /* the caller classifies a missing body */ }
        return { status: response.status, body: body && typeof body === 'object' && !Array.isArray(body) ? body : null };
      } catch { return { status: 0, body: null }; }
    },
    async verify({ accessToken, phoneNumberId }) {
      if (typeof phoneNumberId !== 'string' || !/^[0-9]{5,32}$/.test(phoneNumberId) ||
          typeof accessToken !== 'string' || !accessToken) return unavailable();
      const result = await get(`${GRAPH_HOST}/${GRAPH_VERSION}/${phoneNumberId}?fields=display_phone_number,verified_name`, accessToken);
      if (!result.ok) return result;
      const publicText = value => typeof value === 'string' && !value.includes(accessToken) ? value : null;
      return { ok: true, displayPhoneNumber: publicText(result.body.display_phone_number), verifiedName: publicText(result.body.verified_name) };
    },
    async readiness({ accessToken, phoneNumberId, businessAccountId }) {
      // Meta references (phone GET is UNVERIFIED; current reference only documents POST):
      // https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/phone_numbers/
      // https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/subscribed_apps/
      // https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/message_templates/
      const base = `${GRAPH_HOST}/${GRAPH_VERSION}/${businessAccountId}`;
      const checks = [];
      const descriptions = {
        phoneOwnership: 'Confirm the Phone Number ID belongs to this WABA and the token has asset access.',
        appSubscription: 'Subscribe the intended Meta app to this WABA; a non-empty list proves only that an app is subscribed.',
        templates: 'Create and obtain approval for all required template names and languages. UNKNOWN is incomplete evidence.',
      };
      const check = (id, status) => checks.push({ id, status, detail: descriptions[id] });
      const phones = await get(`${base}/phone_numbers?fields=id,display_phone_number`, accessToken);
      check('phoneOwnership', !phones.ok ? phones.reason === 'REJECTED' ? 'FAIL' : 'UNKNOWN'
        : !Array.isArray(phones.body.data) ? 'UNKNOWN'
        : phones.body.data.some(phone => phone?.id === phoneNumberId) ? 'PASS' : phones.body.paging?.next ? 'UNKNOWN' : 'FAIL');
      const apps = await get(`${base}/subscribed_apps`, accessToken);
      check('appSubscription', !apps.ok ? apps.reason === 'REJECTED' ? 'FAIL' : 'UNKNOWN'
        : !Array.isArray(apps.body.data) ? 'UNKNOWN' : apps.body.data.length ? 'PASS' : 'FAIL');
      const found = new Map();
      let next = `${base}/message_templates?fields=name,language,status&limit=100`, complete = false;
      for (let page = 0; page < 5 && next; page++) {
        const result = await get(next, accessToken);
        if (!result.ok || !Array.isArray(result.body.data)) break;
        for (const template of result.body.data) {
          if (['APPROVED', 'PENDING', 'REJECTED'].includes(template?.status))
            found.set(`${template.name}:${template.language}`, template.status);
        }
        next = result.body.paging?.next;
        if (!next) complete = true;
      }
      const templates = ['order_submitted', 'order_confirmed', 'order_rejected', 'order_shipped'].flatMap(name =>
        ['en', 'ms', 'zh_CN', 'vi', 'th', 'ja', 'ko'].map(language => ({
          name, language, status: found.get(`${name}:${language}`) || (complete ? 'MISSING' : 'UNKNOWN'),
        })));
      check('templates', templates.every(item => item.status === 'APPROVED') ? 'PASS'
        : templates.some(item => ['PENDING', 'REJECTED', 'MISSING'].includes(item.status)) ? 'FAIL' : 'UNKNOWN');
      return { checks, templates };
    },
  };
}
