#!/usr/bin/env node
/**
 * One-command customer demo: `npm run demo`.
 *
 * First run (a few minutes): starts a private Postgres in Docker, creates the database, loads the
 * framework library, builds the app, and fills in the demo story (scripts/demo/seed-story.mjs).
 * Later runs reuse all of that and start in seconds. Ctrl+C stops everything; the data is kept.
 *
 * Options:
 *   --reset      throw away the demo data and start fresh
 *   --no-open    do not open the browser
 * Environment (optional):
 *   DEMO_PORT=8080                    the address the app is shown on
 *   DEMO_ADMIN_DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres
 *                                     use an existing Postgres 16 superuser instead of Docker
 *                                     (it creates the sentinel_owner and sentinel_app roles and
 *                                     a sentinel_demo database, and sets those roles' passwords)
 *   DEMO_PG_IMAGE                     Postgres image for Docker (default postgres:16-alpine)
 *
 * Demo use only. Secrets are generated on this machine and kept in .demo/ (git ignored).
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { networkInterfaces, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STATE_DIR = join(ROOT, ".demo");
const STATE_FILE = join(STATE_DIR, "state.json");
const args = new Set(process.argv.slice(2));
const PORT = Number(process.env.DEMO_PORT ?? 8080);
const API_PORT = Number(process.env.DEMO_API_PORT ?? 3100);
const DB_PORT = Number(process.env.DEMO_DB_PORT ?? 55432);
const CONTAINER = "sentinel-demo-db";
const VOLUME = "sentinel-demo-db";
const IMAGE = process.env.DEMO_PG_IMAGE ?? "postgres:16-alpine";
const ORIGIN = `http://localhost:${PORT}`;
const IS_WIN = platform() === "win32";

// Docker Desktop on a Mac can leave its command-line tool off the PATH (user-level install).
if (platform() === "darwin") {
  const extra = [join(process.env.HOME ?? "", ".docker/bin"), "/Applications/Docker.app/Contents/Resources/bin", "/usr/local/bin", "/opt/homebrew/bin"];
  process.env.PATH = [...extra.filter((d) => existsSync(d)), process.env.PATH].join(":");
}

const say = (msg) => console.log(`\x1b[36m▸\x1b[0m ${msg}`);
const fail = (msg) => {
  console.error(`\n\x1b[31mCould not start the demo:\x1b[0m ${msg}\n`);
  process.exit(1);
};
const secret = () => randomBytes(24).toString("base64url");

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: opts.cwd ?? ROOT, stdio: opts.quiet ? "pipe" : "inherit", shell: IS_WIN && cmd !== process.execPath, env: { ...process.env, ...opts.env }, encoding: "utf8" });
  if (r.status !== 0 && !opts.allowFail) fail(opts.error ?? `"${cmd} ${cmdArgs.join(" ")}" failed${r.stderr ? `:\n${r.stderr.slice(-800)}` : ""}`);
  return r;
}

// ------------------------------------------------------------------ 1. basics

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) fail(`Node.js 22 or newer is needed (this is ${process.version}). Install the LTS version from https://nodejs.org and try again.`);
if (!existsSync(join(ROOT, "node_modules"))) {
  say("Installing packages (first run only, a minute or two)");
  run("npm", ["install"], { error: "npm install failed; check your internet connection and try again." });
}
const require = createRequire(join(ROOT, "apps/api/package.json"));
const pg = require("pg");

if (args.has("--reset")) {
  say("Resetting the demo data");
  if (!process.env.DEMO_ADMIN_DATABASE_URL) {
    run("docker", ["rm", "-f", CONTAINER], { quiet: true, allowFail: true });
    run("docker", ["volume", "rm", VOLUME], { quiet: true, allowFail: true });
  }
  const keep = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
  rmSync(join(STATE_DIR, "storage"), { recursive: true, force: true });
  rmSync(STATE_FILE, { force: true });
  if (process.env.DEMO_ADMIN_DATABASE_URL) writeState({ resetPending: true, pgPassword: keep.pgPassword });
}

function readState() {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
}
function writeState(s) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
const state = readState();
state.pgPassword ??= secret();
state.ownerPassword ??= secret();
state.appPassword ??= secret();
state.jwtSecret ??= randomBytes(48).toString("base64");
writeState(state);

// ------------------------------------------------------------------ 2. database

async function connectWithRetry(url, seconds) {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const c = new pg.Client({ connectionString: url });
    try {
      await c.connect();
      return c;
    } catch (e) {
      await c.end().catch(() => {});
      if (Date.now() > until) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/** Docker Desktop installed but closed: open it and wait. Not installed: say how to get it. */
async function startDocker() {
  const installed = run("docker", ["--version"], { quiet: true, allowFail: true }).status === 0
    || (platform() === "darwin" && existsSync("/Applications/Docker.app"));
  if (!installed)
    fail("Docker Desktop is not installed. Download it from https://www.docker.com/products/docker-desktop (on a Mac, pick Apple chip or Intel chip to match your Mac), install it, open it once and accept its terms, then run `npm run demo` again.");
  if (platform() === "darwin") run("open", ["-a", "Docker"], { quiet: true, allowFail: true });
  else if (IS_WIN && existsSync("C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"))
    spawn("C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe", [], { detached: true, stdio: "ignore" }).unref();
  say("Waiting for Docker Desktop to start (up to 2 minutes; accept its terms if it asks)");
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    if (run("docker", ["info"], { quiet: true, allowFail: true }).status === 0) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const why = run("docker", ["info"], { quiet: true, allowFail: true });
  const detail = (why.error?.message ?? why.stderr ?? "").trim().split("\n").slice(-2).join(" ");
  fail(`Docker Desktop did not finish starting. Open it yourself, finish any setup questions it shows, wait until it says "Engine running", then run \`npm run demo\` again.${detail ? `\n  (Docker said: ${detail})` : ""}`);
}

let adminUrl = process.env.DEMO_ADMIN_DATABASE_URL;
let dbHostPort;
if (adminUrl) {
  const u = new URL(adminUrl);
  dbHostPort = `${u.hostname}:${u.port || 5432}`;
  say(`Using your Postgres at ${dbHostPort}`);
} else {
  if (run("docker", ["info"], { quiet: true, allowFail: true }).status !== 0)
    await startDocker();
  const exists = run("docker", ["ps", "-a", "--filter", `name=^${CONTAINER}$`, "--format", "{{.Status}}"], { quiet: true }).stdout.trim();
  if (!exists) {
    say("Starting a private database in Docker (first run downloads it, about a minute)");
    run("docker", ["run", "-d", "--name", CONTAINER, "-e", `POSTGRES_PASSWORD=${state.pgPassword}`, "-p", `127.0.0.1:${DB_PORT}:5432`, "-v", `${VOLUME}:/var/lib/postgresql/data`, IMAGE], {
      quiet: true,
      error: `Docker could not start Postgres. If port ${DB_PORT} is busy, run with DEMO_DB_PORT set to another port.`,
    });
  } else if (!exists.startsWith("Up")) {
    say("Starting the demo database");
    run("docker", ["start", CONTAINER], { quiet: true });
  }
  adminUrl = `postgres://postgres:${encodeURIComponent(state.pgPassword)}@127.0.0.1:${DB_PORT}/postgres`;
  dbHostPort = `127.0.0.1:${DB_PORT}`;
}

let admin;
try {
  admin = await connectWithRetry(adminUrl, 60);
} catch (e) {
  if (/password authentication failed/.test(e.message) && !process.env.DEMO_ADMIN_DATABASE_URL)
    fail("The demo database belongs to an earlier setup. Run `npm run demo:reset` to start fresh.");
  fail(`could not connect to Postgres at ${dbHostPort}: ${e.message}`);
}
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const roleExists = async (name) => (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name])).rowCount > 0;
if (!(await roleExists("sentinel_owner"))) await admin.query("CREATE ROLE sentinel_owner LOGIN");
if (!(await roleExists("sentinel_app"))) await admin.query("CREATE ROLE sentinel_app LOGIN");
await admin.query(`ALTER ROLE sentinel_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${lit(state.ownerPassword)}`);
await admin.query(`ALTER ROLE sentinel_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT PASSWORD ${lit(state.appPassword)}`);
if (state.resetPending) {
  await admin.query("DROP DATABASE IF EXISTS sentinel_demo WITH (FORCE)");
  delete state.resetPending;
  writeState(state);
}
if ((await admin.query("SELECT 1 FROM pg_database WHERE datname = 'sentinel_demo'")).rowCount === 0) {
  await admin.query("CREATE DATABASE sentinel_demo OWNER sentinel_owner");
  await admin.query("REVOKE ALL ON DATABASE sentinel_demo FROM PUBLIC");
  await admin.query("GRANT CONNECT, TEMPORARY ON DATABASE sentinel_demo TO sentinel_app");
  state.storySeeded = false;
  writeState(state);
}
await admin.end();

const [dbHost, dbPort] = dbHostPort.split(":");
const ownerUrl = `postgres://sentinel_owner:${encodeURIComponent(state.ownerPassword)}@${dbHost}:${dbPort}/sentinel_demo`;
const appUrl = `postgres://sentinel_app:${encodeURIComponent(state.appPassword)}@${dbHost}:${dbPort}/sentinel_demo`;
const dbEnv = { NODE_ENV: "development", MIGRATION_DATABASE_URL: ownerUrl, DATABASE_URL: appUrl };

say("Preparing the database (framework library and demo accounts)");
run("npm", ["run", "db:migrate", "--silent"], { env: dbEnv, quiet: true });
run("npm", ["run", "db:seed", "--silent"], { env: dbEnv, quiet: true });

// ------------------------------------------------------------------ 3. web app build

const head = run("git", ["rev-parse", "HEAD"], { quiet: true, allowFail: true }).stdout?.trim() ?? "";
const dirty = run("git", ["status", "--porcelain", "apps/web", "packages"], { quiet: true, allowFail: true }).stdout?.trim() ?? "";
const buildKey = `${ORIGIN}/api|${head}|${dirty ? Date.now() : ""}`;
const distIndex = join(ROOT, "apps/web/dist/index.html");
if (!existsSync(distIndex) || state.webBuild !== buildKey) {
  say("Building the app (first run only, about a minute)");
  run(process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--logLevel", "warn"], {
    cwd: join(ROOT, "apps/web"),
    env: { VITE_API_URL: `${ORIGIN}/api` },
    quiet: true,
    error: "the app build failed",
  });
  state.webBuild = buildKey;
  writeState(state);
}

// ------------------------------------------------------------------ 4. start the API and the front door

const children = [];
function start(name, cmd, cmdArgs, env, cwd = ROOT) {
  const child = spawn(cmd, cmdArgs, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const logFile = join(STATE_DIR, `${name}.log`);
  writeFileSync(logFile, "");
  const append = (d) => writeFileSync(logFile, d, { flag: "a" });
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("exit", (code) => {
    if (!stopping) {
      console.error(`\n\x1b[31mThe ${name} stopped unexpectedly (code ${code}).\x1b[0m Details: ${logFile}`);
      shutdown(1);
    }
  });
  children.push(child);
  return child;
}

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  console.log("\nStopping the demo...");
  for (const c of children) c.kill();
  if (!process.env.DEMO_ADMIN_DATABASE_URL) run("docker", ["stop", CONTAINER], { quiet: true, allowFail: true });
  console.log("Stopped. Your demo data is kept; run `npm run demo` to start again.");
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const apiBase = `http://127.0.0.1:${API_PORT}`;
start("api", process.execPath, [join(ROOT, "node_modules/tsx/dist/cli.mjs"), "src/server.ts"], {
  ...dbEnv,
  API_HOST: "127.0.0.1",
  API_PORT: String(API_PORT),
  JWT_SECRET: state.jwtSecret,
  WEB_ORIGIN: ORIGIN,
  API_PUBLIC_URL: `${ORIGIN}/api`,
  STORAGE_DRIVER: "local",
  LOCAL_STORAGE_DIR: join(STATE_DIR, "storage"),
  LOG_LEVEL: "warn",
}, join(ROOT, "apps/api"));

async function waitFor(url, seconds) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
if (!(await waitFor(`${apiBase}/health`, 60))) fail(`the API did not start; see ${join(STATE_DIR, "api.log")}`);

if (!state.storySeeded) {
  say("Filling in the demo story (Harbor Logistics, two sites, findings, report, quote)");
  const { seedStory } = await import("./seed-story.mjs");
  try {
    await seedStory(apiBase, (m) => console.log(`    ${m}`));
  } catch (e) {
    fail(`the demo story could not be loaded: ${e.message}. Run \`npm run demo:reset\` to start fresh.`);
  }
  state.storySeeded = true;
  writeState(state);
}

start("web server", process.execPath, [join(ROOT, "scripts/demo-server.mjs")], { DEMO_PORT: String(PORT), DEMO_API: apiBase, INTERNAL_ORIGIN: ORIGIN });
if (!(await waitFor(`http://127.0.0.1:${PORT}/api/health`, 30))) fail(`port ${PORT} did not answer; if it is busy, run with DEMO_PORT set to another port.`);

const lan = Object.values(networkInterfaces()).flat().find((n) => n && n.family === "IPv4" && !n.internal)?.address;
console.log(`
\x1b[32m✔ Sentinel Assess demo is running\x1b[0m

  Open:  \x1b[1m${ORIGIN}\x1b[0m${lan ? `\n  Phone or tablet on the same Wi-Fi:  http://${lan}:${PORT}` : ""}

  Integrator (owner)     owner@acme.test         Sentinel-dev-2026!
  Field assessor         assessor@acme.test      Sentinel-dev-2026!
  Customer (client view) dana@harbor.example     Harbor-client-2026!

  Press Ctrl+C to stop. Your demo data is kept between runs.
`);

if (!args.has("--no-open")) {
  const opener = IS_WIN ? ["cmd", ["/c", "start", "", ORIGIN]] : platform() === "darwin" ? ["open", [ORIGIN]] : ["xdg-open", [ORIGIN]];
  try {
    spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {}
}
