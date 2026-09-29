#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
mkdir -p "$root/.local"
umask 077
directory=$(mktemp -d "$root/.local/pg-smoke.XXXXXXXX")
project="shop-smoke-$(date -u +%s)-$$"
env_file="$directory/stack.env"
compose=(docker compose --project-name "$project" --env-file "$env_file" -f "$root/compose.production.yaml")
cleanup() {
  "${compose[@]}" down --volumes >/dev/null 2>&1 || true
  for file in "$directory/admin-password" "$directory/db-password" "$env_file"; do
    if [ -f "$file" ]; then unlink "$file"; fi
  done
  rmdir "$directory"
}
trap cleanup EXIT

printf 'Q7%s' "$(openssl rand -hex 24)" > "$directory/admin-password"
openssl rand -hex 32 > "$directory/db-password"
cat > "$env_file" <<EOF
ADMIN_USERNAME=ci_owner
ADMIN_PASSWORD_FILE_HOST=$directory/admin-password
PGPASSWORD_FILE_HOST=$directory/db-password
PGDATABASE=online_shopping
PGUSER=shop_app
PUBLIC_ORIGIN=https://shop.example.test
FRONTEND_LOCAL_PORT=18082
SMOKE_PUBLIC_ORIGIN=https://shop.example.test
SMOKE_CLIENT_IP=198.51.100.57
EOF
"${compose[@]}" up -d --build --wait
node --env-file="$env_file" "$root/scripts/worker-smoke.js" http://127.0.0.1:18082 --rate-limit
