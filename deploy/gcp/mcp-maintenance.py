#!/usr/bin/env python3
"""Root-installed bounded hygiene. Never discovers tenants or executes host release code."""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import sys


def maintain(controller):
    if controller.paused(): return 'paused'
    current = controller.state.get('current')
    if not current or controller.state.get('pending'): return 'paused'
    if controller.local_fingerprint() != controller.state['local']: return 'manual_config_required'
    controller.validate_release(current)
    # The installed controller chooses only its accepted immutable backend.
    info = json.loads(controller.docker('inspect', '--format', '{{json .}}', 'online-shopping-gcp-backend-1'))
    if info.get('Config', {}).get('Image') != current['backend'] or info.get('State', {}).get('Running') is not True:
        raise ValueError('Backend unavailable')
    if 'mcp' in current and info.get('Image') != current['mcp']['backendIdentity']:
        raise ValueError('Backend identity mismatch')
    cursor_path = controller.root / 'mcp-maintenance.json'
    cursor = None
    if cursor_path.exists() or cursor_path.is_symlink():
        module.trusted(cursor_path)
        if cursor_path.stat().st_size > 256: raise ValueError('Invalid maintenance cursor')
        value = json.loads(cursor_path.read_text())
        if not isinstance(value, dict) or set(value) != {'version','nextCursor'} or value['version'] != 1:
            raise ValueError('Invalid maintenance cursor')
        cursor = value['nextCursor']
    if cursor is not None and (not isinstance(cursor,str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',cursor)):
        raise ValueError('Invalid maintenance cursor')
    args = ['exec','online-shopping-gcp-backend-1','node','--max-old-space-size=96',
            'scripts/cleanup-seller-mcp.js','--all','1','--limit=20']
    if cursor: args += ['--after='+cursor]
    raw = controller.docker(*args,timeout=90)
    if len(raw.encode()) > 512: raise ValueError('Invalid maintenance result')
    result = json.loads(raw)
    if (not isinstance(result,dict) or set(result) != {'processedTenants','cleanupPassesPerTenant','nextCursor','complete'} or
            type(result['processedTenants']) is not int or not 0 <= result['processedTenants'] <= 20 or
            result['cleanupPassesPerTenant'] != 1 or type(result['complete']) is not bool or
            (result['nextCursor'] is not None and (not isinstance(result['nextCursor'],str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', result['nextCursor']))) or
            result['complete'] != (result['nextCursor'] is None)):
        raise ValueError('Invalid maintenance result')
    module.atomic(cursor_path,json.dumps(dict(version=1,nextCursor=result['nextCursor']),sort_keys=True).encode())
    return 'completed' if result['complete'] else 'continued'


def main():
    global module
    parser=argparse.ArgumentParser();parser.add_argument('--root',default='/opt/online-shopping-gcp');args=parser.parse_args()
    if os.geteuid()!=0:raise ValueError('Root required')
    os.umask(0o077)
    # Bootstrap only the fixed installed policy after verifying all ancestors.
    root=Path(args.root)
    if not root.is_absolute() or '..' in root.parts:raise ValueError('Invalid control path')
    path=root/'update.py'
    for item in (path,*path.parents):
        stat=item.lstat()
        if item.is_symlink() or stat.st_uid!=0 or stat.st_mode & 0o022:raise ValueError('Unsafe control path')
    spec=importlib.util.spec_from_file_location('shopping_installed_update',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    module.trusted(root,directory=True)
    for name in ('runtime.env','compose.yaml','state.json'):module.trusted(root/name)
    if (root/'update.lock').exists() or (root/'update.lock').is_symlink():module.trusted(root/'update.lock')
    fd=os.open(root/'update.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:print('MCP hygiene: paused');return
        print('MCP hygiene:',maintain(module.Updater(root,lock)))

if __name__=='__main__':
    try:main()
    except Exception as error:
        print('MCP hygiene failed:',type(error).__name__,file=sys.stderr);raise SystemExit(1) from None
