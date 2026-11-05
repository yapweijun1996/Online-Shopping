# syntax=docker/dockerfile:1
# Development-only codec. No application source, DB credentials or IP listener.
FROM node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf
WORKDIR /codec
# Verify the filtered root context itself, not just what subsequent COPY commands use.
RUN --mount=type=bind,target=/context,readonly node --input-type=module <<'JS'
import fs from 'node:fs';
const directories = new Set(['media-codec', 'media-codec/src', 'src', 'src/mcp']);
const exact = new Set(['media-codec/package.json', 'media-codec/package-lock.json',
  'src/mcp/media-codec-wire.js', 'src/mcp/media-codec-client.js']);
let count = 0, bytes = 0;
function walk(relative = '') {
  for (const name of fs.readdirSync('/context/' + relative)) {
    const file = relative ? relative + '/' + name : name;
    const info = fs.lstatSync('/context/' + file);
    if (info.isDirectory() && directories.has(file)) walk(file);
    else if (info.isFile() && (exact.has(file) || /^media-codec\/src\/[a-z-]+\.js$/.test(file))) {
      count++; bytes += info.size;
    } else throw new Error('Invalid codec build context.');
  }
}
walk();
if (count > 64 || bytes > 262144) throw new Error('Codec build context exceeds its budget.');
console.log('Bounded codec build context verified.');
JS
COPY media-codec/package.json media-codec/package-lock.json ./
# The shared /src files use the same private ESM package scope, not the app manifest.
COPY media-codec/package.json /package.json
# Optional ARM64/musl packages are required. No native compilation or install scripts.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --omit=dev --ignore-scripts --no-audit --no-fund --strict-ssl=true; \
    else npm ci --omit=dev --ignore-scripts --no-audit --no-fund --strict-ssl=true; fi \
    && rm -rf /root/.npm
COPY media-codec/src/ ./src/
COPY src/mcp/media-codec-wire.js src/mcp/media-codec-client.js /src/mcp/
RUN chmod -R a+rX /codec /src /package.json && mkdir -p /run/media-codec
# Distinct from the trusted host owner; shared group permits only socket IPC.
USER 10001:1000
ENV NODE_ENV=development NODE_OPTIONS=--max-old-space-size=32
CMD ["node", "src/main.js"]
