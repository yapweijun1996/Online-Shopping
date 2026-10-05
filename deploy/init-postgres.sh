#!/bin/sh
set -eu
# This private environment value is consumed inside psql; never print or trace it.
export DATABASE_APP_PASSWORD="$(cat /run/secrets/database_password)"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_password DATABASE_APP_PASSWORD
CREATE ROLE online_shopping_app LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE online_shopping TO online_shopping_app;
GRANT USAGE ON SCHEMA public TO online_shopping_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO online_shopping_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO online_shopping_app;
SQL
unset DATABASE_APP_PASSWORD
