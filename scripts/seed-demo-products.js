import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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

const demoDirectory = fileURLToPath(new URL('../demo/', import.meta.url));
const products = JSON.parse(await readFile(resolve(demoDirectory, 'catalog.json'), 'utf8'));
if (products.length !== 20 || new Set(products.map((product) => product.sku)).size !== products.length) {
  throw new Error('The demo catalog must contain 20 unique SKUs.');
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

let created = 0;
let skipped = 0;
try {
  const existing = new Map();
  let offset = 0;
  while (true) {
    const { body } = await request(`/api/v1/seller/products?search=DEMO-&limit=100&offset=${offset}`, {
      headers: { Cookie: cookie },
    });
    for (const product of body.items) existing.set(product.sku, product);
    if (body.nextOffset === null) break;
    offset = body.nextOffset;
  }

  for (const product of products) {
    const { image, ...fields } = product;
    if (!/^[a-z0-9-]+\.webp$/.test(image)) throw new Error(`Invalid demo image name for ${product.sku}.`);
    const previous = existing.get(product.sku);
    if (previous) {
      if (!previous.imageUrl || Object.entries(fields).some(([key, value]) => previous[key] !== value) ||
          previous.currency !== 'MYR' || !previous.active) {
        throw new Error(`Existing ${product.sku} differs from the demo fixture; review it manually.`);
      }
      skipped++;
      continue;
    }
    const bytes = await readFile(resolve(demoDirectory, 'products', image));
    if (bytes.length > 512 * 1024) throw new Error(`${image} exceeds the 512 KB product image limit.`);
    const { body } = await request('/api/v1/seller/products', {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...fields, currency: 'MYR', active: true,
        imageDataUrl: `data:image/webp;base64,${bytes.toString('base64')}` }),
    });
    if (!body.imageUrl || body.sku !== product.sku) throw new Error(`Product ${product.sku} was not created correctly.`);
    created++;
    console.log(`Created ${product.sku}: ${product.name}`);
  }
} finally {
  await request('/api/v1/seller/session', {
    method: 'DELETE',
    headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrfToken },
  });
}

console.log(`Demo catalog complete: ${created} created, ${skipped} already present.`);
