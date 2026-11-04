#!/bin/sh
# Docker Postgres first-boot init: creates the two Sentinel roles.
#   sentinel_owner: owns the schema; used only by migrations and the seed loader.
#   sentinel_app:   used by the API; never owner, never superuser, cannot bypass RLS.
# Passwords come from SENTINEL_OWNER_PASSWORD and SENTINEL_APP_PASSWORD (see .env.example).
set -eu

: "${SENTINEL_OWNER_PASSWORD:?SENTINEL_OWNER_PASSWORD must be set}"
: "${SENTINEL_APP_PASSWORD:?SENTINEL_APP_PASSWORD must be set}"
DB="${POSTGRES_DB:-sentinel}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$DB" \
  -v owner_pw="$SENTINEL_OWNER_PASSWORD" -v app_pw="$SENTINEL_APP_PASSWORD" -v db="$DB" <<'SQL'
SELECT 'CREATE ROLE sentinel_owner LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_owner') \gexec
SELECT 'CREATE ROLE sentinel_app LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_app') \gexec
ALTER ROLE sentinel_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'owner_pw';
ALTER ROLE sentinel_app   WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT PASSWORD :'app_pw';
-- The owner role owns the database, and therefore the public schema (PG 15+ pg_database_owner).
ALTER DATABASE :"db" OWNER TO sentinel_owner;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"db" TO sentinel_app;
SQL
