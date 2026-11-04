/**
 * Applies SQL migrations from db/migrations in filename order, as the owner role
 * (MIGRATION_DATABASE_URL). Applied migrations are tracked with a checksum in
 * schema_migration; a changed checksum for an applied file is an error.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../db/migrations");
const LOCK_KEY = 72_401_337; // arbitrary advisory lock id for migrations

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(
  connectionString: string,
  opts: { dir?: string; log?: (msg: string) => void } = {},
): Promise<MigrationResult> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const log = opts.log ?? (() => {});
  const files = readdirSync(dir).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const client = new pg.Client({ connectionString });
  await client.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migration (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migration");
    const done = new Map(rows.map((r) => [r.name, r.checksum]));
    for (const file of files) {
      const sql = readFileSync(join(dir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const prior = done.get(file);
      if (prior) {
        if (prior !== checksum) throw new Error(`Migration ${file} was changed after it was applied; add a new migration instead.`);
        result.skipped.push(file);
        continue;
      }
      log(`applying ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migration (name, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      result.applied.push(file);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    await client.end();
  }
  return result;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error("MIGRATION_DATABASE_URL is required (owner role connection string).");
    process.exit(1);
  }
  runMigrations(url, { log: (m) => console.log(m) })
    .then((r) => console.log(`migrations: ${r.applied.length} applied, ${r.skipped.length} already applied`))
    .catch((err) => {
      console.error((err as Error).message);
      process.exit(1);
    });
}
