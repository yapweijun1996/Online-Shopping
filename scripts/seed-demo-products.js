import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const origin = process.argv[2] || 'http://127.0.0.1:8080';
const parsedOrigin = new URL(origin);
if (parsedOrigin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsedOrigin.hostname) ||
    parsedOrigin.origin !== origin || parsedOrigin.username || parsedOrigin.password) {
  throw new Error('Demo seeding is limited to a local HTTP origin.');
}

const username = process.env.ADMIN_USERNAME;
const passwordFile = process.env.ADMIN_PASSWORD_FILE_HOST;
if (!username || !passwordFile) {
  throw new Error('Set ADMIN_USERNAME and ADMIN_PASSWORD_FILE_HOST in an ignored environment file.');
}

async function request(path, options = {}) {
  const response = await fetch(new URL(path, origin), options);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${body.error?.code || 'UNKNOWN'}`);
  }
  return { response, body };
}

const password = (await readFile(resolve(passwordFile), 'utf8')).replace(/\r?\n$/, '');
const login = await request('/api/v1/seller/session', {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password }),
});
const cookie = login.response.headers.get('set-cookie')?.split(';')[0];
const csrfToken = login.body.csrfToken;
if (!cookie || !csrfToken) throw new Error('Seller session did not return the expected cookie and CSRF token.');

try {
  const { body } = await request('/api/v1/seller/setup', {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'demo' }),
  });
  console.log(`Demo ready: ${body.shopName}. Open /shop/ to browse the pet catalog.`);
} finally {
  await request('/api/v1/seller/session', {
    method: 'DELETE',
    headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrfToken },
  });
}
