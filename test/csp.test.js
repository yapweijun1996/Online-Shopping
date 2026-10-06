import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const policy = (file) => readFileSync(new URL(file, import.meta.url), 'utf8').match(/Content-Security-Policy:? "?([^"\n]+)/)[1];
const directives = (value) => Object.fromEntries(value.split(';').map(item => item.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]));

test('production Caddy allows only the Cloudflare Web Analytics beacon as third-party origin', () => {
  const csp = directives(policy('../deploy/Caddyfile.production'));
  assert.deepEqual(csp['script-src'], ["'self'", 'https://static.cloudflareinsights.com/beacon.min.js', 'https://static.cloudflareinsights.com/beacon.min.js/']);
  // The injected URL carries a version suffix, which only the prefix form matches (CSP paths are exact unless they end in '/').
  assert.ok('/beacon.min.js/v31edd6df95cf4e85bb4c19e7a9bdbcba1788362987495'.startsWith(new URL(csp['script-src'][2]).pathname));
  assert.deepEqual(csp['connect-src'], ["'self'", 'https://cloudflareinsights.com']);
  assert.deepEqual(csp['default-src'], ["'self'"]);
  assert.deepEqual(csp['object-src'], ["'none'"]);
  assert.deepEqual(csp['frame-ancestors'], ["'none'"]);
  assert.deepEqual(csp['base-uri'], ["'none'"]);
  assert.deepEqual(csp['img-src'], ["'self'", 'data:']);
  assert.deepEqual(csp['style-src'], ["'self'"]);
});

test('every other copy of the policy (local Caddy, static headers, Node server) stays first-party only', () => {
  for (const file of ['../deploy/Caddyfile', '../public/_headers', '../src/static.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /script-src 'self'; style-src/, file);
    assert.match(source, /connect-src 'self'; object-src/, file);
    assert.doesNotMatch(source, /cloudflareinsights/, file);
  }
});
