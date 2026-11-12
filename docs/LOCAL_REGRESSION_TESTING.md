# Local regression testing

Use Node 24 matching package.json. Run application checks locally: CI does not run the full application suite.

```sh
npm ci
npm run check
NODE_ENV=test npm test
```

For PostgreSQL parity, provision an isolated disposable PostgreSQL database with `test` in its name and a test-only role permitted to create/drop fixture databases. Set `SHOP_TEST_DATABASE_URL` through your local environment; never use a production database or commit credentials. Tests create/drop temporary databases.

Set `SHOP_TEST_PG_BIN` to the directory containing matching `pg_dump`, `pg_restore`, `initdb` and `pg_ctl` binaries. On an Apple Silicon Homebrew PostgreSQL16 installation this is `/opt/homebrew/opt/postgresql@16/bin`. On macOS use canonical `TMPDIR=/private/tmp` to avoid path aliases during backup/restore assertions.

```sh
TMPDIR=/private/tmp NODE_ENV=test npm test
```

The preceding command inherits `SHOP_TEST_DATABASE_URL` and `SHOP_TEST_PG_BIN`; confirm both before claiming PostgreSQL/restore coverage. Without the database URL, optional PostgreSQL tests skip and do not prove parity.

Browser regressions can use `QA_PLAYWRIGHT_MODULE` pointing to an installed Playwright ES module and its supported local browser. Follow the individual test's fixture setup. Browser/provider fixtures are synthetic; do not use real shop keys or make paid API calls. Record skipped browser tests separately from executed ones.

After source changes, run affected tests first, then one final full suite. Interrupted runs or a suite started before the final source revision are not final acceptance evidence. Record totals, skips, failures and runtime environment in the repair report. Stop disposable services after testing.
