#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <production-env-file> <rclone-remote-directory> <age-recipient>" >&2
  exit 2
fi
for command_name in docker age rclone shasum; do
  command -v "$command_name" >/dev/null || { echo "Missing $command_name" >&2; exit 2; }
done

umask 077
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
env_file=$1
remote_directory=${2%/}
recipient=$3
backup_directory="$root/.local/backups/production"
mkdir -p -m 700 "$backup_directory"
temporary=$(mktemp "$backup_directory/.backup-XXXXXXXX.age")
cleanup() { if [ -f "$temporary" ]; then unlink "$temporary"; fi; }
trap cleanup EXIT

compose=(docker compose --env-file "$env_file" -f "$root/compose.production.yaml")
"${compose[@]}" ps --status running database | grep -q database || {
  echo "Production database container is not running." >&2
  exit 1
}

name="online-shopping-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump.age"
"${compose[@]}" exec -T database sh -c \
  'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl' \
  | age -r "$recipient" > "$temporary"
test -s "$temporary"
local_hash=$(shasum -a 256 "$temporary" | awk '{print $1}')
remote_partial="$remote_directory/$name.partial"
remote_final="$remote_directory/$name"
rclone copyto "$temporary" "$remote_partial"
remote_hash=$(rclone cat "$remote_partial" | shasum -a 256 | awk '{print $1}')
if [ "$local_hash" != "$remote_hash" ]; then
  echo "Remote backup checksum differs; partial backup retained for inspection." >&2
  exit 1
fi
rclone moveto "$remote_partial" "$remote_final"
remote_hash=$(rclone cat "$remote_final" | shasum -a 256 | awk '{print $1}')
if [ "$local_hash" != "$remote_hash" ]; then
  echo "Final remote backup checksum differs." >&2
  exit 1
fi
mv "$temporary" "$backup_directory/$name"
echo "Encrypted backup verified locally and remotely: $name"
echo "SHA-256: $local_hash"
