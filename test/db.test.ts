// Migrations are pinned and re-runnable; the daily backup writes a dated copy and keeps 30.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { dailyJob, KEEP_BACKUPS } from "../src/jobs";
import { publicPage } from "./helpers";

describe("migrations", () => {
  it("the newest schema_version row is the newest migration file", async () => {
    const newestFile = env.TEST_MIGRATIONS.map((m) => m.name.replace(/\.sql$/, "")).sort().at(-1);
    const newestRow = await env.DB.prepare("SELECT migration FROM schema_version ORDER BY migration DESC LIMIT 1").first<{ migration: string }>();
    expect(newestRow!.migration).toBe(newestFile);
  });
  it("re-applying every migration changes nothing", async () => {
    await publicPage("/");
    const before = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM versions) AS v, (SELECT COUNT(*) FROM schema_version) AS s").first();
    for (const m of env.TEST_MIGRATIONS) for (const q of m.queries) await env.DB.prepare(q).run();
    const after = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM versions) AS v, (SELECT COUNT(*) FROM schema_version) AS s").first();
    expect(after).toEqual(before);
  });
});

describe("the Worker module", () => {
  it("exports only the handler (the runtime refuses to start a Worker with any other named export)", async () => {
    const mod = await import("../src/index");
    expect(Object.keys(mod)).toEqual(["default"]);
    expect(typeof mod.default.fetch).toBe("function");
    expect(typeof mod.default.scheduled).toBe("function");
  });
});

describe("daily backup", () => {
  it("writes today's backup with real rows and keeps only the newest 30", async () => {
    await publicPage("/");
    for (let i = 0; i < 33; i++) await env.BACKUPS.put(`backup:2020-01-${String(i + 1).padStart(2, "0")}`, "{}");
    const census = await dailyJob(env as any, Math.floor(Date.UTC(2026, 10, 3, 9) / 1000));
    expect(census).toMatch(/backup 2026-11-03: \d+ rows/);
    const keys = (await env.BACKUPS.list({ prefix: "backup:" })).keys.map((k) => k.name);
    expect(keys).toHaveLength(KEEP_BACKUPS);
    expect(keys).toContain("backup:2026-11-03");
    const b = JSON.parse((await env.BACKUPS.get("backup:2026-11-03"))!);
    expect(b.tables.versions.length).toBeGreaterThan(0);
    expect(b.tables.settings.length).toBe(2);
  });
});
