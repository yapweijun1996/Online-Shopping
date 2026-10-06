# OrbStack, PostgreSQL and Cloudflare Tunnel

The self-hosted instance uses `compose.production.yaml` in Docker context `orbstack`.
Public entry points are https://shop.gmb01.xyz/ and https://seller.gmb01.xyz/.
This deployment retains the existing single-shop model; the multi-tenant/SuperAdmin plan is a separate milestone.

## Runtime boundaries

Cloudflare Tunnel forwards both hostnames to Caddy on `frontend:80`. Cloudflare terminates public HTTPS; Caddy uses HTTP only on the internal edge network. The frontend has no published host ports. Node and PostgreSQL use an internal private network with no published ports. The API connects as `online_shopping_app`, which cannot create databases/roles or act as a superuser. The database owner has a separate password; its secret is mounted only in PostgreSQL, not in the API. Fresh-volume initialization installs the schema and grants the application role its table/sequence permissions. Caddy preserves the public hostname, replaces `X-Real-IP` with the Cloudflare visitor address, and blocks seller routes on the shop hostname and customer checkout on the seller hostname. The seller stylesheet's shared `/shop/tokens.css` remains available on the seller hostname.

`PUBLIC_ORIGIN=https://shop.gmb01.xyz` applies to customer writes. `SELLER_ORIGIN=https://seller.gmb01.xyz` applies to seller writes. Missing, foreign or opposite-site origins are rejected; seller writes also require the existing CSRF token. Seller cookies remain host-only, HttpOnly, SameSite=Strict and Secure. Browser API requests are relative URLs, so each interface talks to its own hostname. Do not add permissive CORS or wildcard origins.

The Node runtime uses asynchronous storage. PostgreSQL schema 13 preserves current API field types, order snapshots and ISO timestamp strings. A transaction uses one pooled client with async-local connection ownership. An advisory transaction lock preserves the previous single-writer behavior for business writes across processes; this is a conservative correctness choice for this small shop, not a high-throughput multi-tenant design. SQLite remains available for local tests. `worker-runtime/` is a frozen copy of the pre-conversion synchronous runtime; `src/worker.js` uses it so the existing Cloudflare Demo can continue unchanged. No Worker release is part of this deployment.

## Start and stop

Keep `.local/` operator-only (`0700`), and `.local/production.env` at `0600`.
Copy `deploy/production.env.example` there and supply the username and paths to the password/credentials files. Compose mounts these files read-only as secrets. On this macOS bind-mount setup, the mounted secret copies are `0644` inside the protected `0700` directory so nonroot containers can read them; do not place them in a shared directory. The original Cloudflare credential stays private in `~/.cloudflared/`. Never print these file contents or commit them.

The locally managed tunnel is named `online-shopping-gmb01`; its nonsecret UUID and hostname routes are in `deploy/cloudflared.yml`. To create equivalent routing elsewhere, use a new tunnel and update that file and its credential path. Explicitly supply the config when routing DNS: an unrelated default `~/.cloudflared/config.yml` can select a different tunnel.

```sh
docker --context orbstack compose --env-file .local/production.env -f compose.production.yaml --profile tunnel up -d --build --wait
docker --context orbstack compose --env-file .local/production.env -f compose.production.yaml ps
docker --context orbstack compose --env-file .local/production.env -f compose.production.yaml stop
```

Use `--context orbstack` explicitly. The global context remains `desktop-linux` to preserve unrelated services. OrbStack and Docker Desktop have separate volumes; do not expect data to appear automatically when switching engines. Never use `down -v` on this deployment.

`/health` is process liveness; `/ready` validates the database schema and required rows/tables. Restart policy is `unless-stopped`. The host must stay awake and connected; a laptop is not an always-on host by itself.

## SQLite import

Use the database-owner connection for the one-time importer, mounting its secret only into the disposable import container. Normal API credentials intentionally cannot disable schema triggers. Capture a consistent SQLite backup using `node:sqlite`'s `backup` API. Do not copy just a live `.db` file and omit its WAL. Preserve the original database/volume. Upgrade only a separate snapshot with the current SQLite migrations, then run `scripts/import-sqlite.js` against an empty PostgreSQL baseline before starting the API. In a container, copy a mounted snapshot into writable `/tmp` first, since SQLite opens/migrates the isolated copy.

The importer refuses an existing shop, imports all application tables, restores historical inactive-category products, resets generated event/limiter sequences, and compares every row count and SHA-256 digest including binary images. The import is one transaction; failure leaves the target at its fresh baseline. Private import evidence belongs in `.local/`, never in Git. The initial source was schema 8 with 20 products and zero orders; its copied snapshot upgraded to schema 13 before import. The private rollback copy is retained at `~/Backups/Online-Shopping/pre-postgres-sqlite-20261005.db` (0600).

## Backup and restore verification

```sh
python3 deploy/backup-postgres.py
```

Backups are unencrypted custom-format PostgreSQL archives, matching the recorded owner preference. Default directory: `~/Backups/Online-Shopping`, outside the repository, mode `0700`; archives and evidence are `0600`. Every run holds a repeatable-read exported snapshot, runs `pg_dump` against it, validates the archive listing, restores into a randomly named disposable database, compares schema and every application table's counts/hashes, runs readiness/catalog smoke tests on the restored database, and drops only that temporary database. The source database is never overwritten. An incomplete dump never receives its final filename.

The dump contains private credentials and contacts when present. Restrict access. Backups on the same machine do not protect against loss of that machine. The installed user LaunchAgent `com.gmb01.online-shopping.backup` runs this verification daily at 03:00 Asia/Singapore while the user session and OrbStack are running. `com.gmb01.online-shopping.awake` runs `caffeinate -is` to prevent idle/system sleep while connected to power. These do not make a closed-lid, powered-off or disconnected laptop available. A second copy, retention/rotation policy and alert delivery remain operational decisions. The script does not automatically delete older archives.

## Verification

Run Node 24. Ordinary `npm test` runs SQLite and frontend tests; live PostgreSQL tests explicitly skip without a test URL. CI supplies its own disposable database:

```sh
NODE_ENV=test SHOP_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/online_shopping_test npm test
npm run check
npm run worker:check
```

The PostgreSQL test launcher refuses a non-test environment or database name. It creates and drops only randomly named test databases. Coverage includes dual-origin login/CSRF, checkout replay, stock contention, limiter contention, rollback, image-preserving SQLite import, overwrite refusal, readiness mismatch and unreachable database.

Broader acceptance remains separate: target-device PWA installation/update, multi-tenant accounts, independent security review, off-machine disaster recovery and later integrations. Deployment does not claim those features are complete.

## Automatic main updates

See [AUTO_DEPLOY.md](AUTO_DEPLOY.md) for CI-gated main polling, immutable release checkouts, verified predeployment backups, application rollback and the installed LaunchAgents. Once installed, operate through the rendered release configuration; running workspace Compose directly would replace revision-tagged images with the default `local` version.

## Automatic deployment and the Docker credential helper

The updater runs every Docker command with its own `DOCKER_CONFIG` (`<state dir>/docker-config`) that has no `credsStore`. A global `~/.docker/config.json` that names Docker Desktop's credential helper can stall: builds then hang at "load metadata" until the 15-minute timeout and the release is left as `build_failed`/`failed_release_waiting`. The private config keeps the shared contexts, builders and plugins, so public base images are pulled anonymously and nothing depends on Docker Desktop. After changing `deploy/auto-update.py`, copy it over `<state dir>/auto-update.py`; the LaunchAgent runs that installed copy.
