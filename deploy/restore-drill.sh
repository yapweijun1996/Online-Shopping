#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <production-env-file> <encrypted-backup-file> <age-identity-file>" >&2
  exit 2
fi
for command_name in docker age; do
  command -v "$command_name" >/dev/null || { echo "Missing $command_name" >&2; exit 2; }
done
env_file=$1
backup_file=$2
identity_file=$3
test -r "$backup_file" && test -r "$identity_file" || {
  echo "Backup or identity file cannot be read." >&2
  exit 2
}

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
project="shop-restore-$(date -u +%s)-$$"
compose=(docker compose --project-name "$project" --env-file "$env_file" -f "$root/compose.restore.yaml")
cleanup() { "${compose[@]}" down --volumes >/dev/null; }
trap cleanup EXIT
"${compose[@]}" up -d --wait database
age -d -i "$identity_file" "$backup_file" | "${compose[@]}" exec -T database sh -c \
  'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl --exit-on-error'
version=$("${compose[@]}" exec -T database sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SELECT version FROM schema_meta WHERE id = 1"')
if [ "$version" != 10 ]; then
  echo "Restored schema version $version differs from expected version 10." >&2
  exit 1
fi
"${compose[@]}" exec -T database sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -Atqc "SELECT (SELECT count(*) FROM shop_order), (SELECT count(*) FROM order_event), (SELECT count(*) FROM product), (SELECT count(*) FROM checkout_idempotency)"'
echo "Isolated restore drill passed for schema version $version."
