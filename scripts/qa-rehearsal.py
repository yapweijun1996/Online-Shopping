#!/usr/bin/env python3
"""Isolated production-compose rehearsal; never mounts a real tunnel credential."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess

ROOT = Path(__file__).resolve().parent.parent
PROJECT = 'online-shopping-rehearsal'


def command(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def compose(state):
    return ['docker', '--context', 'orbstack', 'compose', '-p', PROJECT, '--project-directory', str(ROOT),
            '--env-file', state['env'], '-f', str(ROOT / 'compose.production.yaml'), '-f', state['override']]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'start', 'stop'])
    parser.add_argument('--settings', default=str(ROOT / 'output/qa/multi-tenant/rehearsal.json'))
    args = parser.parse_args()
    settings = Path(args.settings)
    if args.action == 'prepare':
        os.umask(0o077)
        environment = json.loads((ROOT / 'output/qa/multi-tenant/environment.json').read_text())
        scratch = Path(environment['scratch']) / 'rehearsal'; scratch.mkdir(mode=0o700, exist_ok=True)
        for name in ['admin', 'database', 'owner', 'platform', 'provisioner', 'platform-admin']:
            path = scratch / name
            if not path.exists():
                with path.open('wb') as out: command(['openssl', 'rand', '-hex', '24'], stdout=out)
            path.chmod(0o600)
        keys = scratch / 'keys'
        if not keys.exists():
            with keys.open('wb') as out:
                out.write(b'qa='); out.flush(); command(['openssl', 'rand', '-base64', '32'], stdout=out)
        keys.chmod(0o600)
        credentials = scratch / 'disabled-tunnel.json'; credentials.write_text('{}'); credentials.chmod(0o600)
        with socket.socket() as listener: listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
        caddy = (ROOT / 'deploy/Caddyfile.production').read_text().replace('auto_https off', 'auto_https disable_redirects')
        import re
        caddy = re.sub(r'http://(shop|seller|admin)\.gmb01\.xyz \{', r'https://\1.gmb01.xyz {\n  tls internal', caddy)
        caddy = re.sub(r':80 \{[\s\S]*$', '', caddy)
        config = scratch / 'Caddyfile'; config.write_text(caddy)
        backend_image = os.environ['QA_BACKEND_IMAGE']; frontend_image = os.environ['QA_FRONTEND_IMAGE']
        override = scratch / 'rehearsal.override.json'
        override.write_text(json.dumps({'services': {
            'frontend': {'image': frontend_image, 'ports': [f'127.0.0.1:{port}:443'], 'volumes': [f'{config}:/etc/caddy/Caddyfile:ro', f'{ROOT / "public"}:/srv/public:ro']},
            'backend': {'image': backend_image, 'environment': {'PUBLIC_ORIGIN': f'https://shop.gmb01.xyz:{port}', 'SELLER_ORIGIN': f'https://seller.gmb01.xyz:{port}',
                'PLATFORM_ENABLED': '1', 'PLATFORM_ADMIN_HOST': f'admin.gmb01.xyz:{port}', 'PLATFORM_ADMIN_USERNAME': 'fixtureadmin',
                'PLATFORM_DATABASE_PASSWORD_FILE': '/run/secrets/platform', 'PLATFORM_PROVISIONER_PASSWORD_FILE': '/run/secrets/provisioner', 'PLATFORM_ADMIN_PASSWORD_FILE': '/run/secrets/platform_admin'},
                'secrets': ['platform', 'provisioner', 'platform_admin'], 'volumes': [f'{ROOT / "src"}:/app/src:ro', f'{ROOT / "scripts"}:/app/scripts:ro']},
            'tunnel': {'profiles': ['disabled'], 'deploy': {'replicas': 0}},
            'tunnel-admin': {'image': 'cloudflare/cloudflared:latest@sha256:072c067d25ccbe61d46e18f0d0723255f2bb5304f7317caa95b27031520ff92c', 'profiles': ['disabled'], 'deploy': {'replicas': 0}, 'secrets': ['tunnel_admin_credentials']}},
            'secrets': {'platform': {'file': str(scratch / 'platform')}, 'provisioner': {'file': str(scratch / 'provisioner')}, 'platform_admin': {'file': str(scratch / 'platform-admin')}, 'tunnel_admin_credentials': {'file': str(credentials)}}}, indent=2))
        env = scratch / 'rehearsal.env'
        values = {'ADMIN_USERNAME': 'fixtureowner', 'ADMIN_PASSWORD_FILE_HOST': str(scratch / 'admin'), 'DATABASE_PASSWORD_FILE_HOST': str(scratch / 'database'),
            'DATABASE_OWNER_PASSWORD_FILE_HOST': str(scratch / 'owner'), 'INTEGRATION_KEY_FILE_HOST': str(keys), 'TUNNEL_CREDENTIALS_FILE_HOST': str(credentials),
            'PLATFORM_ENABLED': '1', 'PLATFORM_ADMIN_HOST': f'admin.gmb01.xyz:{port}', 'PLATFORM_ADMIN_USERNAME': 'fixtureadmin',
            'PLATFORM_DATABASE_PASSWORD_FILE_HOST': str(scratch / 'platform'), 'PLATFORM_PROVISIONER_PASSWORD_FILE_HOST': str(scratch / 'provisioner'),
            'PLATFORM_ADMIN_PASSWORD_FILE_HOST': str(scratch / 'platform-admin'), 'TUNNEL_ADMIN_CREDENTIALS_FILE_HOST': str(credentials), 'SELLER_QUICK_LOGIN': '0'}
        env.write_text(''.join(f'{key}={value}\n' for key,value in values.items())); env.chmod(0o600)
        state = {'project': PROJECT, 'scratch': str(scratch), 'port': port, 'env': str(env), 'override': str(override), 'backendImage': backend_image, 'frontendImage': frontend_image}
        settings.write_text(json.dumps(state, indent=2)); settings.chmod(0o600)
        print('Rehearsal prepared:', PROJECT, 'loopback port', port)
    else:
        state = json.loads(settings.read_text())
        if state['project'] != PROJECT or not Path(state['scratch']).resolve().is_relative_to(Path(json.loads((ROOT / 'output/qa/multi-tenant/environment.json').read_text())['scratch']).resolve()):
            raise RuntimeError('Unexpected rehearsal scope.')
        if args.action == 'stop': command(compose(state) + ['down', '--volumes', '--remove-orphans']); return
        # Start PostgreSQL alone, prove setup, then start the application services. Tunnels stay disabled.
        command(compose(state) + ['up', '-d', '--no-build', '--wait', 'postgres'])
        command(['python3', str(ROOT / 'deploy/setup-platform.py'), '--container', PROJECT + '-postgres-1',
            '--database-password-file', str(Path(state['scratch']) / 'platform'), '--provisioner-password-file', str(Path(state['scratch']) / 'provisioner')])
        command(compose(state) + ['up', '-d', '--no-build', '--wait', '--force-recreate', 'backend', 'frontend'])
        print('Rehearsal running with both tunnels disabled.')


if __name__ == '__main__': main()
