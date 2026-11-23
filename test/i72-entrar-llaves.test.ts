// PLA-I72-4: Entrar y llaves. The test user's password is kept only for a test user, in a mode-600 file outside the
// repo, never in the database or a log; reading it twice gives the same value; Cambiarla sets a new one in the app
// and in every running copy (each with its own base) and keeps it. A key only an initiative branch's env example asks
// for is marked with that initiative; saving a key returns the running copies to restart. Fake exec; a throwaway store.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { resetTestStore, useTestEnv, type TestStore } from "./helpers.js";
import { APP_URL, CAPTURE, fakeMachine, repoOf } from "./i72-fixtures.js";

const TMP = mkdtempSync(path.join(tmpdir(), "plania-i72-entrar-"));
process.env.PLANIA_TEST_PASSWORDS_FILE = path.join(TMP, "config", "plania", "test-passwords.json");
useTestEnv();
process.env.PLANIA_CAPTURES_DIR = path.join(TMP, "captures");
const WT_ROOT = path.join(TMP, "worktrees");
const { app } = await import("../src/app.js");
const { createSession, SESSION_COOKIE } = await import("../src/auth/session.js");
const prueba = await import("../src/captures/prueba.js");
const maquinas = await import("../src/maquinas/machines.js");
type Json = Record<string, any>;

const jorge = () => ({ Cookie: `${SESSION_COOKIE}=${createSession()}`, "content-type": "application/json" });
const call = async (method: string, url: string, body?: Json): Promise<{ status: number; body: Json }> => {
  const r = await app.request(url, { method, headers: jorge(), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json()) as Json };
};
const act = (id: string, action: string) => call("POST", `/api/projects/zigzag/maquinas/copias/${id}/${action}`);
const until = async (f: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const live = async (id: string) => until(async () => (await call("GET", "/api/projects/zigzag/maquinas/copias")).body.copias.find((c: Json) => c.id === id)?.phase === "live");

let store: TestStore;
const fm = fakeMachine(WT_ROOT);
const REPO = repoOf(TMP);
const FILE = process.env.PLANIA_TEST_PASSWORDS_FILE!;
let pwRuns: { cwd: string; db: string; stdin: string }[] = [];
// settings.capture.session.user, set around the schema (as jsonb_set did).
const setUser = (user: string) =>
  store.fix(async (uow) => {
    const p = (await uow.get("projects", { slug: "zigzag" }))!;
    const capture = p.settings.capture as Json;
    await uow.update("projects", { id: p.id }, { settings: { ...p.settings, capture: { ...capture, session: { ...capture.session, user } } } as never });
  });
const SESSION = { login_path: "/entrar", user: "prueba@example.com", user_field: "email", password_field: "password", password_command: "npm run panel:usuario -- {user}" };

before(async () => {
  store = await resetTestStore();
  mkdirSync(REPO, { recursive: true });
  writeFileSync(path.join(REPO, ".env.local"), `DATABASE_URL=${APP_URL}\nSTRIPE_KEY=sk_test_x\n`);
  writeFileSync(path.join(REPO, ".env.example"), `DATABASE_URL=\nSTRIPE_KEY=\n`);
  const pid = await store.projectId("zigzag");
  await store.fix(async (uow) => {
    const p = (await uow.get("projects", { id: pid }))!;
    await uow.update("projects", { id: pid }, { settings: { ...p.settings, ...CAPTURE(REPO, { session: SESSION }) } as never });
    await uow.insert("tasks", { projectId: pid, key: "ZZ-I1", title: "Carrito", kind: "initiative", status: "Active", scope: "s", branch: "jl/zz-carrito" });
    await uow.insert("tasks", { projectId: pid, key: "ZZ-I2", title: "Pagos", kind: "initiative", status: "Active", scope: "s", branch: "jl/zz-pagos" });
  });
});
after(async () => {
  prueba.stopAll();
  await store.end();
  rmSync(TMP, { recursive: true, force: true });
});
beforeEach(async () => {
  prueba.resetPrueba();
  fm.reset();
  pwRuns = [];
  const exec: typeof fm.exec = async (command, opts) => {
    if (command.startsWith("npm run panel:usuario")) {
      pwRuns.push({ cwd: opts!.cwd, db: String((opts!.env as Json)?.DATABASE_URL ?? "(env file)"), stdin: String(opts!.stdin) });
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command.startsWith("git ls-files")) return { code: 0, stdout: "", stderr: "" };
    return fm.exec!(command, opts);
  };
  prueba.setPruebaDeps(fm.deps({ exec }));
  maquinas.setMaquinasDeps({ env: { ...process.env, PLANIA_WORKTREES_ROOT: WT_ROOT }, portBusy: async () => false, exec });
  await store.fix((uow) => uow.update("maquinaCopias", { deletedAt: null }, { deletedAt: uow.now }));
  rmSync(WT_ROOT, { recursive: true, force: true });
});

test("I72-4 #1 #2: the password is kept in a mode-600 file outside the repo, the same on every read, never in the database or a log", async () => {
  rmSync(FILE, { force: true });
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    const empty = await call("GET", "/api/projects/zigzag/maquinas/entrar");
    assert.equal(empty.body.user, "prueba@example.com");
    assert.equal(empty.body.password, null);
    assert.equal(empty.body.can_password, true);
    const c = await call("POST", "/api/projects/zigzag/maquinas/entrar/cambiar");
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const pw = c.body.password as string;
    assert.match(pw, /^[A-Za-z0-9_-]{16}$/);
    const a = await call("GET", "/api/projects/zigzag/maquinas/entrar");
    const b = await call("GET", "/api/projects/zigzag/maquinas/entrar");
    assert.equal(a.body.password, pw);
    assert.equal(b.body.password, pw, "showing it twice gives the same value");
    assert.equal(pwRuns.length, 1, "reading never sets one");
    assert.ok(existsSync(FILE));
    assert.equal(statSync(FILE).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(FILE)).mode & 0o077, 0);
    assert.ok(!path.resolve(FILE).startsWith(path.resolve(REPO) + path.sep));
    assert.ok(readFileSync(FILE, "utf8").includes(pw));
    const dump = [
      ...(await store.find("events")).map((e) => JSON.stringify(e.payload)),
      ...(await store.find("projects")).map((p) => JSON.stringify(p.settings)),
      ...(await store.find("machineState")).map((m) => JSON.stringify(m.value)),
      ...(await store.find("footprints")).map((f) => JSON.stringify(f.details) + f.purpose),
    ].join("");
    assert.ok(!dump.includes(pw), "not in the database");
    assert.ok(!lines.some((l) => l.includes(pw)), "not in a log line");
    // A file others can read is not trusted.
    const { chmodSync } = await import("node:fs");
    chmodSync(FILE, 0o644);
    assert.equal((await call("GET", "/api/projects/zigzag/maquinas/entrar")).body.password, null);
    chmodSync(FILE, 0o600);
  } finally {
    console.log = log;
  }
});

test("I72-4 #1: a user outside the test domains is never kept nor changed", async () => {
  rmSync(FILE, { force: true });
  await setUser("ana@gmail.com");
  try {
    const r = await call("POST", "/api/projects/zigzag/maquinas/entrar/cambiar");
    assert.equal(r.body.error, "NOT_A_TEST_USER");
    assert.equal(pwRuns.length, 0);
    assert.ok(!existsSync(FILE));
    const e = await call("GET", "/api/projects/zigzag/maquinas/entrar");
    assert.equal(e.body.can_password, false);
    assert.equal(e.body.password, null);
  } finally {
    await setUser("prueba@example.com");
  }
});

test("I72-4 #2: Cambiarla sets the new one in the app and in every running copy's own base, and lists the copies that were off", async () => {
  await act("inicio", "encender");
  await act("ZZ-I1", "encender");
  await live("inicio");
  await live("ZZ-I1");
  // ZZ-I2 was made, then turned off: its base keeps the old sign-in.
  await act("ZZ-I2", "encender");
  await live("ZZ-I2");
  await act("ZZ-I2", "apagar");
  const r = await call("POST", "/api/projects/zigzag/maquinas/entrar/cambiar");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const pw = r.body.password;
  assert.deepEqual(r.body.set_in.sort(), ["ZZ-I1", "inicio"]);
  assert.deepEqual(r.body.stale, ["ZZ-I2"]);
  const dbs = pwRuns.map((x) => (x.db === "(env file)" ? x.db : fm.nameOf(x.db))).sort();
  assert.deepEqual(dbs, ["(env file)", "zz_dev_ini_zz_i1", "zz_dev_prueba"]);
  assert.ok(pwRuns.every((x) => x.stdin === `${pw}\n${pw}\n`));
  const e = await call("GET", "/api/projects/zigzag/maquinas/entrar");
  assert.equal(e.body.password, pw);
  assert.deepEqual(e.body.stale, ["ZZ-I2"]);
});

test("I72-4 #3 #4: a key only an initiative branch asks for carries it; saving a key returns the running copies to restart", async () => {
  await act("ZZ-I1", "encender");
  await live("ZZ-I1");
  writeFileSync(path.join(prueba.iniWorktree("zigzag", "ZZ-I1"), ".env.example"), `DATABASE_URL=\nSTRIPE_KEY=\nCUPONES_API_KEY=\n`);
  const l = await call("GET", "/api/projects/zigzag/maquinas/llaves");
  const cup = l.body.llaves.find((x: Json) => x.name === "CUPONES_API_KEY");
  assert.deepEqual(cup.iniciativas, ["ZZ-I1"]);
  assert.equal(cup.set, false);
  assert.equal(l.body.llaves.find((x: Json) => x.name === "STRIPE_KEY").iniciativas, undefined);
  const saved = await call("POST", "/api/projects/zigzag/maquinas/llaves", { name: "CUPONES_API_KEY", value: "cup_test_123" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.reiniciar, [{ id: "ZZ-I1", title: "Carrito" }]);
  assert.ok(!JSON.stringify(saved.body).includes("cup_test_123"));
  // Reiniciar las copias encendidas: ZZ-I1 starts again (and reads the new file); nothing else starts.
  const before = fm.m.children.length;
  const rr = await call("POST", "/api/projects/zigzag/maquinas/copias/reiniciar-encendidas");
  assert.deepEqual(rr.body.reiniciadas, ["ZZ-I1"]);
  await until(() => fm.m.children.length === before + 1);
  await live("ZZ-I1");
  assert.ok(readFileSync(path.join(prueba.iniWorktree("zigzag", "ZZ-I1"), ".env.local"), "utf8").includes("CUPONES_API_KEY=cup_test_123"), "the restarted copy has the new key");
});
