# GitHub main automatic deployment

The OrbStack host checks `yapweijun1996/Online-Shopping` main every 120 seconds. It deploys only the exact commit whose latest **push** run of `.github/workflows/verify.yml` completed successfully. PR runs cannot authorize deployment. GitHub authentication uses the local `gh` keychain login; no webhook endpoint or GitHub-hosted runner receives host credentials.

## Release behavior

The private controller lives in `~/Library/Application Support/Online-Shopping/auto-deploy/auto-update.py`. Git checkouts and revision-tagged application images are immutable and separate from the development folder. The controller accepts only descendants of the installed commit; a force-push needs operator review. Build and database backup/isolated restore verification finish before cutover. A newer main push supersedes an older build.

Only frontend and backend are recreated. PostgreSQL, tunnel, volumes and secrets remain running. Both domains must report the expected commit on `/health` and `/ready`, and the container image IDs must match. A failed cutover restores the previous application images. **Database contents are not rolled back**, preserving orders received during deployment. A pending interrupted cutover restores the recorded current release at the next check. Failed build/cutover commits require `--retry` or a newer commit.

Changes to the production Compose contract, PostgreSQL schema/version/adapter, role initialization or tunnel routing pause automatic deployment as `manual_migration_required`. Review and apply these changes with a backup and explicit migration plan. Changes to the updater/installer themselves do not replace the installed controller; review and reinstall explicitly. Other application changes must remain compatible with the live schema and prior release. Deployment recreates services, so a brief interruption is possible.

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
