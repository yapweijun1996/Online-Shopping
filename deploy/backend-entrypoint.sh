#!/bin/sh
set -eu

# Compose file-backed secrets preserve host ownership on Linux. Copy them into
# the container's tmpfs before dropping privileges to the Node user.
umask 077
cp /run/secrets/admin_password /tmp/admin_password
cp /run/secrets/db_password /tmp/db_password
chown node:node /tmp/admin_password /tmp/db_password
chmod 0400 /tmp/admin_password /tmp/db_password
export ADMIN_PASSWORD_FILE=/tmp/admin_password
export PGPASSWORD_FILE=/tmp/db_password
exec su-exec node node src/server.js
