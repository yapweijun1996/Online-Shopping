export const GRAPH_VERSION = 'v21.0';   // one version for verify and send; slice 7 re-checks it against Meta's docs
const GRAPH_HOST = 'https://graph.facebook.com';
const MAX_BODY_BYTES = 16 * 1024;
const unavailable = () => ({ ok: false, reason: 'UNAVAILABLE' });

export function createWhatsAppTransport({ fetchImpl = fetch, timeoutMs = 10000 } = {}) {
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
      const controller = new AbortController();
      let timer, reader;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(unavailable()); }, timeoutMs);
      });
      const request = async () => {
        try {
          // Slice 7 re-checks these assumed Meta API details against the vendor docs.
          const response = await fetchImpl(`${GRAPH_HOST}/${GRAPH_VERSION}/${phoneNumberId}?fields=display_phone_number,verified_name`, {
            method: 'GET', headers: { Authorization: `Bearer ${accessToken}` },
            redirect: 'manual', signal: controller.signal,
          });
          reader = response.body?.getReader();
          if (controller.signal.aborted) return unavailable();
          if ([400, 401, 403].includes(response.status)) return { ok: false, reason: 'REJECTED' };
          if (response.status !== 200 || response.redirected || !reader) return unavailable();
          const chunks = [];
          let size = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BODY_BYTES) return unavailable();
            chunks.push(value);
          }
          const body = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
          if (!body || typeof body !== 'object' || Array.isArray(body)) return unavailable();
          const publicText = (value) => typeof value === 'string' && !value.includes(accessToken) ? value : null;
          return { ok: true, displayPhoneNumber: publicText(body.display_phone_number), verifiedName: publicText(body.verified_name) };
        } catch { return unavailable(); }
        finally {
          if (reader) void reader.cancel().catch(() => {});
        }
      };
      try { return await Promise.race([request(), timeout]); }
      finally {
        clearTimeout(timer);
        controller.abort();
        if (reader) void reader.cancel().catch(() => {});
      }
    },
  };
}
