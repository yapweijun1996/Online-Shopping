"""Owner-side snapshot proofs and verified archives for isolated PostgreSQL databases."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import select
import subprocess
import tempfile
import time

ROLE_IDENTIFIER = re.compile(r'(?:platform_app|online_shopping|t_[a-z0-9]{3,30}_[0-9a-f]{8})')
IDENTIFIER = re.compile(r'(?:platform|online_shopping|t_[a-z0-9]{3,30}_[0-9a-f]{8})')


def private_json(path, value):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix='.proof-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            os.fchmod(output.fileno(), 0o600)
            json.dump(value, output, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


# Definitions exclude role/ACL identities because the scratch restore uses the owner; all table data is hashed.
SCHEMA_SQL = r"""
SELECT json_build_object('schemaSha256', encode(sha256(convert_to(json_build_object(
 'columns', (SELECT json_agg(r ORDER BY table_name, ordinal_position) FROM
   (SELECT table_name, ordinal_position, column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema='public') r),
 'indexes', (SELECT json_agg(r ORDER BY tablename,indexname) FROM
   (SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public') r),
 'constraints', (SELECT json_agg(r ORDER BY table_name,name) FROM
   (SELECT c.relname AS table_name, k.conname AS name, pg_get_constraintdef(k.oid) AS definition
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') r),
 'triggers', (SELECT json_agg(r ORDER BY table_name,name) FROM
   (SELECT c.relname AS table_name,t.tgname AS name,pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal) r),
 'functions', (SELECT json_agg(r ORDER BY definition) FROM
   (SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind IN ('f','p')) r)
)::text,'UTF8')),'hex'));
SELECT format('SELECT json_build_object(''table'',%L,''rows'',count(*),''sha256'',encode(sha256(convert_to(COALESCE(string_agg(j,chr(10) ORDER BY j),''''),''UTF8'')),''hex'')) FROM (SELECT row_to_json(t)::text j FROM %I.%I t) q;',tablename,schemaname,tablename)
FROM pg_tables WHERE schemaname='public' ORDER BY tablename
\gexec
"""


class OwnerPostgres:
    def __init__(self, context, container, owner='online_shopping'):
        self.exec = ['docker', '--context', context, 'exec', '-i', container]
        self.owner = owner

    def command(self, program, *args):
        return self.exec + [program, '-U', self.owner, *args]

    def query(self, database, sql):
        result = subprocess.run(self.command('psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', database),
                                input=sql, text=True, capture_output=True, timeout=120)
        if result.returncode: raise RuntimeError('Owner SQL failed.')
        return result.stdout.strip()

    def exists(self, database):
        if not IDENTIFIER.fullmatch(database): raise ValueError('Unexpected database identifier.')
        return self.query('postgres', "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname='" + database + "');") == 't'

    def lease(self, database):
        return SnapshotLease(self, database)

    def proof(self, database):
        with self.lease(database) as lease:
            result = dict(lease.evidence)
            result.pop('snapshot')
            return result

    def verify_archive(self, archive, evidence):
        if not archive.is_file() or archive.is_symlink() or archive.stat().st_mode & 0o777 != 0o600:
            raise RuntimeError('Unexpected archive path or permissions.')
        if hashlib.sha256(archive.read_bytes()).hexdigest() != evidence['archiveSha256']:
            raise RuntimeError('Archive checksum mismatch.')
        with archive.open('rb') as source:
            subprocess.run(self.exec + ['pg_restore', '--list'], stdin=source, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, check=True, timeout=120)

    def restore(self, archive, database, *, role=None, clean=False):
        flags = ['--single-transaction', '--no-owner', '--exit-on-error']
        if role:
            if not ROLE_IDENTIFIER.fullmatch(role): raise ValueError('Unexpected database role.')
            flags += ['--role', role]
        if clean:
            # --clean alone misses tables introduced by the failed upgrade. Replace the complete public schema
            # in one transaction; database ownership and CONNECT privileges remain intact.
            if not role: raise ValueError('Restore requires the original owner role.')
            with archive.open('rb') as source:
                dump = subprocess.Popen(self.exec + ['pg_restore', '--no-owner', '--exit-on-error', '--file=-'],
                                        stdin=source, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                target = subprocess.Popen(self.command('psql', '-Xq', '-v', 'ON_ERROR_STOP=1', '-d', database),
                                          stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                try:
                    target.stdin.write(('BEGIN; DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION "' + role + '"; SET ROLE "' + role + '";\n').encode())
                    while True:
                        chunk = dump.stdout.read(65536)
                        if not chunk: break
                        target.stdin.write(chunk)
                    if dump.wait(timeout=300): raise RuntimeError('Archive extraction failed.')
                    target.stdin.write(b'\nCOMMIT;\n'); target.stdin.close()
                    if target.wait(timeout=300): raise RuntimeError('Transactional restore failed.')
                finally:
                    for process in (dump,target):
                        if process.poll() is None: process.terminate(); process.wait(timeout=15)
            return
        with archive.open('rb') as source:
            subprocess.run(self.command('pg_restore', '-d', database, *flags), stdin=source,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=300)

    @staticmethod
    def same_proof(expected, actual):
        for field in ('schemaVersion', 'schemaSha256', 'tables'):
            if expected[field] != actual[field]: raise RuntimeError('Restore verification mismatch: ' + field)

    def backup(self, database, label, directory):
        if not IDENTIFIER.fullmatch(database) or not re.fullmatch(r'(?:platform|tenant-[a-z0-9]{3,30})', label):
            raise ValueError('Unexpected backup identifier.')
        directory = Path(directory)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + secrets.token_hex(3)
        final = directory / f'{label}-{stamp}.dump'
        scratch = 'shopping_restore_test_' + secrets.token_hex(8)
        fd, temporary = tempfile.mkstemp(prefix='.backup-', dir=directory)
        created = False
        try:
            os.fchmod(fd, 0o600)
            with self.lease(database) as lease:
                evidence = dict(lease.evidence)
                with os.fdopen(fd, 'wb') as output:
                    subprocess.run(self.command('pg_dump', '-d', database, '--format=custom', '--no-owner',
                                                '--snapshot=' + evidence['snapshot']), stdout=output,
                                   stderr=subprocess.DEVNULL, check=True, timeout=300)
                    output.flush(); os.fsync(output.fileno())
            evidence.pop('snapshot')
            evidence['archiveSha256'] = hashlib.sha256(Path(temporary).read_bytes()).hexdigest()
            self.verify_archive(Path(temporary), evidence)
            subprocess.run(self.command('createdb', scratch), check=True, timeout=60)
            created = True
            self.restore(Path(temporary), scratch)
            self.same_proof(evidence, self.proof(scratch))
            os.replace(temporary, final)
            evidence.update(restoreVerified=True, database=database,
                            verifiedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
            private_json(str(final) + '.json', evidence)
            return {'database': database, 'archive': str(final), 'evidence': str(final) + '.json'}
        finally:
            if created: subprocess.run(self.command('dropdb', scratch), check=True, timeout=60)
            if os.path.exists(temporary): os.unlink(temporary)


class SnapshotLease:
    def __init__(self, owner, database):
        self.process = subprocess.Popen(owner.command('psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', database),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        try:
            sql = r"""BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='120s';
SET LOCAL idle_in_transaction_session_timeout='360s';
SELECT json_build_object('snapshot',pg_export_snapshot());
SELECT to_regclass('public.schema_meta') IS NOT NULL AS has_meta
\gset
\if :has_meta
SELECT json_build_object('schemaVersion',version) FROM schema_meta WHERE id=1;
\else
SELECT json_build_object('schemaVersion',0);
\endif
""" + SCHEMA_SQL + "SELECT 'PROOF_READY';\n"
            self.process.stdin.write(sql); self.process.stdin.flush()
            self.evidence = {'tables': []}
            deadline, buffer = time.monotonic() + 180, b''
            while True:
                if time.monotonic() >= deadline: raise RuntimeError('Source snapshot proof timed out.')
                while b'\n' not in buffer:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0: raise RuntimeError('Source snapshot proof timed out.')
                    ready, _, _ = select.select([self.process.stdout], [], [], min(1, remaining))
                    if not ready: continue
                    chunk = os.read(self.process.stdout.fileno(), 65536)
                    if not chunk: raise RuntimeError('Source snapshot proof failed.')
                    buffer += chunk
                line, buffer = buffer.split(b'\n', 1)
                line = line.strip().decode('utf8')
                if line == 'PROOF_READY': break
                if not line:
                    if self.process.poll() is not None: raise RuntimeError('Source snapshot proof failed.')
                    continue
                value = json.loads(line)
                if 'table' in value: self.evidence['tables'].append(value)
                else: self.evidence.update(value)
            if not all(key in self.evidence for key in ('snapshot', 'schemaVersion', 'schemaSha256')):
                raise RuntimeError('Source snapshot proof is incomplete.')
        except Exception:
            self.close(False)
            raise

    def __enter__(self): return self
    def __exit__(self, kind, value, trace): self.close(kind is None)
    def close(self, commit):
        if self.process.poll() is None:
            try:
                self.process.stdin.write('COMMIT;\n' if commit else 'ROLLBACK;\n')
                self.process.stdin.close()
                if self.process.wait(timeout=15) and commit: raise RuntimeError('Source snapshot lease failed.')
            finally:
                if self.process.poll() is None: self.process.terminate(); self.process.wait(timeout=15)
