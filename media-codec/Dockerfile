# syntax=docker/dockerfile:1
# Development-only codec. No application source, DB credentials or IP listener.
FROM node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf
WORKDIR /codec
COPY package.json package-lock.json ./
# Optional ARM64/musl packages are required. No native compilation or install scripts.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --omit=dev --ignore-scripts --no-audit --no-fund --strict-ssl=true; \
    else npm ci --omit=dev --ignore-scripts --no-audit --no-fund --strict-ssl=true; fi \
    && rm -rf /root/.npm
COPY src ./src
RUN chmod -R a+rX /codec && mkdir -p /run/media-codec
# Distinct from the trusted host owner; shared group permits only socket IPC.
USER 10001:1000
ENV NODE_ENV=development NODE_OPTIONS=--max-old-space-size=32
CMD ["node", "src/main.js"]
