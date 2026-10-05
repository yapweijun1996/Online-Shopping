#!/usr/bin/env python3
"""Install a user LaunchAgent after the immutable baseline is serving both domains."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

SOURCE = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('controller', SOURCE / 'deploy/auto-update.py')
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)
parser = argparse.ArgumentParser()
parser.add_argument('--revision', required=True)
parser.add_argument('--env-file', default=str(SOURCE / '.local/production.env'))
args = parser.parse_args()
if not controller.SHA.fullmatch(args.revision): raise SystemExit('A full commit SHA is required.')
root = Path.home() / 'Library/Application Support/Online-Shopping/auto-deploy'
root.mkdir(parents=True, exist_ok=True, mode=0o700)
root.chmod(0o700)
release = root / 'releases' / args.revision
if not release.is_dir(): raise SystemExit('Prepare the immutable release checkout first; see docs/AUTO_DEPLOY.md.')
head = subprocess.check_output(['git', '-C', str(release), 'rev-parse', 'HEAD'], text=True).strip()
if head != args.revision or subprocess.check_output(['git', '-C', str(release), 'status', '--porcelain'], text=True).strip():
    raise SystemExit('The immutable release must be clean and match the requested commit.')
# Parse the deployment dotenv contract without evaluating shell expressions.
values = dict(line.split('=', 1) for line in Path(args.env_file).read_text().splitlines() if line and not line.startswith('#'))
source_directory = Path(args.env_file).resolve().parent.parent
values.setdefault('DATABASE_OWNER_PASSWORD_FILE_HOST', './.local/postgres-owner-password')
for name in ['ADMIN_PASSWORD_FILE_HOST', 'DATABASE_PASSWORD_FILE_HOST', 'DATABASE_OWNER_PASSWORD_FILE_HOST', 'TUNNEL_CREDENTIALS_FILE_HOST']:
    path = Path(values[name])
    if not path.is_absolute(): path = source_directory / path
    path = path.resolve()
    if not path.is_file(): raise SystemExit('A required secret file is unavailable.')
    values[name] = str(path)
if any('\n' in value or '\r' in value or '$' in value for value in values.values()):
    raise SystemExit('Runtime values must be literal single-line dotenv values.')
runtime = root / 'runtime.env'
fd = os.open(runtime, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as output:
    os.fchmod(output.fileno(), 0o600)
    output.write('\n'.join(name + '=' + value for name, value in values.items()) + '\n')
controller.atomic_json(root / 'config.json', {'repository': controller.REPOSITORY})
state = root / 'state.json'
if not state.exists():
    controller.atomic_json(state, {'current': {'sha': args.revision, 'release': str(release)}, 'pending': None, 'last_status': 'installed'})
u = controller.Updater(root)
if u.state['current']['sha'] != args.revision: raise SystemExit('Installed state differs; do not overwrite an active updater.')
u.render(u.state['current'])
u.health(u.state['current'])
if not u.approved(args.revision): raise SystemExit('The baseline has not passed its main-push CI workflow.')
installed = root / 'auto-update.py'
shutil.copyfile(SOURCE / 'deploy/auto-update.py', installed)
installed.chmod(0o700)
log_directory = root / 'logs'
log_directory.mkdir(exist_ok=True, mode=0o700)
for name in ['update.log', 'update.err.log', 'backup.log', 'backup.err.log']:
    log = log_directory / name
    log.touch(mode=0o600, exist_ok=True)
    log.chmod(0o600)
path = '/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
launch_directory = Path.home() / 'Library/LaunchAgents'
launch_directory.mkdir(parents=True, exist_ok=True)
domain = 'gui/' + str(os.getuid())
for suffix in ['auto-update', 'backup']:
    label = 'com.gmb01.online-shopping.' + suffix
    arguments = [sys.executable, str(installed), '--state-dir', str(root)]
    job = dict(Label=label, ProgramArguments=arguments, EnvironmentVariables={'PATH': path},
               WorkingDirectory=str(root), ProcessType='Background',
               StandardOutPath=str(log_directory / ('backup.log' if suffix == 'backup' else 'update.log')),
               StandardErrorPath=str(log_directory / ('backup.err.log' if suffix == 'backup' else 'update.err.log')))
    if suffix == 'backup':
        arguments.append('--backup')
        job['StartCalendarInterval'] = {'Hour': 3, 'Minute': 0}
    else:
        job.update(RunAtLoad=True, StartInterval=120)
    target = launch_directory / (label + '.plist')
    subprocess.run(['launchctl', 'bootout', domain + '/' + label], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with target.open('wb') as output: plistlib.dump(job, output)
    target.chmod(0o600)
    subprocess.run(['launchctl', 'bootstrap', domain, str(target)], check=True)
print('Automatic deployment installed; polls main every 120 seconds. Private state:', root)
