import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { loadLibraryLenient, seed } from "../src/db/seed.js";
import { OWNER_URL, withClient } from "./helpers.js";
import { FIXTURES_DIR } from "./setup-db.js";

const counts = () =>
  withClient(OWNER_URL, async (c) => {
    const out: Record<string, number> = {};
    for (const t of ["framework_version", "requirement", "shared_control", "question", "crosswalk", "app_user"]) {
      out[t] = (await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    }
    return out;
  });

describe("migrations and seed", () => {
  it("re-running migrations is a no-op", async () => {
    const r = await runMigrations(OWNER_URL);
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual(["001_reference.sql", "002_tenant.sql", "003_auth_functions.sql", "004_field.sql", "005_risk_report.sql"]);
  });

  it("re-running the seed is idempotent", async () => {
    const before = await counts();
    await seed({ databaseUrl: OWNER_URL, dataDir: FIXTURES_DIR, strict: true, log: () => {} });
    expect(await counts()).toEqual(before);
  });

  it("lenient load skips invalid files and dangling crosswalk entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "lib-"));
    try {
      cpSync(FIXTURES_DIR, dir, { recursive: true });
      writeFileSync(join(dir, "frameworks", "broken.json"), "{ not json");
      writeFileSync(join(dir, "crosswalk.json"), JSON.stringify({
        libraryVersion: "0.1.0",
        entries: [
          { sharedControlId: "SC-PER-001", frameworkId: "test-fw", requirementCode: "TF-01", relationship: "satisfies", rationale: "kept entry" },
          { sharedControlId: "SC-PER-001", frameworkId: "missing-fw", requirementCode: "X", relationship: "supports", rationale: "dropped entry" },
        ],
      }));
      const logs: string[] = [];
      const lib = loadLibraryLenient(dir, (m) => logs.push(m));
      expect(lib?.frameworks).toHaveLength(1);
      expect(lib?.crosswalk).toHaveLength(1);
      expect(logs.join("\n")).toMatch(/broken\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lenient load of an empty library returns null", () => {
    const dir = mkdtempSync(join(tmpdir(), "lib-"));
    try {
      expect(loadLibraryLenient(dir, () => {})).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
