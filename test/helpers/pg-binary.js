import path from 'node:path';
// Test-only override for the same real PostgreSQL tools on non-Linux hosts.
// Calls remain shell-free and each fixture retains its disposable/loopback checks.
export function pgBinary(name) {
 if (!['pg_dump','pg_restore'].includes(name)) throw new TypeError('Unsupported PostgreSQL test tool.');
 const directory=process.env.SHOP_TEST_PG_BIN || '/usr/lib/postgresql/16/bin';
 if (!path.isAbsolute(directory)) throw new TypeError('SHOP_TEST_PG_BIN must be an absolute directory.');
 return path.join(directory,name);
}
