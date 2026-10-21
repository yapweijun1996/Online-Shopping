#!/usr/bin/env python3
"""Exercise the real shell entrypoint with a stateful, offline iptables runner."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
FAKE = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
p = Path(os.environ['RULE_STATE'])
rules = json.loads(p.read_text())
a = sys.argv[1:]
assert a.pop(0) == '-w'
op = a.pop(0)
assert a.pop(0) == 'DOCKER-USER'
if op == '-S':
    print('-N DOCKER-USER')
    for r in rules: print('-A DOCKER-USER ' + ' '.join(r))
    sys.exit(0)
if op == '-I':
    assert a.pop(0) == '1'
    rules.insert(0, a)
elif op == '-C': sys.exit(0 if a in rules else 1)
elif op == '-D': rules.remove(a)
else: raise AssertionError(op)
p.write_text(json.dumps(rules))
'''


class Tests(unittest.TestCase):
    def test_apply_check_repair_and_remove_preserve_other_projects(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root/'iptables'
            binary.write_text(FAKE)
            binary.chmod(0o700)
            state = root/'rules.json'
            other = ['-m', 'comment', '--comment', 'other-project', '-j', 'ACCEPT']
            state.write_text(json.dumps([other]))
            env = dict(os.environ, PATH=str(root)+os.pathsep+os.environ['PATH'], RULE_STATE=str(state))
            def run(*args, success=True):
                result = subprocess.run(['sh', str(ROOT/'deploy/gcp/egress-guard.sh'), *args], env=env, capture_output=True, text=True)
                self.assertEqual(0 if success else 1, result.returncode, result.stderr)
                return result.stdout.strip()
            self.assertEqual('', run('--check', success=False))
            self.assertEqual('Egress guard ready', run())
            first = state.read_bytes()
            self.assertEqual(5, len(json.loads(first)))
            self.assertEqual(other, json.loads(first)[-1])
            for destination in ('169.254.169.254/32', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'):
                self.assertIn(['-s', '192.168.247.0/24', '-d', destination, '-m', 'comment', '--comment', 'online-shopping-egress-guard', '-j', 'DROP'], json.loads(first))
            self.assertEqual('Egress guard ready', run('--check'))
            self.assertEqual('Egress guard ready', run())
            self.assertEqual(first, state.read_bytes())
            # A later host firewall insertion must not silently bypass our drops.
            state.write_text(json.dumps([other] + json.loads(first)))
            run('--check', success=False)
            run()
            self.assertEqual([other, other], json.loads(state.read_text())[-2:])
            self.assertEqual('Egress guard removed', run('--remove'))
            self.assertEqual([other, other], json.loads(state.read_text()))
            run('--remove')
            run('--check', success=False)

    def test_missing_iptables_refuses(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(['/bin/sh', str(ROOT/'deploy/gcp/egress-guard.sh')], env={'PATH': directory}, capture_output=True, text=True)
            self.assertEqual(1, result.returncode)
            self.assertEqual('iptables is required\n', result.stderr)


if __name__ == '__main__':
    unittest.main()
