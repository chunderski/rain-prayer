/**
 * Vitest global setup: (re)creates the sentinel_test database and the two roles, runs the
 * migrations as sentinel_owner, and seeds the fixture library plus dev tenants and users.
 *
 * Needs superuser access to the local Postgres: by default `su postgres -c psql` (when the
 * tests run as root), or set TEST_PG_ADMIN_URL to a superuser connection string.
 * Note: roles are cluster-wide, so this sets the sentinel_owner and sentinel_app passwords to
 * TEST_OWNER_PASSWORD and TEST_APP_PASSWORD (defaults in test/env.ts).
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/db/migrate.js";
import { seed } from "../src/db/seed.js";
import { APP_PASSWORD, OWNER_PASSWORD, OWNER_URL, TEST_DB } from "./env.js";

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function psqlAdmin(sql: string) {
  const adminUrl = process.env.TEST_PG_ADMIN_URL;
  const args = ["-v", "ON_ERROR_STOP=1", "-X", "-q"];
  if (adminUrl) {
    execFileSync("psql", [...args, adminUrl], { input: sql, stdio: ["pipe", "inherit", "inherit"] });
  } else if (process.getuid?.() === 0) {
    execFileSync("su", ["postgres", "-c", `psql ${args.join(" ")} -d postgres`], { input: sql, stdio: ["pipe", "inherit", "inherit"] });
  } else {
    throw new Error("setup-db: set TEST_PG_ADMIN_URL to a superuser connection string (or run as root with a local postgres user)");
  }
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export default async function setup() {
  if (!/^[a-z_][a-z0-9_]*$/.test(TEST_DB)) throw new Error("TEST_DB_NAME must be a plain identifier");
  psqlAdmin(`
SET client_min_messages = warning;
SELECT 'CREATE ROLE sentinel_owner LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_owner') \\gexec
SELECT 'CREATE ROLE sentinel_app LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_app') \\gexec
ALTER ROLE sentinel_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${lit(OWNER_PASSWORD)};
ALTER ROLE sentinel_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT PASSWORD ${lit(APP_PASSWORD)};
DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE);
CREATE DATABASE ${TEST_DB} OWNER sentinel_owner;
REVOKE ALL ON DATABASE ${TEST_DB} FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE ${TEST_DB} TO sentinel_app;
`);
  const quiet = () => {};
  await runMigrations(OWNER_URL, { log: quiet });
  await seed({ databaseUrl: OWNER_URL, dataDir: FIXTURES_DIR, strict: true, devData: true, log: quiet });
}
