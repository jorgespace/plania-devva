// PLA-I68-6: environments with a server and a database from any service. Environments of every kind are added, edited
// and removed; providers list what their saved key opens (projects, branches, releases) and give variable NAMES only;
// production's migration path, SQL review, destructive-migration approval (tied to the file's sha256), backup and freeze
// window drive Publicar. A fake service API and gh; squawk runs when it is installed. Test DB only.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { createHash } from "node:crypto";
import pg from "pg";
import { PG_USER, resetTestStore, useTestEnv, type TestStore } from "./helpers.js";

useTestEnv();
const { app } = await import("../src/app.js");
const { createSession, SESSION_COOKIE } = await import("../src/auth/session.js");
const { makeDb } = await import("../src/db/client.js");
const { createTask } = await import("../src/mcp/writes.js");
const { setProject } = await import("../src/mcp/project.js");
const { findProject } = await import("../src/mcp/queries.js");
const keys = await import("../src/camino/keys.js");
const { caminoDeps, caminoRead } = await import("../src/camino/store.js");
const { applyChanges } = await import("../src/camino/changes.js");
const { listFor, varsFor } = await import("../src/camino/envs.js");
const { destructive, frozen, prodEnvOf, prodMigrationsFromEnv, sha256 } = await import("../src/camino/prod.js");
const { runSquawk } = await import("../src/camino/squawk.js");
const { localMigrationCount } = await import("../src/camino/approve.js");
const { releasePlan } = await import("../src/mcp/release-plan.js");
const { releaseGh, shipDeps, shipRelease } = await import("../src/mcp/release-ship.js");
const E = (await import(new URL("../ui/src/lib/camino-entornos.ts", import.meta.url).href)) as typeof import("../ui/src/lib/camino-entornos.js");

type Json = Record<string, any>;
let testStore: TestStore;
// Newest first; rows one write stamped alike count in the order they were made.
const newestFirst = <T extends { at: Date }>(rows: T[]): T[] => [...rows].reverse().sort((a, b) => b.at.getTime() - a.at.getTime());
// The camino row's config with some keys replaced (the jsonb || of main's test).
const mergeConfig = (projectId: string, patch: Json) =>
  testStore.fix(async (uow) => {
    const cur = (await uow.get("camino", { projectId }))!;
    await uow.update("camino", { projectId }, { config: { ...cur.config, ...patch } });
  });
let db: ReturnType<typeof makeDb>["db"];
let closeDb: () => Promise<void>;
const ctx = { actor: { agent: "t", session_id: "s-i68-6", machine: "ci" } };
const human = { ...ctx, human: true };
const REPO = "acme/zigzag";
const KEY = "vcp_0123456789abcdefWXYZ";
const store = new keys.MemoryCaminoKeyStore();
const squawkAvailable = (await runSquawk("m.sql", "select 1;")).available;

const ok = (data: unknown, status = 200) => ({ status, headers: { get: () => null }, json: async () => data });
const fakeFetch = async (url: string, init?: { headers?: Record<string, string> }) => {
  if (init?.headers?.Authorization !== `Bearer ${KEY}` && !url.startsWith("https://api.github.com")) return ok({ error: "no" }, 403);
  if (url === "https://api.vercel.com/v9/projects?limit=50") return ok({ projects: [{ id: "prj_1", name: "tienda", targets: { production: { alias: ["tienda.example.com"] } } }] });
  if (url.startsWith("https://api.vercel.com/v9/projects/prj_1/env")) return ok({ envs: [{ key: "DATABASE_URL", value: "postgres://secret", target: ["production"] }, { key: "AUTH_SECRET", value: "shh", target: ["production", "preview"] }, { key: "PREVIEW_ONLY", value: "x", target: ["preview"] }] });
  if (url === "https://console.neon.tech/api/v2/projects?limit=50") return ok({ projects: [{ id: "np_1", name: "tienda-db", region_id: "aws-us-east-2" }] });
  if (url.startsWith("https://console.neon.tech/api/v2/projects/np_1/branches")) return ok({ branches: [{ id: "br_1", name: "main", default: true }, { id: "br_2", name: "preview" }] });
  if (url.startsWith(`https://api.github.com/repos/${REPO}/releases`)) return ok([{ id: 9, tag_name: "v1.2.0", html_url: "https://github.com/x/releases/v1.2.0", prerelease: false }]);
  if (url === "https://api.github.com/user") return ok({ login: "acme" });
  return ok({ message: "Not Found" }, 404);
};
const cookie = () => `${SESSION_COOKIE}=${createSession()}`;
const post = (p: string, body: unknown) => app.request(`/api/company${p}`, { method: "POST", headers: { Cookie: cookie(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
const version = async () => (await testStore.get("camino", { projectId: await testStore.projectId("zigzag") }))?.version ?? 0;
const prod = (over: Json = {}) => ({ ...E.newEnv([], "produccion", "Producción", "main"), record: "prod", server: { provider: "vercel", project: "tienda", note: null }, ...over });

before(async () => {
  testStore = await resetTestStore();
  const made = makeDb();
  db = made.db;
  closeDb = made.close;
  keys.useCaminoKeyStore(store);
  await store.set("zigzag", "vercel", KEY);
  await store.set("zigzag", "neon", KEY);
  Object.assign(caminoDeps, { fetch: fakeFetch, env: { ...process.env, GITHUB_TOKEN: "ghp_test" }, now: () => new Date(), listDatabases: async () => [] });
  const p = await findProject(db, "zigzag");
  await setProject(db, { project: "zigzag", version: p.version, settings: { github: { repo: REPO }, release: { from: "sandbox", into: "main", env: "prod", mode: "merge" } } }, ctx);
});
after(async () => {
  keys.useCaminoKeyStore(null);
  await closeDb?.();
  await testStore?.end();
});

describe("environments of every kind", () => {
  test("a new environment of each kind carries sensible defaults and a unique id", () => {
    const a = E.newEnv([], "temporal", "Previas", "sandbox");
    assert.deepEqual([a.id, a.runs, a.database?.data], ["previas", { kind: "pr" }, "falsos"]);
    const p = E.newEnv([a], "produccion", "Producción", "main");
    assert.deepEqual([p.id, p.record, p.database?.migrate_when, p.database?.sql_review, p.database?.approve_destructive], ["produccion", "prod", "paso", true, true]);
    assert.equal(E.newEnv([p], "produccion", "Producción", "main").id, "produccion-2");
    assert.deepEqual(E.newEnv([], "versiones", "Versiones", "main").runs, { kind: "tags", pattern: "v*" });
    assert.equal(E.newEnv([], "versiones", "Versiones", "main").database, null);
  });

  test("they are added, edited and removed through the change set, and the read shows them", async () => {
    const envs = [prod(), E.newEnv([], "permanente", "Copia", "sandbox")];
    let out = await applyChanges(db, "zigzag", { version: await version(), changes: [{ kind: "config", label: "Entornos", patch: { envs } }] });
    assert.equal(out.applied, 1);
    assert.deepEqual((await caminoRead(db, "zigzag")).config.envs.map((e) => e.name), ["Producción", "Copia"]);
    out = await applyChanges(db, "zigzag", { version: await version(), changes: [{ kind: "config", label: "Entornos", patch: { envs: [{ ...envs[0]!, name: "Producción web" }] } }] });
    const read = await caminoRead(db, "zigzag");
    assert.deepEqual(read.config.envs.map((e) => e.name), ["Producción web"]);
    assert.equal(read.config.source.envs, "camino");
  });

  test("variables are compared by name; no value is ever kept or shown", async () => {
    assert.deepEqual(E.varsDiff(["DATABASE_URL", "AUTH_SECRET", "GOOGLE_ID"], ["DATABASE_URL", "AUTH_SECRET"]), { ok: ["DATABASE_URL", "AUTH_SECRET"], missing: ["GOOGLE_ID"] });
    const p = await findProject(db, "zigzag");
    const out = await varsFor(p, "vercel", fakeFetch, "prj_1", "production");
    assert.deepEqual(out, { names: ["DATABASE_URL", "AUTH_SECRET"], connected: true });
    assert.ok(!JSON.stringify(out).includes("secret") && !JSON.stringify(out).includes("shh"));
    const res = await post("/projects/zigzag/camino/providers/vercel/vars", { project: "prj_1", target: "production" });
    const text = await res.text();
    assert.ok(!text.includes("postgres://") && !text.includes("shh"), text);
  });
});

describe("picked from what the key opens", () => {
  test("Vercel projects with their domain, Neon projects and branches, the repo's releases; no key, nothing", async () => {
    const p = await findProject(db, "zigzag");
    assert.deepEqual((await listFor(p, "vercel", fakeFetch, {})).items, [{ id: "prj_1", name: "tienda", url: "https://tienda.example.com" }]);
    assert.deepEqual((await listFor(p, "neon", fakeFetch, {})).items.map((x) => x.name), ["tienda-db"]);
    assert.deepEqual((await listFor(p, "neon", fakeFetch, { project: "np_1" })).items.map((x) => [x.name, x.note]), [["main", "default"], ["preview", null]]);
    const { ghApi } = await import("../src/camino/github.js");
    assert.deepEqual((await listFor(p, "github_releases", fakeFetch, { gh: ghApi("x", "t", fakeFetch) })).items.map((x) => x.name), ["v1.2.0"]);
    assert.deepEqual(await listFor(p, "netlify", fakeFetch, {}), { items: [], connected: false });
    await store.delete("zigzag", "neon");
    assert.equal((await listFor(p, "neon", fakeFetch, {})).connected, false);
    await store.set("zigzag", "neon", KEY);
    const bad = await post("/projects/zigzag/camino/providers/heroku/list", {});
    assert.equal(((await bad.json()) as Json).error, "CAMINO_PROVIDER_UNKNOWN");
  });

  // The count is read on this machine's Postgres only (localPgClient connects on loopback, as PGUSER): there is no
  // address to point elsewhere. A throwaway plania_test_ database stands for a product's; with no local Postgres, it skips.
  test("the local database's migration table is read", async (t) => {
    const user = decodeURIComponent(PG_USER);
    const name = `plania_test_i68_6_${createHash("sha256").update(import.meta.dirname).digest("hex").slice(0, 6)}`;
    const admin = new pg.Client({ host: "127.0.0.1", user, database: "postgres", connectionTimeoutMillis: 3_000 });
    admin.on("error", () => undefined);
    try {
      await admin.connect();
    } catch {
      t.skip("no local Postgres answers on 127.0.0.1");
      return;
    }
    const was = process.env.PGUSER;
    process.env.PGUSER = user;
    try {
      await admin.query(`drop database if exists ${name} with (force)`);
      await admin.query(`create database ${name}`);
      const c = new pg.Client({ host: "127.0.0.1", user, database: name });
      await c.connect();
      await c.query(`create schema if not exists drizzle; create table if not exists drizzle.__drizzle_migrations (id serial primary key); insert into drizzle.__drizzle_migrations default values; insert into drizzle.__drizzle_migrations default values;`);
      await c.end();
      assert.deepEqual(await localMigrationCount(name, "drizzle"), { ok: true, count: 2 });
    } finally {
      if (was === undefined) delete process.env.PGUSER;
      else process.env.PGUSER = was;
      await admin.query(`drop database if exists ${name} with (force)`).catch(() => undefined);
      await admin.end();
    }
  });
});

describe("production drives Publicar", () => {
  test("who migrates, the freeze window, destructive statements", () => {
    assert.equal(prodMigrationsFromEnv(prod({ database: { ...prod().database!, provider: "neon", migrate_when: "paso" } }) as never), "deploy");
    assert.equal(prodMigrationsFromEnv(prod({ database: { ...prod().database!, provider: "neon", migrate_when: "mano" } }) as never), "owner");
    assert.equal(prodMigrationsFromEnv(prod({ database: null }) as never), "none");
    assert.equal(prodMigrationsFromEnv(prod() as never), null, "a database with no service says nothing yet");
    assert.equal(E.whoMigrates(prod({ database: { ...prod().database!, provider: "neon", migrate_when: "build" } }) as never), "deploy");
    const fri = new Date(2026, 10, 20, 18, 30);
    assert.equal(frozen(prod({ freeze: true }) as never, fri), true);
    assert.equal(frozen(prod({ freeze: true }) as never, new Date(2026, 10, 20, 17, 59)), false);
    assert.equal(frozen(prod({ freeze: false }) as never, fri), false);
    assert.equal(E.inFreeze(fri), true);
    assert.deepEqual(destructive("ALTER TABLE users ADD COLUMN age int;\n-- DROP TABLE x;\nDROP TABLE old_logs;\nALTER TABLE users DROP COLUMN nick;\nDELETE FROM sessions;\nDELETE FROM carts WHERE id = 1;\nTRUNCATE events;"), ["DROP TABLE old_logs", "ALTER TABLE users DROP COLUMN nick", "TRUNCATE events", "DELETE FROM sessions"]);
    assert.match(E.rolesSql("tienda"), /CREATE ROLE tienda_migrate LOGIN/);
  });

  test("PLA-158 (F-25): «Usar lo recomendado» also says when production migrates, and names the database when it is missing", () => {
    const db = prod().database!;
    const known = E.prodRecommended({ ...db, provider: "neon", migrate_when: "mano", sql_review: false, backup: "ninguna" });
    assert.deepEqual(known.patch, { sql_review: true, approve_destructive: true, backup: "proveedor", provider: "neon", migrate_when: "paso" });
    assert.equal(known.missing, null);
    assert.equal(known.done, false);
    const after = { ...db, ...known.patch } as never;
    assert.equal(prodMigrationsFromEnv(prod({ database: after }) as never), "deploy", "after the click Publicar knows who migrates");
    assert.equal(E.prodRecommended(after).done, true);
    const unknown = E.prodRecommended({ ...db, provider: null });
    assert.equal(unknown.missing, "provider");
    assert.equal("provider" in unknown.patch, false, "the service is never guessed");
    assert.equal(unknown.done, false);
    const saved = E.prodRecommended({ ...db, provider: null }, "supabase");
    assert.deepEqual([saved.missing, saved.patch.provider, saved.patch.migrate_when], [null, "supabase", "paso"], "a database service with a saved key counts as known");
    assert.equal(E.envFocus("produccion", "base"), "env-produccion-base");
  });

  test("Publicar reads production's migration path from Camino when the release step names none", async () => {
    const p = await findProject(db, "zigzag");
    const env = prod({ database: { ...prod().database!, provider: "neon", migrate_when: "paso", sql_review: true, approve_destructive: true } });
    await mergeConfig(p.id, { envs: [env] });
    const cfg = (await testStore.get("camino", { projectId: p.id }))!.config;
    assert.equal(prodEnvOf(cfg, p.settings.release)?.id, "produccion");
    const plan = (await releasePlan(db, await findProject(db, "zigzag")))!;
    assert.equal(plan.prod_migrations, "deploy");
    assert.equal(plan.prod_env?.sql_review, true);
    assert.equal(plan.prod_env?.db_missing, null);
    // PLA-158 (F-25): a database with no service is the field the screen names.
    await mergeConfig(p.id, { envs: [prod()] });
    const unset = (await releasePlan(db, await findProject(db, "zigzag")))!;
    assert.equal(unset.prod_migrations, null);
    assert.equal(unset.prod_env?.db_missing, "provider");
    await mergeConfig(p.id, { envs: [env] });
  });

  describe("shipping a release with a destructive migration", () => {
    const SQL = "DROP TABLE old_logs;\n";
    let gh: string[][] = [];
    let content = SQL;
    beforeEach(() => {
      gh = [];
      releaseGh.run = async (args) => {
        gh.push(args);
        if (args[0] === "api") return { ok: true, stdout: JSON.stringify({ content: Buffer.from(content).toString("base64") }), stderr: "" };
        if (args[1] === "list") return { ok: true, stdout: "[]", stderr: "" };
        if (args[1] === "create") return { ok: true, stdout: `https://github.com/${REPO}/pull/40\n`, stderr: "" };
        if (args[1] === "view") return { ok: true, stdout: JSON.stringify({ mergeCommit: { oid: "f".repeat(40) }, url: `https://github.com/${REPO}/pull/40`, statusCheckRollup: [] }), stderr: "" };
        return { ok: true, stdout: "", stderr: "" };
      };
    });
    before(async () => {
      const p = await findProject(db, "zigzag");
      await testStore.fix(async (uow) => {
        for (const [name, headSha] of [["sandbox", "d".repeat(40)], ["main", "e".repeat(40)]] as const) {
          if (await uow.get("branches", { projectId: p.id, name })) await uow.update("branches", { projectId: p.id, name }, { headSha });
          else await uow.insert("branches", { projectId: p.id, name, headSha });
        }
        const cursor = { release: { key: `${"d".repeat(40)}...${"e".repeat(40)}`, from_head: "d".repeat(40), into_head: "e".repeat(40), ahead: 2, contains: false, commits: [], migration_files: ["drizzle/0009_cleanup.sql"] } };
        if (await uow.get("pollState", { projectId: p.id, source: "github" })) await uow.update("pollState", { projectId: p.id, source: "github" }, { cursor });
        else await uow.insert("pollState", { projectId: p.id, source: "github", cursor });
      });
      const t = (await createTask(db, { project: "zigzag", title: "Limpieza", scope: "s", checks: ["c"], status: "Ready" } as never, ctx as never)) as { key: string };
      await testStore.fix(async (uow) => {
        const [merged] = await uow.update("tasks", { key: t.key }, { status: "Merged" });
        await uow.update("checks", { taskId: merged!.id }, { done: true });
        await uow.insert("pullRequests", { projectId: p.id, repo: REPO, number: 39, url: "u", title: "t", taskId: merged!.id, state: "merged", baseBranch: "sandbox", mergedAt: uow.now });
      });
    });

    test("squawk's errors stop it", async () => {
      shipDeps.sqlReview = async () => ({ available: true, issues: [{ rule: "ban-drop-table", level: "Error", message: "Dropping a table is not allowed" }] });
      await assert.rejects(shipRelease(db, "zigzag", human), (e: any) => e.code === "CAMINO_SQL_REVIEW" && e.detail.files[0].path === "drizzle/0009_cleanup.sql");
      assert.ok(!gh.some((a) => a[1] === "merge"));
      shipDeps.sqlReview = async () => ({ available: true, issues: [] });
    });

    test("a destructive file waits for the owner's approval of that exact file; a changed file asks again", async () => {
      let err: any;
      await shipRelease(db, "zigzag", human).catch((e) => (err = e));
      assert.equal(err?.code, "CAMINO_NEEDS_APPROVAL");
      assert.deepEqual(err.detail.files[0], { path: "drizzle/0009_cleanup.sql", sha256: sha256(SQL), statements: ["DROP TABLE old_logs"] });
      assert.ok(!gh.some((a) => a[1] === "merge"));
      const res = await post("/projects/zigzag/camino/approve", { path: "drizzle/0009_cleanup.sql", sha256: sha256(SQL) });
      assert.equal(res.status, 200);
      const out = await shipRelease(db, "zigzag", human);
      assert.equal(out.merge_sha, "f".repeat(40));
      assert.equal(newestFirst(await testStore.find("caminoHistory")).slice(0, 2).some((r) => /Aprobaste drizzle\/0009_cleanup\.sql/.test(r.label)), true);
      content = "DROP TABLE old_logs;\nDROP TABLE more;\n";
      await testStore.fix((uow) => uow.delete("events", { type: "release.merged" }));
      await assert.rejects(shipRelease(db, "zigzag", human), (e: any) => e.code === "CAMINO_NEEDS_APPROVAL");
      content = SQL;
    });

    test("the freeze window holds the release", async () => {
      const p = await findProject(db, "zigzag");
      const cfg = (await testStore.get("camino", { projectId: p.id }))!.config as Json;
      cfg.envs[0].freeze = true;
      await testStore.fix((uow) => uow.update("camino", { projectId: p.id }, { config: cfg }));
      const RealDate = Date;
      const fixed = new RealDate(2026, 10, 20, 19, 0).getTime();
      (globalThis as any).Date = class extends RealDate {
        constructor(...a: any[]) {
          super(...((a.length ? a : [fixed]) as []));
        }
        static now() {
          return fixed;
        }
      };
      try {
        assert.equal((await releasePlan(db, await findProject(db, "zigzag")))!.ship.reason, "freeze");
      } finally {
        (globalThis as any).Date = RealDate;
      }
    });
  });

  test("squawk reviews SQL when it is installed", { skip: !squawkAvailable && "squawk is not installed here" }, async () => {
    const out = await runSquawk("drizzle/0009.sql", "ALTER TABLE users ADD COLUMN age int NOT NULL;");
    assert.ok(out.available);
    assert.ok(out.issues.some((i) => i.rule === "adding-required-field"));
  });
});
