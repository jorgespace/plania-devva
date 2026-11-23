// PLA-I2-9: Plania working on Plania. Recognising Plania itself by its repo, a test copy's own store and env
// file, the deny rules and check for a run of Plania, the restart that falls back to the last good commit, and the
// list of migrations agents wrote. The spawn sites are tested where they live: i46-prueba.test.ts (the test copy)
// and runner.test.ts (a run of Plania itself).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { copyStorePrefix, isSelfProject, liveDatabaseName, liveStorePrefix, rewriteEnvText, sameDatabase, selfCopyEnv, selfRunProblem } from "../src/self/plania-self.js";
import { defaultSelfDbBuild, selfCopyDatabase, selfCopyEnvFile } from "../src/self/self-copy.js";
import { readLastGood, recordsGoodStart, restartWithFallback, writeLastGood, type GoodStart, type RestartDeps } from "../src/ops/last-good.js";
import { DENY_RULES, deniedBy, selfRules } from "../src/runner/deny.js";

const TMP = mkdtempSync(path.join(tmpdir(), "plania-i2-9-"));
// A project's own Postgres address (the Máquina pages read one with sameDatabase and liveDatabaseName).
const LIVE = "postgres://owner@localhost:5432/plania";
// The live server's environment: its store is the default prefix, plania, on the devva engine.
const LIVE_ENV: NodeJS.ProcessEnv = {};

// ---- one function says "this project is Plania itself"

test("isSelfProject compares repos on disk, not slugs: same folder, a worktree of it, and nothing else", () => {
  const root = path.join(TMP, "live");
  mkdirSync(path.join(root, ".git", "worktrees", "wt1"), { recursive: true });
  writeFileSync(path.join(root, ".git", "worktrees", "wt1", "commondir"), "../..\n");
  const wt = path.join(TMP, "wt1");
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(root, ".git", "worktrees", "wt1")}\n`);
  const other = path.join(TMP, "other");
  mkdirSync(path.join(other, ".git"), { recursive: true });

  assert.equal(isSelfProject(root, root), true);
  assert.equal(isSelfProject(root + path.sep, root), true);
  assert.equal(isSelfProject(wt, root), true, "a linked worktree of the live repo");
  assert.equal(isSelfProject(other, root), false);
  assert.equal(isSelfProject(path.join(TMP, "missing"), root), false);
  assert.equal(isSelfProject(null, root), false);
  // Case only matters on Linux. The upper-case spelling exists as a path only where the file system folds case, so
  // the check runs there (macOS, Windows); on Linux the folder would not be found at all.
  if (process.platform !== "linux") assert.equal(isSelfProject(root.toUpperCase(), root, "darwin"), true);
});

// ---- a project's Postgres database

test("sameDatabase: same server and name, whatever the spelling of localhost", () => {
  assert.equal(sameDatabase("postgres://a@127.0.0.1/plania", LIVE), true);
  assert.equal(sameDatabase("postgresql://localhost:5432/plania?sslmode=disable", LIVE), true);
  assert.equal(sameDatabase("postgres://localhost/plania_prueba", LIVE), false);
  assert.equal(sameDatabase("postgres://localhost:5433/plania", LIVE), false);
  assert.equal(sameDatabase("postgres://db.example.com/plania", LIVE), false);
  assert.equal(sameDatabase("not a url", LIVE), false);
  assert.equal(liveDatabaseName(LIVE), "plania");
});

// ---- check 4: a test copy of Plania has its own database, no jobs

test("check 4: a copy's store is <live>_prueba or <live>_entrega, never the live one", () => {
  assert.equal(liveStorePrefix(LIVE_ENV), "plania");
  assert.equal(liveStorePrefix({ PLANIA_DEVVA_PREFIX: " mine " }), "mine");
  assert.deepEqual(copyStorePrefix("plania", "_prueba"), { name: "plania_prueba" });
  assert.equal(copyStorePrefix("plania", "_entrega")!.name, "plania_entrega");
  assert.equal(copyStorePrefix(undefined, "_prueba"), null);
  assert.equal(copyStorePrefix("Not A Prefix", "_prueba"), null);
  // The same engine as the live server, never its token.
  const env = selfCopyEnv("plania_prueba", 3101, { DEVVA_PORT: "2600", DEVVA_TOKEN_FILE: "/k/t", DEVVA_TOKEN: "the-token" });
  assert.equal(Object.keys(env)[0], "PLANIA_DEVVA_PREFIX");
  assert.deepEqual([env.PLANIA_DEVVA_PREFIX, env.DEVVA_PORT, env.DEVVA_TOKEN_FILE, env.DEVVA_TOKEN], ["plania_prueba", "2600", "/k/t", undefined]);
  assert.deepEqual([env.PLANIA_JOBS, env.PLANIA_EVENT_WAKES, env.PLANIA_RUNNER_TOKEN, env.PLANIA_PORT], ["0", "0", "", "3101"]);
});

test("check 4: the copied env file is rewritten (every line that sets a value) and the rest kept", () => {
  const text = "# mine\nPLANIA_DEVVA_PREFIX=plania\nSESSION_SECRET=s\nexport PLANIA_JOBS=1\nPLANIA_DEVVA_PREFIX=plania\n";
  const out = rewriteEnvText(text, { PLANIA_DEVVA_PREFIX: "plania_prueba", PLANIA_JOBS: "0", PLANIA_PORT: "3101" });
  assert.equal(/^PLANIA_DEVVA_PREFIX=plania$/m.test(out), false);
  assert.equal((out.match(/PLANIA_DEVVA_PREFIX=plania_prueba/g) ?? []).length, 2);
  assert.match(out, /^PLANIA_JOBS=0$/m);
  assert.match(out, /^SESSION_SECRET=s$/m);
  assert.match(out, /^# mine$/m);
  assert.match(out, /^PLANIA_PORT=3101$/m);
});

test("check 4: selfCopyEnvFile writes the copy's file and refuses the live store or the live port", () => {
  const wt = path.join(TMP, "copy");
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(wt, ".env"), "PLANIA_DEVVA_PREFIX=plania\nPLANIA_JOBS=1\nSESSION_SECRET=keep\n");
  const live = LIVE_ENV;
  const copy = selfCopyEnv("plania_prueba", 0);
  const ok = selfCopyEnvFile(wt, ".env", copy, 3101, live);
  assert.equal(ok.ok, true);
  const text = readFileSync(path.join(wt, ".env"), "utf8");
  assert.match(text, /^PLANIA_DEVVA_PREFIX=plania_prueba$/m);
  assert.match(text, /^PLANIA_JOBS=0$/m);
  assert.match(text, /^SESSION_SECRET=keep$/m);
  assert.equal(ok.ok && ok.env.PLANIA_PORT, "3101");
  // The live port, or a copy env that still names the live store: refused.
  const port = selfCopyEnvFile(wt, ".env", copy, 3737, live);
  assert.equal(port.ok, false);
  assert.match(!port.ok ? port.error : "", /puerto/);
  const bad = selfCopyEnvFile(wt, ".env", { ...copy, PLANIA_DEVVA_PREFIX: "plania" }, 3101, live);
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.error : "", /datos del Plania que estás usando/);
  // No env file in the copy: one is written with the copy's values only.
  const bare = path.join(TMP, "bare");
  mkdirSync(bare, { recursive: true });
  assert.equal(selfCopyEnvFile(bare, null, copy, 3102, live).ok, true);
  assert.match(readFileSync(path.join(bare, ".env"), "utf8"), /^PLANIA_JOBS=0$/m);
});

test("check 4: selfCopyDatabase gives the copy a new store of its own on the live server's engine", async () => {
  const calls: string[] = [];
  const out = await selfCopyDatabase({ DEVVA_PORT: "2600" }, "_entrega", "/wt", async (prefix) => (calls.push(prefix), { ok: true }));
  assert.equal(out.ok, true);
  assert.deepEqual(calls, ["plania_entrega"]);
  assert.deepEqual(out.ok && [out.name, out.env.PLANIA_DEVVA_PREFIX, out.env.DEVVA_PORT], ["plania_entrega", "plania_entrega", "2600"]);
  // A live store whose name is not a prefix: nothing is built.
  assert.equal((await selfCopyDatabase({ PLANIA_DEVVA_PREFIX: "Not A Prefix" }, "_prueba", "/wt", async () => ({ ok: true }))).ok, false);
  const failed = await selfCopyDatabase(LIVE_ENV, "_prueba", "/wt", async () => ({ ok: false, error: "boom" }));
  assert.match(!failed.ok ? failed.error : "", /plania_prueba.*boom/);
});

test("check 4: the default build empties the copy's store on the engine and leaves the live one alone", async () => {
  // A throwaway prefix of this test file stands in for the live store (never plania); the copy is <it>_prueba.
  const { DevvaStore } = await import("../src/store/devva.js");
  const liveEnv = { PLANIA_DEVVA_PREFIX: "t_i29_self" } as NodeJS.ProcessEnv;
  const target = copyStorePrefix(liveStorePrefix(liveEnv), "_prueba")!;
  assert.equal(target.name, "t_i29_self_prueba");
  const one = (prefix: string) => async (s: Awaited<ReturnType<typeof DevvaStore.open>>) => s.write("", {}, (uow) => uow.insert("machineState", { key: `i29.${prefix}`, value: {} }));
  const live = await DevvaStore.open({ prefix: "t_i29_self" });
  const copy = await DevvaStore.open({ prefix: target.name });
  try {
    // An earlier copy left rows behind; the live store holds its own.
    await one("live")(live);
    await one("copy")(copy);
    copy.close();
    const built = await defaultSelfDbBuild(target.name);
    assert.deepEqual(built, { ok: true });
    const reopened = await DevvaStore.open({ prefix: target.name });
    assert.equal(reopened.commits, 0, "the copy starts on an empty store");
    reopened.close();
    const again = await DevvaStore.open({ prefix: "t_i29_self" });
    assert.equal(again.commits, live.commits, "the live store is untouched");
    again.close();
  } finally {
    await live.purge();
    live.close();
    const left = await DevvaStore.open({ prefix: target.name });
    await left.purge();
    left.close();
  }
});

// ---- check 3: a run of Plania never reaches the live store

test("check 3: the deny rules refuse the live store and database, migrations and a restart; ordinary work passes", () => {
  const rules = [...DENY_RULES, ...selfRules("plania")];
  for (const cmd of [
    "psql plania",
    "psql -h localhost -d plania -c 'select 1'",
    "psql postgres://localhost:5432/plania",
    "cd /x && psql postgres://localhost/plania?sslmode=disable",
    "pg_dump plania > /tmp/x.sql",
    "DATABASE_URL=postgres://localhost/plania pnpm dev",
    "pnpm db:migrate",
    "pnpm db:migrate --database plania_prueba",
    "pnpm exec tsx src/db/migrate.ts",
    "pnpm server:restart --force",
    "launchctl kickstart -k gui/501/com.plania.server",
    "systemctl --user restart plania.service",
    // The devva engine's token and the live store.
    "cat ~/.config/plania/devva-token",
    "DEVVA_TOKEN_FILE=/tmp/t pnpm start",
    "PLANIA_DEVVA_PREFIX=plania pnpm dev",
    "pnpm restore:plania x.devva.jsonl.gz --overwrite --confirm plania",
    "pnpm update:plania plania-0.2.0.tar.gz",
    "pnpm uninstall:plania --delete-data",
  ]) assert.notEqual(deniedBy("Bash", cmd, rules), null, cmd);
  for (const ok of ["pnpm test", "pnpm exec tsc --noEmit", "node --import tsx --test test/x.test.ts", "git push -u origin jl/pla-i2-9", "psql plania_test_abc123 -c 'select 1'", "PLANIA_DEVVA_PREFIX=plania_prueba pnpm dev", "grep -rn devva-token src/"]) {
    assert.equal(deniedBy("Bash", ok, rules), null, ok);
  }
  // A live database with another name gets rules for that name.
  assert.notEqual(deniedBy("Bash", "psql mi_plania", selfRules("mi_plania")), null);
  assert.deepEqual(selfRules(null), selfRules("plania"));
  // A token file of its own is named too.
  assert.notEqual(deniedBy("Bash", "cat /keys/engine.token", selfRules("plania", "/keys/engine.token")), null);
});

test("check 3: the check refuses a run whose variables or folder point at the live store", () => {
  assert.equal(selfRunProblem({ PATH: "/bin", PLANIA_RUNNER_TOKEN: "t" }, null, LIVE_ENV), null);
  assert.match(selfRunProblem({ PLANIA_DEVVA_PREFIX: "plania" }, null, LIVE_ENV)!, /PLANIA_DEVVA_PREFIX points at the live store/);
  assert.match(selfRunProblem({ DEVVA_TOKEN: "x" }, null, LIVE_ENV)!, /DEVVA_TOKEN carries the devva engine's token/);
  const cwd = path.join(TMP, "run");
  mkdirSync(cwd, { recursive: true });
  assert.equal(selfRunProblem({}, cwd, LIVE_ENV), null);
  writeFileSync(path.join(cwd, ".env.local"), "PLANIA_DEVVA_PREFIX='plania'\n");
  assert.match(selfRunProblem({}, cwd, LIVE_ENV)!, /\.env\.local/);
  writeFileSync(path.join(cwd, ".env.local"), "PLANIA_DEVVA_PREFIX=t_plania_abc\n");
  assert.equal(selfRunProblem({}, cwd, LIVE_ENV), null);
  // A .env that names no store leaves a server started there on the default one: the live store, when it is plania.
  writeFileSync(path.join(cwd, ".env"), "SESSION_SECRET=s\n");
  assert.match(selfRunProblem({}, cwd, LIVE_ENV)!, /^\.env in the run's folder/);
  assert.equal(selfRunProblem({}, cwd, { PLANIA_DEVVA_PREFIX: "mine" }), null);
});

// ---- check 2: a broken commit does not leave the live server down

type World = { head: string; running: string | null; broken: Set<string>; restarts: number; checkouts: string[] };
function world(over: Partial<World> = {}, lastGood: GoodStart | null = { commit: "good111", version: "0.9.0", packaged: false, root: "/srv/plania", at: "t" }, packaged = false) {
  const w: World = { head: "bad2222", running: "good111", broken: new Set(["bad2222"]), restarts: 0, checkouts: [], ...over };
  const deps: RestartDeps = {
    restart: () => {
      w.restarts += 1;
      // The service manager starts what the folder holds; a broken commit never answers.
      w.running = w.broken.has(w.head) ? null : w.head;
    },
    health: async () => (w.running ? { commit: w.running, version: packaged ? w.running : "0.9.0" } : null),
    head: () => w.head,
    version: () => (packaged ? w.head : "0.9.0"),
    packaged,
    lastGood: () => lastGood,
    checkout: (commit) => {
      w.checkouts.push(commit);
      w.head = commit;
      return { ok: true };
    },
    sleep: async () => undefined,
    timeoutMs: 30,
    pollMs: 10,
  };
  return { w, deps };
}

test("check 2: a deliberately broken commit is not left down: back to the last good commit, and it says so", async () => {
  const { w, deps } = world();
  const out = await restartWithFallback(deps);
  assert.equal(out.status, "fell_back");
  assert.deepEqual(w.checkouts, ["good111"]);
  assert.equal(w.restarts, 2);
  assert.equal(w.running, "good111", "the live server is up again");
  assert.match(out.lines.join(" "), /no arrancó en el commit bad2222.*Volví al commit good111/);
});

test("check 2: a good commit just restarts; without a record, or on a package, it says what to do", async () => {
  const ok = world({ head: "new3333", broken: new Set() });
  const up = await restartWithFallback(ok.deps);
  assert.deepEqual([up.status, ok.w.restarts, ok.w.checkouts.length], ["up", 1, 0]);
  assert.match(up.lines[0]!, /reiniciado en el commit new3333/);

  const none = world({}, null);
  const down = await restartWithFallback(none.deps);
  assert.equal(down.status, "down");
  assert.equal(none.w.checkouts.length, 0);
  assert.match(down.lines.join(" "), /no puedo volver atrás solo/);

  const same = world({ head: "good111", broken: new Set(["good111"]) });
  assert.match((await restartWithFallback(same.deps)).lines.join(" "), /mismo commit/);

  const pkg = world({ head: "1.1.0", broken: new Set(["1.1.0"]) }, { commit: null, version: "1.0.0", packaged: true, root: "/opt/plania", at: "t" }, true);
  const p = await restartWithFallback(pkg.deps);
  assert.equal(p.status, "down");
  assert.match(p.lines.join(" "), /la versión 1\.1\.0.*la 1\.0\.0/);
});

test("check 2: the good start is recorded by the live service only, and read back", () => {
  assert.equal(recordsGoodStart(3737, {}), true);
  assert.equal(recordsGoodStart(3738, {}), false, "the dev API");
  assert.equal(recordsGoodStart(3101, { PLANIA_PORT: "3101", PLANIA_JOBS: "0" }), false, "a test copy of Plania");
  assert.equal(recordsGoodStart(3737, { PLANIA_JOBS: "0" }), false);
  const file = path.join(TMP, "state", "last-good.json");
  const rec: GoodStart = { commit: "abc", version: "1.0.0", packaged: false, root: "/r", at: "2026-11-19T00:00:00Z" };
  writeLastGood(file, rec);
  assert.deepEqual(readLastGood(file), rec);
  assert.equal(readLastGood(path.join(TMP, "nope.json")), null);
});

// ---- migrations written by agents, for the owner

test("the screen lists agents' migrations per delivery, and nothing for any other project", async () => {
  (globalThis as { React?: unknown }).React = React;
  const lib = (await import(new URL("../ui/src/lib/migraciones-propias.ts", import.meta.url).href)) as typeof import("../ui/src/lib/migraciones-propias.js");
  assert.equal(lib.migracionesView({ self: false, deliveries: [] }), null);
  assert.equal(lib.migracionesView({ self: true, deliveries: [] }), null);
  const data = { self: true, deliveries: [{ key: "PLA-200", title: "Guardar el idioma", branch: "jl/x", files: ["0070_idioma.sql"] }, { key: "PLA-201", title: "Dos tablas", branch: "jl/y", files: ["0071_a.sql", "0072_b.sql"] }] };
  const v = lib.migracionesView(data)!;
  assert.deepEqual(v.lines.map((l) => l.text), ["Guardar el idioma: 1 migración (0070_idioma.sql)", "Dos tablas: 2 migraciones (0071_a.sql, 0072_b.sql)"]);
  assert.match(v.lead, /Ningún agente las aplica/);
  for (const t of [v.title, v.lead, ...v.lines.map((l) => l.text)]) assert.equal(/PLA-|jl\/|sandbox/.test(t), false, t);
  const comp = (await import(new URL("../ui/src/components/corriente/migraciones-propias.tsx", import.meta.url).href)) as Record<string, any>;
  const html = renderToStaticMarkup(React.createElement(comp.MigracionesPropiasView, { data }));
  assert.match(html, /data-migraciones-propias/);
  assert.match(html, /Migraciones que escribió el equipo/);
  assert.equal(renderToStaticMarkup(React.createElement(comp.MigracionesPropiasView, { data: { self: false, deliveries: [] } })), "");
});

test.after?.(() => rmSync(TMP, { recursive: true, force: true }));

// The devva store has no migrations and no record of any: nothing applies a migration file, so every one a delivery of
// Plania itself carries is listed (on Postgres, only the ones the record lacked).
test("the server lists, for Plania itself only, migration files in a delivery", async () => {
  const { useTestEnv, resetTestStore } = await import("./helpers.js");
  useTestEnv();
  const store = await resetTestStore();
  const { makeDb } = await import("../src/db/client.js");
  const { agentMigrations } = await import("../src/self/agent-migrations.js");
  const { db } = makeDb();
  try {
    const root = path.join(TMP, "self-root");
    mkdirSync(path.join(root, ".git"), { recursive: true });
    const pid = await store.projectId("zigzag");
    await store.fix(async (uow) => {
      const z = (await uow.get("projects", { id: pid }))!;
      await uow.update("projects", { id: pid }, { settings: { ...(z.settings ?? {}), local: { repo_path: root } } as typeof z.settings });
      await uow.insert("tasks", { projectId: pid, kind: "ticket", key: "ZIG-90", title: "Guardar el idioma", status: "In review", scope: "s", workType: "code", branch: "jl/mig" });
      await uow.insert("tasks", { projectId: pid, kind: "ticket", key: "ZIG-91", title: "Ya hecho", status: "Done", scope: "s", workType: "code", branch: "jl/old" });
    });
    const t = { key: "ZIG-90" };
    const known = "0000_curvy_wolfpack.sql";
    const asked: string[][] = [];
    const git = async (args: string[], cwd: string) => {
      asked.push([...args, cwd]);
      return { code: 0, stdout: `${known}\n0999_agent_wrote_this.sql\nREADME.md\n`, stderr: "" };
    };
    const out = await agentMigrations(db, "zigzag", { git, serverRoot: root });
    assert.deepEqual(out, { self: true, deliveries: [{ key: t.key, title: "Guardar el idioma", branch: "jl/mig", files: [known, "0999_agent_wrote_this.sql"] }] });
    assert.equal(asked.length, 1, "a Done ticket is not a delivery");
    assert.deepEqual(asked[0]!.slice(0, 3), ["ls-tree", "--name-only", "origin/jl/mig:drizzle/migrations"]);
    // Not Plania itself: nothing, and git is not asked.
    asked.length = 0;
    assert.deepEqual(await agentMigrations(db, "zigzag", { git, serverRoot: path.join(TMP, "elsewhere") }), { self: false, deliveries: [] });
    assert.equal(asked.length, 0);
    assert.equal(await agentMigrations(db, "nope", { git, serverRoot: root }), null);
  } finally {
    await store.end();
  }
});
