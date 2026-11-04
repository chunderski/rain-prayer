import { assertAppRoleSafe, buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/pool.js";

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const db = createDb(cfg.DATABASE_URL);
  await assertAppRoleSafe(db);
  const app = await buildApp(cfg, { db });
  app.addHook("onClose", async () => db.close());
  if (!cfg.google) app.log.info("Google sign-in disabled (GOOGLE_CLIENT_ID/SECRET not set)");

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: cfg.API_HOST, port: cfg.API_PORT });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
