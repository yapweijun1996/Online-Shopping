import { join } from 'node:path';

export function requireLocalBuilder(report) {
  const drivers = [...report.matchAll(/^Driver:\s+(\S+)\s*$/gm)].map(match => match[1]);
  const endpoints = [...report.matchAll(/^Endpoint:\s+(\S+)\s*$/gm)].map(match => match[1]);
  if (drivers.length !== 1 || drivers[0] !== 'docker' || endpoints.length !== 1 ||
      !['default', 'unix:///var/run/docker.sock'].includes(endpoints[0])) {
    throw new Error('Development codec requires the local default Docker builder.');
  }
}

/** Trusted developer build only; keep Docker registry/proxy settings, never inherited selectors. */
export function developmentBuild(repoRoot, environment = process.env) {
  const env = { ...environment };
  for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH', 'BUILDX_BUILDER']) delete env[name];
  const args = ['--host=unix:///var/run/docker.sock', 'buildx', 'build', '--builder=default',
    '--load', '--progress=plain', '--tag=shopping-media-codec-dev:local',
    '--file', join(repoRoot, 'media-codec/Dockerfile')];
  if (environment.CODEX_PROXY_CERT) args.push('--secret', `id=proxy_ca,src=${environment.CODEX_PROXY_CERT}`);
  args.push(repoRoot);
  return { env, args };
}
