# GCP deployment

This deployment is separate from the existing OrbStack/Cloudflare deployment. It uses the existing GCP `e2-micro` VM (1 GiB RAM, 20 GiB disk, 2 GiB swap), shared Caddy gateway and Docker Compose. It creates a **new PostgreSQL volume**; no old data or secrets are imported. Keep the existing USD 20/month budget; no VM, paid service or load balancer is created by these files.

## Trust boundary and runtime policy

The public gateway terminates TLS for `demoonlineshopping.xyz` and `seller.demoonlineshopping.xyz`, preserves `Host`, and **overwrites** `X-Real-IP` with the client IP from the connection. Connect only that trusted gateway to the external `online-shopping-edge` network and proxy both hosts to `online-shopping-frontend:80`. Do not expose application or PostgreSQL ports. Anyone allowed onto this network could forge client IP headers. There are no Cloudflare headers or services in this deployment.

The frontend mounts `deploy/gcp/Caddyfile` and serves the existing frontend image. Customer and seller paths are separated; unknown paths, platform/demo paths and tenant prefixes fail closed. The initial platform is disabled, so there is no tenant routing. Backend uses `TRUST_PROXY=1`, exact public/seller HTTPS origins, manual shop mode, no quick login, and no integration key file. Omitting the integration key also prevents the outbound WhatsApp worker from starting. No Docker socket is mounted in any application container.

The backend runs as the existing image's `node` user, read only, with a 256 MiB memory cap and 128 MiB V8 heap; frontend has 48 MiB; PostgreSQL has 192 MiB, 20 connections and 32 MiB shared buffers. The PostgreSQL owner and application role have separate passwords. The existing `deploy/init-postgres.sh` grants DML to `online_shopping_app`; the app receives only that role's secret. This does not make audit tables immutable. The internal per-project network prevents backend/DB internet egress. Resource caps are initial conservative limits, not evidence that every large catalog/workload fits; observe OOM events, latency, swap and disk after deployment.

## CI images

`.github/workflows/gcp-images.yml` runs only after a successful same-repository `push` of `main` through `Verify new MVP`. It checks out that exact tested SHA, builds `linux/amd64`, and publishes backend/frontend images with SHA tags and OCI revision labels. Actions are pinned to authoritative upstream Git refs checked during implementation. CI has only `contents: read` and `packages: write`; there are no VM credentials or VM builds.

After the first publication, make both GHCR packages **public** in their package settings. The host uses anonymous public GitHub and GHCR, with its own empty Docker credential configuration and no PAT. Do not make the repository public merely to enable this method: anonymous source access is a prerequisite, and private repositories need a separately reviewed authentication design.

## Initial operator installation

Review the exact release and verify its CI before installation. All commands below run on the existing VM as root. The installer is intentionally manual: automatic updates cannot replace the updater, Compose policy, runtime configuration or systemd units.

1. Create `/opt/online-shopping-gcp` owned by root, mode `0700`; every ancestor must be root owned and not writable by group/others. Copy `deploy/gcp/update.py` to `update.py`, `compose.gcp.yaml` to `compose.yaml`, and `deploy/gcp/runtime.env.example` to `runtime.env`, each root owned, mode `0600`. Set the four explicit runtime keys only; the updater rejects duplicate/extra keys, shell interpolation, invalid hostnames and unsafe paths. No secrets belong in these files.
2. Create `/opt/cloudops/secrets/online-shopping` root owned, mode `0700`. Generate three separate strong secrets outside Git: `admin-password` (the existing application requires at least 16 characters, letters and digits, and rejects weak passwords), `postgres-password`, and `postgres-owner-password`. Docker Compose file-backed secrets retain host file permissions: the backend's non-root `node` user must be able to read its mounted admin/app secrets. Use root-owned mode `0444` secret files inside the root-only `0700` host directory, or an explicitly reviewed UID/ACL mapping. Never print the values or use command-line password arguments. Do not reuse any existing app/database secrets.
3. Ensure `online-shopping-edge` exists and connect the shared gateway; configure the two gateway hosts above. Configure DNS/firewall for the shared gateway's existing 80/443 only. Do not add app/database published ports.
4. Initialize with the exact current full main SHA (replace the placeholder):

   ```sh
   python3 /opt/online-shopping-gcp/update.py --root /opt/online-shopping-gcp initialize --sha FULL_40_HEX_MAIN_SHA
   ```

   Initialization verifies main and the latest exact-SHA `verify.yml` push run, downloads only schema/init/Caddy configuration from that trusted SHA, verifies Git blob hashes, anonymously pulls both image tags, resolves immutable digests, checks labels/platform, and starts the full stack. It saves `state.json` only after backend readiness and frontend-proxied readiness return the expected revision. The schema/init files run only when PostgreSQL initializes the new empty volume. If an initial deployment fails, inspect private container health diagnostics without publishing logs; initialization can be retried after resolving the cause. Do not delete a nonempty DB volume as a retry strategy.
5. Verify both public hosts, expected 404 cross-host routes, login, and a fictional catalog/order scenario. Confirm owner/app DB separation, startup opt-out flags, no extra ports/socket mounts, and available RAM/disk. This manual public check also establishes actual gateway TLS/header policy; local updater checks do not prove it.
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
