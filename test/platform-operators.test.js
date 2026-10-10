import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('platform setup validates files and sends credentials only through stdin', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util, pathlib, tempfile, os, secrets, types
spec=importlib.util.spec_from_file_location('setup','deploy/setup-platform.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory(prefix='shopping-test-secrets-') as d:
 p=pathlib.Path(d)/'secret';value=secrets.token_hex(24);p.write_text(value);p.chmod(0o600);assert m.secret(p)==value
 p.chmod(0o644)
 try:m.secret(p);raise AssertionError('insecure file accepted')
 except ValueError:pass
 p.chmod(0o600);link=pathlib.Path(d)/'link';link.symlink_to(p)
 try:m.secret(link);raise AssertionError('symlink accepted')
 except ValueError:pass
 calls=[]
 def run(command,**kwargs):
  assert value not in ' '.join(command);assert value in kwargs['input'];calls.append(command)
  return types.SimpleNamespace(returncode=0,stdout='names only',stderr='')
 m.subprocess.run=run
 assert m.query(types.SimpleNamespace(container='shopping-test-postgres',owner='postgres'),'SELECT '+m.literal(value))=='names only'
 assert calls[0][:4]==['docker','--context','orbstack','exec']
print('setup secret and transport checks passed')
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /checks passed/);
});

test('purge requires explicit exact-code confirmation before any external operation', () => {
  const result = spawnSync('python3', ['deploy/purge-tenant.py', '--code', 'fictional', '--confirm', 'other', '--env-file', '/nonexistent'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /exact shop code/);
});
