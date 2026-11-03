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
