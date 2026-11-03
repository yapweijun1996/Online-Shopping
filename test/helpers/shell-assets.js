import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

// The public files a page needs to start: HTML links and scripts, module imports, CSS @import/url(), and manifest icons.
// Paths are the URLs the browser requests (symlinked files keep the path they are imported by).
export function shellAssets({ root = new URL('../../public/', import.meta.url), entry = '/platform/', html = '/platform/index.html', extra = [] } = {}) {
  const seen = new Set(), queue = [html, ...extra];
  const read = (path) => (existsSync(new URL(`.${path}`, root)) ? readFileSync(new URL(`.${path}`, root), 'utf8') : null);
  const local = (value, from) => {
    if (/^(?:[a-z]+:|\/\/|#|data:)/i.test(value)) return null;
    const url = new URL(value, `https://example.test${from}`);
    return url.pathname;
  };
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    const source = read(path);
    if (source === null) throw new Error(`missing shell file ${path}`);
    seen.add(path);
    const refs = [];
    if (path.endsWith('.html')) for (const [, value] of source.matchAll(/\b(?:href|src)="([^"]+)"/g)) refs.push(value);
    if (path.endsWith('.js')) for (const [, value] of source.matchAll(/(?:from\s+|import\s*\(?\s*)['"](\.[^'"]+)['"]/g)) refs.push(value);
    if (path.endsWith('.css')) {
      for (const [, value] of source.matchAll(/@import\s+url\(['"]?([^'")]+)['"]?\)/g)) refs.push(value);
      for (const [, value] of source.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)) refs.push(value);
    }
    if (path.endsWith('.webmanifest')) for (const icon of JSON.parse(source).icons || []) refs.push(icon.src);
    for (const value of refs) {
      const next = local(value, path);
      if (next && !next.endsWith('/')) queue.push(next);
    }
  }
  seen.add(entry);
  return [...seen].sort();
}

// A fingerprint of everything a surface's Service Worker caches (its `assets` list), except the worker and version files, which
// carry the version this fingerprint guards. If any cached file changes, the fingerprint changes.
export function workerFingerprint(surface, root = new URL('../../public/', import.meta.url)) {
  const worker = readFileSync(new URL(`./${surface}/sw.js`, root), 'utf8');
  const list = worker.slice(worker.indexOf('assets: ['), worker.indexOf('].map(asset)'));
  const paths = [...new Set([...list.matchAll(/'([^']+)'/g)].map((match) => new URL(match[1], `https://example.test/${surface}/sw.js`).pathname))]
    .filter((path) => !path.endsWith('/') && !/\/(?:sw|version)\.js$/.test(path)).sort();
  const hash = createHash('sha256');
  for (const path of paths) { hash.update(path); hash.update('\0'); hash.update(readFileSync(new URL(`.${path}`, root))); hash.update('\0'); }
  return hash.digest('hex');
}
export const workerVersion = (surface, root = new URL('../../public/', import.meta.url)) => readFileSync(new URL(`./${surface}/version.js`, root), 'utf8').match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1];
export const SURFACES = ['platform', 'seller', 'shop'];
