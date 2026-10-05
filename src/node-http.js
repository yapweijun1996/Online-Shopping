import { isIP } from 'node:net';
import { Readable } from 'node:stream';

export function clientAddress(request, config) {
  const forwarded = request.headers['x-real-ip'];
  if (config.trustProxy && typeof forwarded === 'string' && isIP(forwarded)) return forwarded;
  return request.socket.remoteAddress || 'unknown';
}

export function toFetchRequest(request) {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    headers.append(request.rawHeaders[index], request.rawHeaders[index + 1]);
  }
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(new URL(request.url, `http://${request.headers.host || 'localhost'}`), {
    method: request.method,
    headers,
    body: hasBody ? Readable.toWeb(request) : undefined,
    duplex: hasBody ? 'half' : undefined,
  });
}

export async function writeFetchResponse(response, result) {
  const body = result.body ? Buffer.from(await result.arrayBuffer()) : null;
  const headers = {};
  for (const [name, value] of result.headers) {
    if (name !== 'set-cookie') headers[name] = value;
  }
  const cookies = result.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  if (body && !headers['content-length']) headers['content-length'] = body.length;
  response.writeHead(result.status, headers);
  response.end(body);
}
