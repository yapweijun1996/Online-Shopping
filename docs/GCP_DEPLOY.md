# GCP deployment

This deployment is separate from OrbStack/Cloudflare. The existing VM is now e2-small (2 GiB RAM), shared with other containers. Preserve its existing PostgreSQL volume; never reinitialize it to enable platform mode.

## Trust boundary and runtime policy

The public gateway terminates TLS for `demoonlineshopping.xyz` and `seller.demoonlineshopping.xyz`, preserves `Host`, and **overwrites** `X-Real-IP` with the client IP from the connection. Connect only that trusted gateway to the external `online-shopping-edge` network and proxy both hosts to `online-shopping-frontend:80`. Do not expose application or PostgreSQL ports. Anyone allowed onto this network could forge client IP headers. There are no Cloudflare headers or services in this deployment.

The frontend isolates shop and seller hosts; the SuperAdmin console shares the seller host by explicit owner decision. Claim pages/APIs are proxied only on the shop host. Tenant static paths use the backend metadata-only lifecycle/alias gate before prefix rewriting; tenant APIs retain their prefix. Both hosts accept root and tenant-prefixed WhatsApp webhooks, subject to backend verification. Unknown paths return 404. Claim mode defaults off. The integration-key path defaults empty; activation supplies it and consequently permits the existing WhatsApp worker to run. Backend alone joins non-internal `egress` for HTTPS to `graph.facebook.com` and future outbound integrations. PostgreSQL stays on internal `private` only; frontend networking and inbound ports are unchanged.

Both hosts emit `Strict-Transport-Security: max-age=31536000`, without `includeSubDomains` or `preload`. The TLS gateway must preserve it.

Backend memory is capped at 384 MiB with a 192 MiB V8 heap to leave native/TLS/database/scrypt headroom for platform work; frontend remains 48 MiB and PostgreSQL 192 MiB with 20 connections. Total shopping caps are 624 MiB on the shared 2 GiB VM, not a capacity guarantee. Observe OOM, swap, connections and latency before adding tenants. Existing shop owner/app credentials remain separate. New platform secrets are UID/GID 1000, mode 0600 inside a root-only directory: file-backed Compose secrets preserve host ownership, allowing the image's node user to read them without world-readable files.

## CI images

`.github/workflows/gcp-images.yml` runs only after a successful same-repository `push` of `main` through `Verify new MVP`. It checks out that exact tested SHA, builds `linux/amd64`, and publishes backend/frontend images with SHA tags and OCI revision labels. Actions are pinned to authoritative upstream Git refs checked during implementation. CI has only `contents: read` and `packages: write`; there are no VM credentials or VM builds.

After the first publication, make both GHCR packages **public** in their package settings. The host uses anonymous public GitHub and GHCR, with its own empty Docker credential configuration and no PAT. Do not make the repository public merely to enable this method: anonymous source access is a prerequisite, and private repositories need a separately reviewed authentication design.

## One-off demo catalog seeding

Use a reviewed backend image containing `scripts/seed-demo-shop.mjs`. Restore-test a backup first. Run a disposable container on the backend's existing **private** Docker network, without published ports, using the same backend environment and read-only secret-file mounts (including `ADMIN_PASSWORD_FILE` and `DATABASE_PASSWORD_FILE`). Mount the operator-prepared product JSON and image directory read-only at `/seed`. Do not put credentials in arguments or print the container environment.

Pattern (replace image/network/env/mount placeholders with the installed backend settings):

```sh
docker run --rm --network PRIVATE_NETWORK --env-file BACKEND_ENV_FILE \
  --mount type=bind,src=HOST_SECRETS,dst=/run/secrets,readonly \
  --mount type=bind,src=HOST_SEED_DIRECTORY,dst=/seed,readonly \
  --entrypoint node BACKEND_IMAGE \
  scripts/seed-demo-shop.mjs --data /seed/products.json --images /seed/images \
  --shop-name 'Demo Mart Malaysia' --dry-run
```

Review the plan, then repeat without `--dry-run`. This targets the default shop database selected by `readConfig`, not the platform registry or another tenant. All three `SKU/view-N.jpg` files are required; `view-N.thumb.jpg` previews are optional. Category slugs are uppercase hyphen-separated codes to satisfy the existing category API. Existing SKU rows are skipped without edits. The JSON's `shopName` is informational: only `--shop-name` changes the stored name, never setup mode. Dry-run summary counts describe planned writes. Each product, its missing category, gallery and creation history commit atomically; a database failure preserves earlier completed products and rerunning resumes by SKU. Complete input validation precedes catalog/name writes; opening the store still performs the standard schema initialization/migrations, so use an already initialized database for a strictly no-write dry run.

Seed inputs (`--data` and `--images`) are operator-trusted: preserve the bundle and do not modify it during import. JSON must be a regular file of at most 1 MiB. Images must resolve inside the real image root; non-regular files and final-component symlinks are rejected. Reads are capped before base64 conversion (512 KiB photos, 80 KiB previews). JPEG structure must contain a valid 8-bit frame and scan, end exactly at EOI, and remain within 4096 pixels per dimension and 16 million pixels. This is structural validation, not full entropy decoding. Three views must have distinct bytes. Successful write summaries count persisted gallery images.

An unambiguous active category label is reused case-insensitively with its stored code and spelling; only unmatched labels receive generated codes. `Home & Living` does not match `Home`. Conflicting labels/codes fail before writes. The shop-name update is deliberately a separate final, name-column-only step after product transactions; a failure can leave committed products with the old name. Rerun with the same bundle and name to finish. An unchanged name issues no update. Serialize this maintenance operation with seller edits.


## Initial operator installation

Review the exact release and verify its CI before installation. All commands below run on the existing VM as root. The installer is intentionally manual: automatic updates cannot replace the updater, Compose policy, runtime configuration or systemd units.

1. Create `/opt/online-shopping-gcp` root-owned mode `0700`, with root-owned non-writable ancestors. Install the reviewed updater, Compose policy, provisioner and runtime example there as `update.py`, `compose.yaml`, `enable-platform.py` and `runtime.env`, mode `0600` (provisioner `0700`). Runtime accepts only shop/seller hosts, default seller username, secrets directory, two binary platform switches and the empty or fixed integration key mount path. Unknown/duplicate keys and interpolation are rejected. No secret values belong here.
2. Create `/opt/cloudops/secrets/online-shopping` root owned, mode `0700`. Generate three separate strong secrets outside Git: `admin-password` (the existing application requires at least 16 characters, letters and digits, and rejects weak passwords), `postgres-password`, and `postgres-owner-password`. Docker Compose file-backed secrets retain host file permissions: the backend's non-root `node` user must be able to read its mounted admin/app secrets. Use root-owned mode `0444` secret files inside the root-only `0700` host directory, or an explicitly reviewed UID/ACL mapping. Never print the values or use command-line password arguments. Do not reuse any existing app/database secrets.
   Before initialization, run `python3 /opt/online-shopping-gcp/enable-platform.py --root /opt/online-shopping-gcp secrets`, then the same command with `secrets --check`. This creates only missing integration/platform/provisioner files, exclusively, mode 0600 UID/GID1000, without images, release directories, Docker or database prerequisites. Keep both platform switches off.
3. Ensure `online-shopping-edge` exists and connect the shared gateway; configure the two gateway hosts above. Configure DNS/firewall for the shared gateway's existing 80/443 only. Do not add app/database published ports.
   Install and verify the required host egress guard below before starting backend on egress.
4. Initialize with the exact current full main SHA (replace the placeholder):

   ```sh
   python3 /opt/online-shopping-gcp/update.py --root /opt/online-shopping-gcp initialize --sha FULL_40_HEX_MAIN_SHA
   ```

   Initialization verifies main and the latest exact-SHA `verify.yml` push run, downloads only schema/init/Caddy configuration from that trusted SHA, verifies Git blob hashes, anonymously pulls both image tags, resolves immutable digests, checks labels/platform, and starts the full stack. It saves `state.json` only after backend readiness and frontend-proxied readiness return the expected revision. The schema/init files run only when PostgreSQL initializes the new empty volume. If an initial deployment fails, inspect private container health diagnostics without publishing logs; initialization can be retried after resolving the cause. Do not delete a nonempty DB volume as a retry strategy.
5. Verify both public hosts, expected 404 cross-host routes, login, and a fictional catalog/order scenario. Confirm owner/app DB separation, startup opt-out flags, no extra ports/socket mounts, and available RAM/disk. This manual public check also establishes actual gateway TLS/header policy; local updater checks do not prove it.
   Fresh-install platform activation is separate: after this default-off stack is healthy, restore-test its private backup, run `enable-platform.py --root /opt/online-shopping-gcp provision --check` (expected failure before provisioning; inspect privately), then `provision`, then require `provision --check` to succeed. Provisioning requires the healthy stack and existing secrets; it creates missing roles/database and reports missing schema as skipped. Claim-enabled backend startup initializes fresh v2. Existing v2 is a no-op; v1 is refused for manual migration below. Only then follow the reviewed opt-in/stop-before-start procedure below. Never run provisioning before first initialization.
6. Copy `deploy/gcp/online-shopping-update.service` and `.timer` to `/etc/systemd/system/`, root owned. Only after successful initialization:

   ```sh
   systemctl daemon-reload
   systemctl enable --now online-shopping-update.timer
   ```

The service is root owned because Docker control is root equivalent; access to its unit, updater, state and deployment root is privileged. systemd gives it write access only to its deployment root and the Docker daemon socket through Docker's normal API. It runs every approximately three minutes, serializes with `flock`, bounds HTTP/subprocess durations/output, uses fixed argv and no shell, and reports codes/status only. Anonymous GitHub API rate limits can defer checks; API/network failures leave the current release running.

## Automatic update and manual release protocol

The updater trusts the exact repository's main HEAD and **latest** successful completed `verify.yml` push run for that SHA. An older successful attempt cannot override a newer failed/in-progress rerun. Main and CI are rechecked after pulls, before activation. Candidate SHA must be full lowercase hex. Repository maintainers able to change main and its verification workflow remain trusted: configure branch protections/reviews in GitHub; this code cannot establish that policy.

Automatic activation changes only backend/frontend immutable digest references with `compose up --no-deps --no-build`; it never restarts/replaces PostgreSQL, invokes migrations, restores backups, deletes data, prunes volumes, executes downloaded code, or updates its own controller. The host Compose and runtime env remain fixed outside release directories and their hashes must match initialized state.

Any change under `deploy/`, `.github/workflows/`, `src/postgres/`, Compose files, Dockerfiles, `src/config.js`, dependency manifests, or `SCHEMA_VERSION` pauses automatic activation (`manual_release_required`). Tree fingerprints include file modes and capture additions/removals; the schema/init/Caddy files are also Git-blob verified. This intentionally favors a manual dependency/configuration release over silently changing host policy. Unchanged-schema application updates retain the current release record, save pending intent durably before mutation, check the running digest and exact readiness revision through backend and frontend, and restore previous **application images only** on failure. A crash with pending intent restores the last accepted application images on the next run. Failed SHAs are not retried automatically. A rollback failure preserves pending intent and needs operator investigation. Application writes are not undone.

For a manual protected/schema/config/controller release: stop the timer, review the full policy/schema difference, take and **restore-test** a private database backup using a separately reviewed maintenance procedure, and explicitly plan compatible migration/rollback. Do not erase state or rerun initialization as a way to bypass a schema gate. This scoped updater deliberately has no force/migrate/prune option. After a verified manual release, an operator must explicitly install the reviewed controller/configuration and establish a new audited baseline; editing state requires privileged operational review. Do not assume an old image can safely run against a new schema.

## Operations and limitations

Inspect status via `systemctl status online-shopping-update.timer`, `journalctl -u online-shopping-update.service`, and private `state.json`. Never publish `docker inspect`, rendered Compose config, runtime logs, DB dumps or secret contents. State records image digests and release metadata, not passwords. Application JSON logs are rotated at 2 × 5 MiB per service. Before every application image pull the updater requires at least 3 GiB free on the deployment filesystem; low space aborts before activation and leaves the current release running. This is a reserve guard, not a bound on image growth or protection from other writers. Check disk use frequently: this version deliberately performs **no image/release cleanup**, so a 20 GiB disk has a finite release capacity. Operators may remove only reviewed unused app images/releases while retaining current/previous/pending images; never prune DB volumes. Budget checks, encrypted off-host backups, alerts and disk cleanup are operational responsibilities and are not implemented by this image updater.

Offline verification: `python3 test/gcp-deploy.test.py`; the new image publication workflow runs these tests before publishing each image. Tests cover latest CI scope/reruns, idempotency, failed readiness rollback and failed rollback intent, crash recovery, protected/schema/config gates, malicious path/revision/image/config inputs, secret-safe command failures, anonymous digest resolution, and Compose isolation. Live deployment and public TLS/route checks must be recorded by the operator separately.

Real local GCP edge verification (Docker context `orbstack`, no application images or production access):

```sh
docker --context orbstack pull caddy:2.10.2-alpine
node scripts/qa-gcp-caddy-routing.mjs
```

The matrix runs the unchanged `deploy/gcp/Caddyfile` with `shop.qa.test` / `seller.qa.test`, copied `public/` assets and a synthetic echo backend implemented with the same pinned Caddy image. It prints PASS/FAIL groups and exits nonzero on failure. Disposable `qa-gcp-*` containers/network and temporary files are removed on exit. It covers static assets, setup host/method isolation, seller/platform routes, unknown host, raw path guards, tenant prefix/query preservation, both webhook methods, gateway-header forwarding and all nine crawler agents on default/tenant roots. It does not prove the external gateway overwrites client headers, public TLS, real application authentication or production deployment.

`provision --check` fails readiness for missing roles/database/secrets or unusable credentials. Inside the running backend, an inline Node probe uses `pg` and mounted secret paths to connect over the container network to `postgres`: app against `platform`, provisioner against `postgres`. Each role must reject a deliberately wrong password with PostgreSQL's password-authentication error before its real credential and identity can pass. Trust/ignored-password paths and missing, unreadable or empty mounts fail closed. Only fixed JSON statuses leave the probe; passwords and server diagnostics never enter argv or output. No password is reset. PostgreSQL retains only its existing owner/app mounts and must not be recreated. Safe order: create secret files, install reviewed Compose/Caddy, recreate only backend+frontend with flags off, provision, then flip claim environment and restart backend. Check mode does not certify schema/application readiness.


## Initial GCP acceptance record (2026-10-20)

Release `fb96872f727390c1b59e7fc130fca0c91b58a24a` passed main push verification and both GHCR image publications. The native GCP controller initialized a fresh PostgreSQL volume and accepted the immutable backend/frontend digests after direct and frontend-proxied readiness matched the revision. The host controller SHA-256 matched the reviewed repository source. This record is a documentation-only main update used for the live automatic-deployment acceptance check; final observed deployment state and gateway/DNS evidence are maintained in the CloudOps-MCP operations repository.

Independent pre-deployment checks passed 522 application tests with PostgreSQL16 on Node24.20, 39 existing deployment-controller tests, 12 GCP controller tests, and production dependency audit (zero vulnerabilities). A separate fresh local Compose stack verified owner login, authenticated setup read, shop/seller pages, cross-host404 isolation and disabled demo mode. These checks do not claim public TLS availability, migration of existing shop data, or a completed shop business setup.

## Platform claim manual release (P7/P8/P10 artifacts; not live acceptance)

Run as root on Linux. No DNS change: admin host is `seller.demoonlineshopping.xyz`. This deliberately shares the seller script origin with SuperAdmin; mandatory TOTP does not eliminate that shared-origin risk. Do not use legacy `PLATFORM_ADMIN_USERNAME` or `PLATFORM_ADMIN_PASSWORD_FILE`.

Prerequisite for an **existing live stack**: stage the complete reviewed release at `/root/reviewed-platform`, including CI-verified immutable references in `images.env` (BACKEND_IMAGE, FRONTEND_IMAGE, APP_REVISION and RELEASE_DIR only). RELEASE_DIR is `/opt/online-shopping-gcp/releases/<APP_REVISION>`. Verify CI/digests before staging. The running default-shop schema must match; otherwise stop for its separate migration procedure. Before the mutation block below, take and restore-test a private cluster backup in isolated PostgreSQL16. Do not proceed without restore evidence. Existing platform v1 requires the manual procedure below; provisioning never runs shop DDL. An older v1-only image cannot open a manually upgraded v2 platform database; do not use it for rollback after opt-in.

Ordered non-interactive commands (do not enable shell tracing; stdout/logs remain private):

```sh
set -eu
R=/opt/online-shopping-gcp
S=/root/reviewed-platform
systemctl stop online-shopping-update.timer
systemctl stop online-shopping-update.service
install -d -m 0700 "$R/platform-rollback"
cp -p "$R/compose.yaml" "$R/runtime.env" "$R/images.env" "$R/update.py" "$R/state.json" "$R/platform-rollback/"
python3 - "$R" "$S" <<'PY'
import json, pathlib, sys
r, s = map(pathlib.Path, sys.argv[1:])
old = dict(line.split('=', 1) for line in (r/'images.env').read_text().splitlines())
new = dict(line.split('=', 1) for line in (s/'images.env').read_text().splitlines())
assert set(old) == set(new) == {'BACKEND_IMAGE','FRONTEND_IMAGE','APP_REVISION','RELEASE_DIR'}
# Configuration-only activation requires the already accepted claim-capable images.
assert old == new, 'Install and verify the reviewed claim-capable image release first'
assert (pathlib.Path(new['RELEASE_DIR'])/'deploy/gcp/Caddyfile').is_file()
PY
docker compose -p online-shopping-gcp --env-file "$R/runtime.env" --env-file "$R/images.env" -f "$R/compose.yaml" ps
df -h "$R"
free -m
# Back up cluster metadata and all databases privately before any additive DDL.
docker compose -p online-shopping-gcp --env-file "$R/runtime.env" --env-file "$R/images.env" -f "$R/compose.yaml" exec -T postgres pg_dumpall -U online_shopping > "$R/platform-rollback/cluster.sql"
chmod 0600 "$R/platform-rollback/cluster.sql"
install -m 0600 "$S/deploy/gcp/update.py" "$R/update.py"
install -m 0700 "$S/deploy/gcp/enable-platform.py" "$R/enable-platform.py"
python3 "$R/enable-platform.py" --root "$R" secrets
python3 "$R/enable-platform.py" --root "$R" secrets --check
install -m 0600 "$S/compose.gcp.yaml" "$R/compose.yaml"
# Install reviewed Caddy and backend mounts with platform flags still off.
python3 - "$R" "$S" <<'PY'
import pathlib, sys
r, s = map(pathlib.Path, sys.argv[1:])
images = dict(line.split('=', 1) for line in (r/'images.env').read_text().splitlines())
target = pathlib.Path(images['RELEASE_DIR'])/'deploy/gcp/Caddyfile'
(r/'platform-rollback/Caddyfile').write_bytes(target.read_bytes())
target.write_bytes((s/'deploy/gcp/Caddyfile').read_bytes())
target.chmod(0o644)
PY
# Existing platform v1: take the manual v1 detour below BEFORE this startup.
docker compose -p online-shopping-gcp --env-file "$R/runtime.env" --env-file "$R/images.env" -f "$R/compose.yaml" stop backend frontend
docker compose -p online-shopping-gcp --env-file "$R/runtime.env" --env-file "$R/images.env" -f "$R/compose.yaml" up -d --no-deps --no-build backend frontend
# Missing objects cause failed readiness before first provisioning; inspect privately.
if python3 "$R/enable-platform.py" --root "$R" provision --check; then
  printf '%s\n' 'Existing platform credentials authenticate'
else
  printf '%s\n' 'Not ready: inspect private state before additive provisioning'
fi
python3 "$R/enable-platform.py" --root "$R" provision
python3 "$R/enable-platform.py" --root "$R" provision --check
python3 - "$R" "$S" <<'PY'
import pathlib, sys
r, s = map(pathlib.Path, sys.argv[1:])
env = dict(line.split('=', 1) for line in (r/'runtime.env').read_text().splitlines() if line and not line.startswith('#'))
env.update(PLATFORM_ENABLED='1', PLATFORM_ADMIN_CLAIM_ENABLED='1', INTEGRATION_KEY_FILE='/run/secrets/integration_keys')
(r/'runtime.env').write_text(''.join(k+'='+v+'\n' for k,v in env.items()))
PY
# Stop-before-start: no overlapping claim issuers; never recreate PostgreSQL.
docker compose -p online-shopping-gcp --env-file "$R/runtime.env" --env-file "$R/images.env" -f "$R/compose.yaml" stop backend frontend
docker compose -p online-shopping-gcp --env-file "$R/runtime.env" --env-file "$R/images.env" -f "$R/compose.yaml" up -d --no-deps --no-build backend frontend
docker compose -p online-shopping-gcp --env-file "$R/runtime.env" --env-file "$R/images.env" -f "$R/compose.yaml" logs --since 5m --no-log-prefix backend
```

Before DDL, restore-test `cluster.sql` in an isolated PostgreSQL 16 environment using the separately reviewed backup procedure; do not restore into production or proceed without that evidence. Logs contain one `platform.claim.issued` record per generation, including the bearer URL. Read privately; never paste it into chat, tickets or CI. Docker json-file is authoritative here; Cloud Logging delivery is UNVERIFIED. Restrict log readers/exports/retention before enabling. Missing/expired delivery requires a trusted stop/start of backend to issue a fresh generation, not retrieval of an old plaintext token.

The owner alone opens the shop-host claim URL, submits email/username/password, then signs in again at `https://seller.demoonlineshopping.xyz/platform/`, enrolls TOTP and stores recovery codes privately. The agent must not claim or enroll for the owner. Verify setup now returns 404, console MFA works, and a fictional tenant's shop/seller routes, lifecycle/alias gate, cross-host 404s and webhooks work before marking acceptance. Actual Caddy adaptation and gateway/TLS tests are mandatory at deployment; offline tests are not substitutes.

Rollback configuration without dropping platform objects or changing any passwords:

```sh
set -eu
R=/opt/online-shopping-gcp
docker compose -p online-shopping-gcp --env-file "$R/runtime.env" --env-file "$R/images.env" -f "$R/compose.yaml" stop backend frontend
python3 - "$R" <<'PY'
import pathlib, sys
r = pathlib.Path(sys.argv[1])
images = dict(line.split('=', 1) for line in (r/'platform-rollback/images.env').read_text().splitlines())
(pathlib.Path(images['RELEASE_DIR'])/'deploy/gcp/Caddyfile').write_bytes((r/'platform-rollback/Caddyfile').read_bytes())
for name in ('compose.yaml','runtime.env','images.env','update.py'):
    (r/name).write_bytes((r/'platform-rollback'/name).read_bytes())
PY
docker compose -p online-shopping-gcp --env-file "$R/runtime.env" --env-file "$R/images.env" -f "$R/compose.yaml" up -d --no-deps --no-build backend frontend
```

Keep the timer stopped after activation or rollback until acceptance and a new audited baseline. The following explicit baseline command is a privileged manual release, not an updater bypass: it requires the staged release to still be CI-approved main, compares every controller-managed mount to reviewed source, verifies readiness and saves the current protected/local fingerprints. Run only after the owner has completed MFA and the public acceptance checks above:

```sh
python3 - /opt/online-shopping-gcp <<'PY'
import importlib.util, pathlib, sys
r = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('gcp_update', r/'update.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)
up = u.Updater(r)
current = up.state['current']
assert not up.state.get('pending')
assert up.head() == current['sha'] and up.approved(current['sha'])
baseline, content = up.source(current['sha'])
release = r/'releases'/current['sha']
for name in u.MOUNTS:
    assert (release/name).read_bytes() == content[name], 'Reviewed source/mount mismatch'
up.runtime()
up.health(current)
current['baseline'] = baseline
up.save('deployed', current=current, local=up.local_fingerprint())
PY
systemctl start online-shopping-update.timer
```

Do not erase state or rerun initialize. Platform schema/version/migrations are protected by `src/platform/`; MOUNTS is unchanged. Provisioning is additive, resumes interrupted creation, validates boundaries and never changes existing passwords or shop tables. Missing schema and v2 skip migration; both provision and check refuse v1. The automatic OrbStack version stays 1 and its unflagged runner never applies migration 002. Claim-off fresh databases remain v1; claim-on fresh databases initialize v2. Retain the old controller baseline and keep the timer stopped pending review.

### Manual v1 migration and egress release

`compose.gcp.yaml` is protected. With the updater timer stopped, manually install the reviewed policy as host `compose.yaml` and recreate backend to attach `egress`; do not change frontend or PostgreSQL policy. This is not an automatic image-only release.

For existing platform v1, stop backend traffic/workers, take a private cluster backup and restore-test it in isolated PostgreSQL 16 before proceeding. Keep backend stopped. Verify candidate image compatibility, release script provenance and `/app` working directory. With the same project/env/policy arguments used above, run a one-off backend with:

```sh
docker compose -p online-shopping-gcp --env-file "$R/runtime.env" --env-file "$R/images.env" -f "$R/compose.yaml" run --rm --no-deps \
  -v "$RELEASE_DIR/scripts/upgrade-platform.mjs:/app/scripts/upgrade-platform.mjs:ro" \
  -e PLATFORM_PASSWORD_FILE=/run/secrets/platform \
  backend node /app/scripts/upgrade-platform.mjs --with-claim
```

Set `R` and `RELEASE_DIR` to the verified host root and exact release directory first. This standalone claim-only branch does not consume a backup manifest or write an upgrade report: enforce the restore-tested backup gate and retain private output. It changes only platform schema, not tenant schemas. Combined shop-schema upgrades require the verified-manifest/report workflow in `scripts/upgrade-platform.mjs`.

This detour precedes the earlier activation block's provision calls. After migration verify version 2, start only a compatible backend with claim **disabled**, wait healthy, then provision/check: the provisioner requires a running healthy backend for preflight and credential authentication.

```sh
set -eu
docker compose -p online-shopping-gcp --env-file "$R/runtime.env" --env-file "$R/images.env" -f "$R/compose.yaml" exec -T postgres \
  psql -X -v ON_ERROR_STOP=1 -U online_shopping -d platform -Atc 'SELECT version FROM public.schema_meta WHERE id = 1' | \
  python3 -c 'import sys; assert sys.stdin.read().strip() == "2"'
python3 - "$R/runtime.env" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
env = dict(line.split('=', 1) for line in p.read_text().splitlines() if line and not line.startswith('#'))
env.update(PLATFORM_ENABLED='1', PLATFORM_ADMIN_CLAIM_ENABLED='0')
p.write_text(''.join(k+'='+v+'\n' for k,v in env.items()))
PY
docker compose -p online-shopping-gcp --env-file "$R/runtime.env" --env-file "$R/images.env" -f "$R/compose.yaml" up -d --no-deps --no-build --wait --wait-timeout 120 backend frontend
python3 "$R/enable-platform.py" --root "$R" provision --check
python3 "$R/enable-platform.py" --root "$R" provision
python3 "$R/enable-platform.py" --root "$R" provision --check
```

Resume the earlier activation block at its runtime flag update and stop-before-start claim activation, not its earlier startup. On failure keep claim disabled and privately reconcile or restore the backup before restart; image rollback alone cannot undo DDL.

### Required host egress guard

The project egress bridge reserves `192.168.247.0/24`. Check host routes and Docker subnets for collisions before installation; a collision blocks release. Any reviewed subnet change must update Compose and the guard together. PostgreSQL uses the separate internal private bridge.

Install as root from the reviewed release **before** starting backend on egress, including the activation/v1 procedures. Docker must use its iptables forwarding backend and provide `DOCKER-USER`; native nftables-only Docker is unsupported. The guard refuses absent iptables/chains. Tagged IPv4 DROPs at the top of `DOCKER-USER`, before established-traffic accepts, block metadata `169.254.169.254/32` and all RFC1918 destinations from the egress subnet. Public traffic, including established/related connections, continues through existing Docker policy; no broad ACCEPT is installed.

```sh
set -eu
R=/opt/online-shopping-gcp
S=/root/reviewed-platform
install -m 0700 "$S/deploy/gcp/egress-guard.sh" "$R/egress-guard.sh"
install -m 0644 "$S/deploy/gcp/online-shopping-egress-guard.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now online-shopping-egress-guard.service
"$R/egress-guard.sh" --check
```

The oneshot starts after and restarts with Docker. After Docker/firewall changes run `--check`; repair ordering with `systemctl reload online-shopping-egress-guard.service`. Keep backend and updater stopped during policy/network replacement. Existing egress bridges need removal/recreation after stopping attached backend to adopt IPAM; never remove private networking or PostgreSQL volumes. Verify the recreated bridge before backend activation:

```sh
docker network inspect online-shopping-gcp_egress --format '{{range .IPAM.Config}}{{println .Subnet}}{{end}}' | \
  python3 -c 'import sys; assert sys.stdin.read().strip() == "192.168.247.0/24"'
```

Required non-interactive live acceptance with a reviewed, locally available curl image. First verify the image exists; Docker launch failure is not proof of metadata denial. Require curl timeout/connection failure (not merely an HTTP rejection), followed by public HTTPS success:

```sh
set -eu
docker image inspect curlimages/curl:8.10.1 --format '{{.Id}}'
/opt/online-shopping-gcp/egress-guard.sh --check
if docker run --rm --pull=never --network online-shopping-gcp_egress curlimages/curl:8.10.1 \
  --noproxy '*' --silent --show-error --connect-timeout 3 --max-time 5 \
  -H 'Metadata-Flavor: Google' -o /dev/null http://169.254.169.254/computeMetadata/v1/; then
  echo 'FAIL: metadata reachable' >&2; exit 1
else
  code=$?
  case "$code" in 7|28) ;; *) echo 'FAIL: inconclusive metadata probe' >&2; exit 1;; esac
fi
docker run --rm --pull=never --network online-shopping-gcp_egress curlimages/curl:8.10.1 \
  --noproxy '*' --fail --silent --show-error --connect-timeout 5 --max-time 15 -o /dev/null https://example.com/
docker compose -p online-shopping-gcp --env-file /opt/online-shopping-gcp/runtime.env --env-file /opt/online-shopping-gcp/images.env \
  -f /opt/online-shopping-gcp/compose.yaml exec -T backend node -e \
  "fetch('http://127.0.0.1:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
```

Readiness verifies PostgreSQL connectivity. Verify provider HTTPS separately through existing integration acceptance without real test sends. Use a minimally privileged VM service account as defense in depth. Additional metadata addresses or IPv6 routing require separate blocks/tests before release; this IPv4 bridge policy does not cover them or host-local INPUT traffic.

Rollback only after stopping backend and reverting to a reviewed policy without unrestricted egress:

```sh
systemctl disable --now online-shopping-egress-guard.service
/opt/online-shopping-gcp/egress-guard.sh --remove
```

Service stop intentionally retains rules. Removal deletes only exact tagged guard rules, never flushes shared chains. Offline test: `python3 test/gcp-egress-guard.test.py`. Live packet denial, public/provider HTTPS, reboot ordering and host firewall compatibility remain operator acceptance requirements.

## GCP acceptance record (2026-10-21)

Evidence from the live deployment at https://demoonlineshopping.xyz (shop) and https://seller.demoonlineshopping.xyz (seller / SuperAdmin console host). Statements below were observed on the live host unless marked UNVERIFIED.

- **Host:** `cloudops-host` (asia-southeast1-b) resized from e2-micro to e2-small (2 vCPU, ~1.9 GB RAM); reserved IP unchanged; all containers restarted automatically; guest orders written before the stop were read back after the restart.
- **Releases:** two manual (protected-path) releases were performed with the updater's own `Updater` methods (`release`, `activate`, `health`, `save`) after a cluster backup that was restored into a throw-away container and compared by row counts (orders/products/accounts/events, platform tenants/admins; 0 non-benign errors). The updater timer was restarted afterwards and has since deployed `fd28dfd` automatically.
- **Platform mode:** roles `platform_app` / `platform_provisioner` and database `platform` exist; schema v2 was initialised by the backend in claim mode; one default tenant registered; no SuperAdmin yet (claim links are issued at backend start-up and expire after 30 minutes; none is outstanding).
- **Edge:** `/demo-assets/*` served on the shop host (gallery images), `/setup/` only on the shop host and only while claiming is open, HSTS (`max-age=31536000`) on both hosts, host isolation (shop host never serves seller/platform; seller host never serves shop) confirmed with a real Caddy matrix (`scripts/qa-gcp-caddy-routing.mjs`, 102 assertions) and live requests.
- **Egress:** the backend joins the non-internal `egress` network (192.168.247.0/24); the host-enforced guard (`egress-guard.sh`) blocks 169.254.169.254 and RFC1918 from that subnet. Verified from a one-off container on that network: metadata endpoint and the VM's private address time out, `graph.facebook.com` is reachable. PostgreSQL stayed on the private network only and was not restarted (uptime > 12 h at the time).
- **Content:** shop name `Demo Mart Malaysia`, currency MYR; 14 AI-generated demonstration products (computers/IT and home & living, 3 photos each) were added with `scripts/seed-demo-shop.mjs` to the existing 35 sample products (49 total); a dry run preceded the real run and a second run created 0.
- **Not accepted / UNVERIFIED:** physical-device PWA install, Safari/iOS behaviour, real WhatsApp Cloud API traffic (Meta credentials not yet entered), scheduled backups (none installed by owner decision; only the one-off pre-release backup exists), Cloud Logging delivery of the claim log line, behaviour under load on the 2 GB VM.

Do not erase state or rerun initialize. Platform schema/version/migrations are protected by `src/platform/`; MOUNTS is unchanged. Provisioning is additive, resumes interrupted creation, validates boundaries and never changes existing passwords or shop tables. Its explicit `scripts/upgrade-platform.mjs --with-claim` invocation initializes/migrates platform to v2. The automatic OrbStack version stays 1 and its unflagged runner never applies migration 002. Claim-off fresh databases remain v1; claim-on fresh databases initialize v2, and existing v1 requires explicit upgrade. Retain the old controller baseline and keep the timer stopped pending review.

## Seller MCP schema25 manual release

Release requirements, not executed production evidence. GCP pauses protected changes; OrbStack instead automatically backs up and migrates eligible shop databases after a passing main release, even with MCP off. Required owner decision: **"merging = auto-migrate OrbStack production DB to schema 25; backups/rollback procedure"**. Stop its installed poller before merge if manual approval is intended. Image-only rollback cannot reverse committed schema25.

1. Stop `online-shopping-update.timer` and `online-shopping-update.service` before merge/deploy. Preserve private controller, units, runtime.env, images.env, compose.yaml, state.json and immutable current/previous digests. Never erase state or initialize again.
2. Pin reviewed full main SHA and exact-SHA CI/images. Verify on supported Node24/PostgreSQL16. Inventory default and every ACTIVE/SUSPENDED/DELETING shop, roles/schema versions, platform version and collision names/aliases. Reject incomplete backup coverage; preserve the PostgreSQL volume.
3. Stage reviewed release directory and immutable images without activation, MCP off. Validate mounted secrets, owner/app roles, config and headroom privately. Retain schema24 images/files; review DDL/grants and platform-version constraints.
4. Block ingress/issuance at the trusted gateway, drain requests and stop all backend/worker/provisioning writers. GCP does not mount OrbStack's maintenance volume. Keep PostgreSQL running privately.
5. Take a coordinated private cluster backup covering default, platform and every eligible tenant with the **running schema24 release's** backup tooling. Restore into isolated PostgreSQL16, compare schema/table digests and smoke business behavior. Record manifest, roles and sealed credential/key custody. Explicitly approve restore's loss of post-backup writes; backup existence alone is insufficient.
6. Run candidate `scripts/upgrade-database.mjs` in an isolated one-shot candidate backend digest container on `online-shopping-gcp_private`, entrypoint `node`, argv `/app/scripts/upgrade-database.mjs`, existing owner password file read-only at `/run/secrets/owner`, connection postgres:5432/online_shopping. Require `{"version":25}`; no secrets in argv/logs.
7. Migrate every eligible tenant using the reviewed exported `upgradePlatform` function, verified backup manifest and durable report, with `withClaim` matching installed platform version. The `--with-claim` CLI branch is platform-only and does not migrate tenants; unflagged CLI targets platform v1, not installed claim-v2. Mount platform password/master key privately. Verify complete attempted/upgraded coverage; on failure stop runners and restore the complete attempted set before old-image activation.
8. Independently verify shop version25 and app-role OAuth table SELECT/INSERT/UPDATE/DELETE, ordinary readiness, owner login, product/orders and tenant lifecycle/aliases with MCP off. Do not change platform version without separate approval.
9. Perform a privileged **Updater-class manual release**, not poll/initialize: load reviewed `update.py`, construct `Updater(root)`, require `head() == reviewed_sha` and `approved(reviewed_sha)`, obtain `baseline, content = source(reviewed_sha)` and `candidate = release(reviewed_sha, baseline, content)`. Recheck exact main/CI, then `activate(candidate)` (never `initial=True`) and `health(candidate)`. Keep ingress blocked. This activates backend/frontend without recreating PostgreSQL. Require frontend-proxied `/ready` exact revision and fictional checkout/seller/tenant smokes. Only after acceptance save the accepted candidate as current with no pending state and no schema24 previous-image recovery target: `save('deployed', current=candidate, previous=None, pending=None, local=local_fingerprint())`. Reopen only after acceptance. Failure requires schema25-compatible disabled images or coordinated restore, never schema24 images against schema25. Retain private old state for schema-aware rollback.
10. Enabling: `compose.gcp.yaml` forwards `MCP_ENABLED` (default 0) and `MCP_REDIRECT_URIS` (default empty) to the backend; `deploy/gcp/update.py` accepts both runtime keys, requires 0/1, exact comma-separated `https://` callbacks without ports, userinfo, queries or IPs, and refuses `MCP_ENABLED=1` without callbacks. The seller host proxies `/mcp`, `/oauth/{register,authorize,token,revoke,consent.js,consent.css}` and `/.well-known/oauth-{protected-resource,authorization-server}[/...]` with `Cache-Control: no-store`; tenant variants `/<code>/mcp`, `/<code>/oauth/*`, `/<code>/.well-known/oauth-*` go through the tenant API route; `mcp` and `oauth` are reserved tenant codes at the edge. The shop host serves none of them (`scripts/qa-gcp-caddy-routing.mjs`, group "Seller MCP connector routes"). Vendor callbacks from official docs (2026-10-21): Claude `https://claude.ai/api/mcp/auth_callback` (claude.com/docs/connectors/building/authentication), ChatGPT `https://chatgpt.com/connector_platform_oauth_redirect` (developers.openai.com/apps-sdk/build/auth). Both vendors call server-to-server, so `MCP_BROWSER_ORIGINS` is not forwarded.
11. After accepted manual release, use the Updater-class baseline procedure above to verify CI-approved main, source mounts, runtime, health and protected/local fingerprints, then save the new baseline and restart the timer. Keep schema24 previous images ineligible for image-only recovery. Schedule per-shop lifecycle cleanup, dormant audit retention and resource monitoring. Installed-controller identity, production migration/restore and vendor acceptance remain unverified here.

## Getting a SuperAdmin claim link yourself

While no SuperAdmin exists and `PLATFORM_ADMIN_CLAIM_ENABLED=1`, run on your own computer (logged-in `gcloud` with IAP SSH access to the VM):

```sh
scripts/gcp-claim-link.sh
```

It restarts only the backend container (stop-before-start, so every older link is invalidated), waits for health and prints the single `platform.claim.issued` log line. Open the printed `https://<shop host>/setup/#<code>` yourself within 30 minutes and register (email, username, password), then sign in at `https://<seller host>/platform/` and enrol TOTP. The code is a bearer secret: do not paste it anywhere. If a SuperAdmin already exists the script reports that no claim line exists. Override the target with `GCP_PROJECT`, `GCP_ZONE`, `GCP_INSTANCE`.

## Resetting a default-shop seller password yourself

The SuperAdmin console resets seller passwords of tenant shops only; the default shop's accounts are managed on the host. To set a temporary password for the default shop Owner (`owner`) or another of its seller accounts, run on your own computer:

```sh
scripts/gcp-reset-seller-password.sh            # Owner "owner"
scripts/gcp-reset-seller-password.sh someuser   # another seller account
```

You type the password twice (12-256 characters, not containing the username); it is not echoed, never placed on a local or remote command line, and only travels over the IAP SSH session's standard input into the backend container's environment, where `scripts/reset-seller-password.js` applies it. The account's sessions are ended and it must choose a new password at the next sign-in on `https://<seller host>/`. The script prints the result line and exits non-zero on failure (verified 2026-10-21 against live with a nonexistent username: `Could not reset: No account has this username.`, no account changed).

