const GRAPH_HOST = 'https://graph.facebook.com';
const MAX_BODY_BYTES = 16 * 1024;
const unavailable = () => ({ ok: false, reason: 'UNAVAILABLE' });

export function createWhatsAppTransport({ fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  return {
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
          const response = await fetchImpl(`${GRAPH_HOST}/v21.0/${phoneNumberId}?fields=display_phone_number,verified_name`, {
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
