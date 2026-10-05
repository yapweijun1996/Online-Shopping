import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('auto_update', Path(__file__).resolve().parents[1] / 'deploy/auto-update.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
OLD, NEW = 'a' * 40, 'b' * 40

class Fake(m.Updater):
    def __init__(self):
        self.state = {'current': {'sha': OLD, 'release': '/old'}}
        self.events = []
        self.fail = None
    def render(self, item): self.events.append('render')
    def build(self, item):
        self.events.append('build')
        if self.fail == 'build': raise RuntimeError()
    def backup(self): self.events.append('backup')
    def remote_head(self): return NEW
    def approved(self, sha): return True
    def save(self, status, **fields):
        self.events.append(status)
        self.state.update(last_status=status, **fields)
    def activate(self, item): self.events.append('activate:' + item['sha'])
    def health(self, item):
        self.events.append('health:' + item['sha'])
        if self.fail == 'health' and item['sha'] == NEW: raise RuntimeError()
        if self.fail == 'rollback': raise RuntimeError()

class Tests(unittest.TestCase):
    def test_ci_requires_exact_successful_main_push(self):
        run = dict(id=1, run_attempt=1, head_sha=NEW, head_branch='main', event='push', path='.github/workflows/verify.yml', status='completed', conclusion='success')
        self.assertTrue(m.ci_passed({'workflow_runs': [run]}, NEW))
        for field, value in [('head_sha', OLD), ('head_branch', 'feature'), ('event', 'pull_request'), ('path', 'other.yml'), ('status', 'in_progress'), ('conclusion', 'failure')]:
            self.assertFalse(m.ci_passed({'workflow_runs': [dict(run, **{field: value})]}, NEW))
        self.assertFalse(m.ci_passed({'workflow_runs': [run, dict(run, id=2, conclusion='failure')]}, NEW))
        self.assertFalse(m.ci_passed({'workflow_runs': [run, dict(run, run_attempt=2, status='in_progress')]}, NEW))
    def test_atomic_state_permissions_and_failed_write(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder) / 'state.json'
            m.atomic_json(p, {'value': 1})
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)
            with patch.object(m.os, 'replace', side_effect=OSError('disk failure')):
                with self.assertRaises(OSError): m.atomic_json(p, {'value': 2})
            self.assertEqual(json.loads(p.read_text()), {'value': 1})
            self.assertEqual(list(Path(folder).glob('.state-*')), [])
            link = Path(folder) / 'link'
            link.symlink_to(p)
            with self.assertRaises(RuntimeError): m.atomic_json(link, {})
    def test_success_and_backup_before_cutover(self):
        u = Fake()
        u.deploy({'sha': NEW, 'release': '/new'})
        self.assertEqual(u.state['current']['sha'], NEW)
        self.assertEqual(u.state['previous']['sha'], OLD)
        self.assertLess(u.events.index('backup'), u.events.index('activate:' + NEW))
    def test_public_failure_restores_previous_without_restoring_database(self):
        u = Fake(); u.fail = 'health'
        with self.assertRaises(RuntimeError): u.deploy({'sha': NEW, 'release': '/new'})
        self.assertEqual(u.state['current']['sha'], OLD)
        self.assertEqual(u.state['failed_sha'], NEW)
        self.assertIsNone(u.state['pending'])
        self.assertEqual(u.events[-1], 'rolled_back')
        self.assertIn('health:' + OLD, u.events)
    def test_failed_rollback_retains_recovery_marker(self):
        u = Fake(); u.fail = 'rollback'
        with self.assertRaises(RuntimeError): u.deploy({'sha': NEW, 'release': '/new'})
        self.assertEqual(u.state['pending']['sha'], NEW)
        self.assertEqual(u.state['last_status'], 'rollback_failed')
    def test_failed_build_does_not_cut_over_or_retry_same_release(self):
        u = Fake(); u.fail = 'build'
        with self.assertRaises(RuntimeError): u.deploy({'sha': NEW, 'release': '/new'})
        self.assertEqual(u.state['failed_sha'], NEW)
        self.assertNotIn('activate:' + NEW, u.events)
        u.poll()
        self.assertEqual(u.events[-1], 'failed_release_waiting')
    def test_superseded_build_does_not_cut_over(self):
        u = Fake(); u.remote_head = lambda: OLD
        u.deploy({'sha': NEW, 'release': '/new'})
        self.assertEqual(u.state['current']['sha'], OLD)
        self.assertNotIn('activate:' + NEW, u.events)
    def test_interrupted_cutover_restores_recorded_current(self):
        u = Fake(); u.state['pending'] = {'sha': NEW, 'release': '/new'}
        u.recover()
        self.assertEqual(u.state['current']['sha'], OLD)
        self.assertEqual(u.state['failed_sha'], NEW)
        self.assertIsNone(u.state['pending'])
    def test_infrastructure_change_pauses_release(self):
        u = Fake(); u.checkout = lambda sha: '/new'
        with patch.object(m, 'fingerprint', side_effect=[{'schema': 14}, {'schema': 13}]): u.poll()
        self.assertEqual(u.state['last_status'], 'manual_migration_required')
        self.assertNotIn('build', u.events)

if __name__ == '__main__': unittest.main()
