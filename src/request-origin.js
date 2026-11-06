import { isIP } from 'node:net';
import { ApiError } from './http.js';

const denied = () => { throw new ApiError(404, 'NOT_FOUND', 'Not found.'); };
const loopback = address => address === '::1' ||
  (isIP(address || '') === 4 && address.startsWith('127.')) ||
  (typeof address === 'string' && address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 && address.slice(7).startsWith('127.'));

// Only the configured production gateway topology may supply an external
// origin. Forwarded/Proto headers never select its scheme or destination.
export function externalRequestUrl(request, config = {}) {
  const target = request.url;
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//') || /[\\\x00-\x20\x7f#]/.test(target)) denied();
  const host = request.headers.host;
  if (config.production !== true || config.trustProxy !== true) {
    try { return new URL(target, `http://${host || 'localhost'}`); } catch { denied(); }
  }
  if (typeof host !== 'string' || !/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::[0-9]{1,5})?$/i.test(host)) denied();
  const raw = request.rawHeaders || [];
  if (raw.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host').length !== 1) denied();
  let presented;
  try { presented = new URL(`https://${host}`); } catch { denied(); }
  const origins = [config.publicOrigin, config.sellerOrigin,
    ...(config.platform?.adminHost ? [`https://${config.platform.adminHost}`] : [])];
  for (const value of origins) {
    if (typeof value !== 'string') continue;
    let configured;
    try { configured = new URL(value); } catch { denied(); }
    if (configured.origin !== value || configured.protocol !== 'https:' || configured.username || configured.password) denied();
    if (presented.host !== configured.host) continue;
    const url = new URL(target, configured);
    // Reject raw dot-segment normalization before tenant resolution.
    if (url.pathname !== target.split('?')[0]) denied();
    return url;
  }
  // Existing private health probes use loopback HTTP, never an authenticated
  // endpoint. A remote request with a forged localhost Host gets no exception.
  if (request.method === 'GET' && ['/health', '/ready'].includes(target) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(presented.hostname) && loopback(request.socket?.remoteAddress)) {
    return new URL(target, `http://${host}`);
  }
  denied();
}
