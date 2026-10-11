# GitHub main automatic deployment

The OrbStack host checks `yapweijun1996/Online-Shopping` main every 120 seconds. It deploys only the exact commit whose latest **push** run of `.github/workflows/verify.yml` completed successfully. PR runs cannot authorize deployment. GitHub authentication uses the local `gh` keychain login; no webhook endpoint or GitHub-hosted runner receives host credentials.

## Release behavior

The private controller lives in `~/Library/Application Support/Online-Shopping/auto-deploy/auto-update.py`. Git checkouts and revision-tagged application images are immutable and separate from the development folder. The controller accepts only descendants of the installed commit; a force-push needs operator review. Build and database backup/isolated restore verification finish before cutover. A newer main push supersedes an older build.

Application services are recreated; PostgreSQL and the existing tunnel remain running. Both legacy domains must report the expected commit on `/health` and `/ready`, and the container image IDs must match. An ordinary failed cutover restores the previous application images without restoring database contents, preserving orders received during deployment. A pending interrupted cutover restores the recorded current release at the next check. Failed build/cutover commits require `--retry` or a newer commit.

Changes that need the operator pause automatic deployment as `manual_migration_required`: edits to `deploy/cloudflared.yml` or `deploy/init-postgres.sh`, and any rendered Compose change that touches the `postgres` or `tunnel` service, an existing secret, volume or network, or that gives an application service host privileges, a host-path mount outside the release, a host network or a port published beyond loopback (the reasons are recorded in `state.json` as `reasons`).

Everything else deploys automatically, including **new application services and new secrets in `compose.production.yaml`** and **database schema upgrades**. Main-shop schema changes use maintenance/drain, a verified deployment backup, durable upgrade intent and a named runner even with `PLATFORM_ENABLED` unset or `0`. A failed upgrade or cutover restores every attempted database before starting the previous application; an unverified restore keeps writes paused. Same-schema single-shop releases retain ordinary image rollback without restoring database contents. The recovery protocol is described below. Schema downgrades are never automatic. Changes to the updater/installer themselves do not replace the installed controller; review the diff, then copy the release's controller over the installed file while retaining a backup. The comparison of the database and tunnel services ignores how a Docker Compose version prints a mount (`bind.create_host_path: true`, the default, is omitted by newer versions). If `manual_migration_required` reports a seemingly unchanged service, compare the stored current and candidate `configs/<sha>.json` before treating it as a real change. Deployment recreates application services, so a brief interruption is possible.

## Multi-database operations (R3; controller installation in R4)

When the `platform` database exists, `deploy/backup-postgres.py` keeps the legacy `online_shopping` proof, then dumps the platform and every ACTIVE, SUSPENDED or DELETING shop. Each custom-format archive is mode 0600 and passes archive listing and an isolated restore. The proof compares schema hashes, per-table counts and sorted row-content hashes against one exported read-only snapshot of that database. Any failure fails the whole set. The private set manifest records archive hashes and verified evidence; it contains identifiers and proof hashes, never credentials or data rows. With no platform database, the existing single-database behavior remains.

The new controller first checks whether any main, platform or eligible shop schema needs an upgrade. Ordinary releases with matching versions do not pause traffic. For any schema upgrade, including a main-only upgrade with the platform disabled, it sets a flag on the project-owned `deployment_state` volume through a private operator container. The backend exposes read-only drain evidence at `/health` and returns 503 `DEPLOYMENT_MAINTENANCE` for business requests while the flag exists. In-flight HTTP work, the sequential WhatsApp worker and platform bootstrap/reconciliation must finish before the verified backup begins. The backend mounts the volume read-only; no public endpoint can change the flag. The maintenance flag survives application replacement and an interrupted controller.

The updater records database intent before starting a writer. Main upgrades run first; `scripts/upgrade-platform.mjs` then applies sequential numbered platform migrations and upgrades eligible shops with their own unsealed role credentials, even when the main version is unchanged. Platform schema v1 is the baseline; subsequent files use `002-description.sql` and consecutive version numbers. Each migration is transactional and advances `schema_meta` only on success. Newer-than-candidate schemas are refused.

Upgrade containers are named and recorded before `docker create`, then started separately. On failure or interrupted-controller recovery, the controller stops and confirms that every recorded runner is no longer running before restoring any database. It restores every attempted database, including a failed writer with an unknown commit outcome, from this deployment's verified manifest. Each replacement of the public schema is transactional and must match the original proof. A failed cutover after an upgrade performs the same restore before starting the previous application. Only a verified restore permits `migration_failed` or `rolled_back`; a restore failure keeps maintenance enabled as `migration_restore_failed` or `rollback_failed`.

Clearing migration intent is persisted before releasing maintenance. If the controller then stops, the next poll only finishes unpausing; it cannot restore an old snapshot after new orders have arrived. Do not edit private state or remove the flag by hand when restore verification failed. Keep the report, archives and logs, resolve the failure, and retry the controller. Backups are sensitive and unencrypted; retain them only in the private host backup directory.

The installed controller does not replace itself. After R4 is deployed and verified, retain `auto-update.py.bak.<date>`, copy the release's controller to the installed path with mode 0700, run `python3 -m py_compile`, and verify the next poll reports `up_to_date`. R4 adds a dedicated admin tunnel as a new service and secret; it does not change the protected existing tunnel. See [MULTI_TENANT_GOAL.md](MULTI_TENANT_GOAL.md) section 7 for the ordered activation procedure.

## Initial installation

Install OrbStack, `git`, `gh`, Python 3 and Node 24; authenticate `gh` as a repository reader. Complete the deployment in [ORBSTACK_DEPLOY.md](ORBSTACK_DEPLOY.md), preserving secret files under the private development `.local` directory. Prepare a clean detached checkout of a CI-passed main commit at `~/Library/Application Support/Online-Shopping/auto-deploy/releases/<full-sha>`. Use absolute secret paths in a private `runtime.env` in the state directory, set `DEPLOY_IMAGE_TAG=<full-sha>`, and render Compose with that checkout as `--project-directory`. Build and start frontend/backend with `--no-deps --wait`, then check both domains return that SHA. Preserve the previous rendered configuration and image IDs for bootstrap rollback.

After the baseline is serving, from the development checkout run:

```sh
python3 deploy/install-auto-update.py --revision <full-sha>
```

The installer verifies both live domains, image IDs and the baseline CI. It installs `com.gmb01.online-shopping.auto-update` and redirects the existing 03:00 backup job to the current immutable release. Both jobs share an exclusive lock, so backups and updates cannot overlap. The controller and state directory are private. No secret values are copied into Git.

## Operations

Inspect private `state.json` for `current.sha`, `previous.sha`, `last_status`, `checked_at` and `failed_sha`; logs are in the state directory's `logs/`. A normal state is `up_to_date` or `deployed`. `waiting_for_ci` leaves the live version unchanged. `manual_migration_required`, `build_failed`, `rolled_back` or `rollback_failed` require investigation. Notifications and release/backup retention are not configured.

```sh
# Run a check now (also used by the LaunchAgent).
python3 "$HOME/Library/Application Support/Online-Shopping/auto-deploy/auto-update.py"
# Retry a failed release after resolving its cause.
python3 "$HOME/Library/Application Support/Online-Shopping/auto-deploy/auto-update.py" --retry
# Verify a fresh backup of the currently serving release.
python3 "$HOME/Library/Application Support/Online-Shopping/auto-deploy/auto-update.py" --backup
# Stop automatic releases; services continue running.
launchctl bootout "gui/$(id -u)/com.gmb01.online-shopping.auto-update"
```

The user must be logged in, OrbStack running, GitHub credentials valid and the machine connected to the internet. Closed lid, shutdown or loss of power/network still makes this local host unavailable. Revision checkouts, images and verified dumps are retained; monitor disk space. Container secrets still reference their original private host files, so do not delete those files when cleaning the development folder.

## Platform runtime and dedicated admin tunnel

R4 requires seven new literal runtime keys: `PLATFORM_ENABLED`, `PLATFORM_ADMIN_HOST`, `PLATFORM_ADMIN_USERNAME`, `PLATFORM_ADMIN_PASSWORD_FILE_HOST`, `PLATFORM_DATABASE_PASSWORD_FILE_HOST`, `PLATFORM_PROVISIONER_PASSWORD_FILE_HOST`, `TUNNEL_ADMIN_CREDENTIALS_FILE_HOST`. Back up runtime.env before appending; use absolute paths to existing private files and leave its previous bytes and rendered rollback configurations unchanged. Missing or empty Compose settings fail before deployment. The three new password files and platform role/database setup precede wiring; platform schema v1 is frozen at that first production creation and subsequent changes require numbered migrations.

The new `tunnel-admin` runs without a profile and mounts only its own credentials and `deploy/cloudflared-admin.yml`. It routes `admin.gmb01.xyz` to Caddy, whose host block exposes platform paths/health/readiness and refuses shop/seller paths. The protected old tunnel, its credentials and config remain unchanged. Proxied DNS returns edge addresses; inspect the exact CNAME target through the authenticated read-only DNS API when verifying it. Bootstrap creates only the configured administrator and default-shop registry row; the executor never signs in or enrols production TOTP. MT-19/20/22 and private handoff evidence live in the ledger.
