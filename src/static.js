import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from './http.js';

const publicRoot = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

export async function serveStatic(request, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  if (pathname === '/') return redirect('/shop/');
  if (pathname === '/seller' || pathname === '/shop') return redirect(`${pathname}/`);
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new ApiError(400, 'INVALID_INPUT', 'Invalid path.');
  }
  if (decoded.includes('\0') || decoded.split('/').some((part) => part.startsWith('.'))) {
    throw new ApiError(404, 'NOT_FOUND', 'Not found.');
  }
  const candidate = path.resolve(publicRoot, `.${decoded}`, decoded.endsWith('/') ? 'index.html' : '');
  if (!candidate.startsWith(`${publicRoot}${path.sep}`)) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
  let actual;
  try {
    actual = await realpath(candidate);
    if (!actual.startsWith(`${publicRoot}${path.sep}`) || !(await stat(actual)).isFile()) throw new Error('not file');
  } catch {
    throw new ApiError(404, 'NOT_FOUND', 'Not found.');
  }
  const type = types[path.extname(actual)];
  if (!type) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
  const body = await readFile(actual);
  return new Response(request.method === 'HEAD' ? null : body, {
    headers: {
      'Content-Type': type,
      'Content-Length': String(body.length),
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store' } });
}
