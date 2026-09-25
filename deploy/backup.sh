#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

env_file=${1:-.local/docker.env}
shop_project=${2:-online-shopping}
if [[ ! "$shop_project" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo 'Project name must use lowercase letters, digits, hyphens, or underscores.' >&2
  exit 1
fi
if [[ ! -f "$env_file" ]]; then
  echo 'Docker environment file is missing.' >&2
  exit 1
fi
if ! docker volume inspect "${shop_project}_db_data" >/dev/null 2>&1; then
  echo 'Database volume is missing; refusing to create an empty backup.' >&2
  exit 1
fi

compose=(docker compose --env-file "$env_file" -p "$shop_project")
backend_image=$("${compose[@]}" images -q backend)
if [[ -z "$backend_image" ]]; then
  echo 'Backend image is missing; start the stack before backing it up.' >&2
  exit 1
fi

backup_dir="$repo_root/.local/backups"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
backup_name="${shop_project}-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
backup_path="$backup_dir/$backup_name"
backup_partial="$backup_path.partial"
if [[ -e "$backup_path" || -e "$backup_partial" ]]; then
  echo 'A backup with this timestamp already exists; retry in one second.' >&2
  exit 1
fi

restart_stack() { "${compose[@]}" up -d; }
trap restart_stack EXIT
"${compose[@]}" stop frontend backend
docker run --rm --user 0:0 --network none \
  -v "${shop_project}_db_data:/source:ro" \
  -v "$backup_dir:/backups" \
  "$backend_image" sh -c 'test -f /source/online-shopping.db && umask 077 && tar -czf "/backups/$1" -C /source .' _ "$backup_name.partial"
tar -tzf "$backup_partial" >/dev/null
mv "$backup_partial" "$backup_path"
chmod 600 "$backup_path"
openssl dgst -sha256 -r "$backup_path" | cut -d ' ' -f 1 > "$backup_path.sha256"
chmod 600 "$backup_path.sha256"
restart_stack
trap - EXIT
printf 'Backup verified at %s\n' "$backup_path"
