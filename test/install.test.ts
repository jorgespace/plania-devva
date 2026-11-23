// PLA-I2-1: one-command install and the start-up check, on the devva store. Every store here is a throwaway prefix of
// this checkout on the test engine (DEVVA_HOST, DEVVA_PORT, DEVVA_TOKEN_FILE), emptied when the file ends; nothing
// touches the live plania lobes. No network: the server that "answers" is served on 127.0.0.1 inside this process.
// (Main's cases for the migration record, baseline and migrate were Postgres's: the store has no migrations.)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { parseEnv } from "node:util";
import { useTestEnv } from "./helpers.js";

useTestEnv();
const { install, InstallError, isStorePrefix } = await import("../src/db/install.js");
const { devvaAddress, readDevva, startupProblem } = await import("../src/install/connect.js");
const { DevvaStore, loadClient } = await import("../src/store/devva.js");

const REPO = path.resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(path.join(tmpdir(), "plania-install-"));
// Prefixes of this checkout and file, never plania.
const tag = createHash("sha1").update(`${import.meta.dirname}|install`).digest("hex").slice(0, 8);
const P = { fresh: `t_inst_${tag}_a`, check: `t_inst_${tag}_b`, held: `t_inst_${tag}_c` };
assert.ok(Object.values(P).every((p) => isStorePrefix(p) && !p.startsWith("plania")));

async function purge(prefix: string): Promise<void> {
  const s = await DevvaStore.open({ prefix });
  await s.purge();
  s.close();
}
async function lobes(): Promise<string[]> {
  const db = await (await loadClient({ prefix: "" }))();
  try {
    return (await db.listLobes()).map((l) => l.name);
  } finally {
    db.close();
  }
}
after(async () => {
  for (const p of Object.values(P)) if ((await lobes()).includes(`${p}_log`)) await purge(p);
  rmSync(scratch, { recursive: true, force: true });
});

test("check 1: on an engine that answers, install makes a new store, writes .env, and the server answers", async () => {
  await purge(P.fresh);
  const envPath = path.join(scratch, "one.env");
  const calls: string[] = [];
  const r = await install({
    prefix: P.fresh,
    named: false,
    envPath,
    examplePath: path.join(REPO, ".env.example"),
    machineCheck: async () => {
      calls.push("check");
      return { ok: true, lines: ["máquina bien"] };
    },
    buildScreen: async () => {
      calls.push("screen");
    },
    setupCode: () => "PRUE-BAPR-UEBA",
  });
  assert.equal(r.created, true);
  assert.equal(r.store, P.fresh);
  assert.equal(r.setupCode, "PRUE-BAPR-UEBA", "no owner yet: a one-time code");
  assert.deepEqual(calls, ["check", "screen"]);

  const env = parseEnv(readFileSync(envPath, "utf8"));
  assert.equal(env.PLANIA_DEVVA_PREFIX, P.fresh);
  // The engine the install reached, so the server finds the same one.
  const a = devvaAddress();
  assert.deepEqual([env.DEVVA_HOST, env.DEVVA_PORT, env.DEVVA_TOKEN_FILE], [a.host, String(a.port), a.tokenFile]);
  assert.ok((env.SESSION_SECRET ?? "").length >= 32);
  assert.match(env.MCP_BEARER_TOKEN ?? "", /^[0-9a-f]{64}$/);
  assert.equal(env.DATABASE_URL, undefined, "no Postgres address");
  // The rest of .env.example is kept, so every other setting is still there to fill.
  assert.ok("PLANIA_TZ" in env);

  // The store holds the setup code (its hash) and nothing else the install made.
  const s = await DevvaStore.open({ prefix: P.fresh });
  assert.equal(s.commits, 1);
  s.close();

  assert.equal(await startupProblem(process.env), null);
  const { serve } = await import("@hono/node-server");
  const { app } = await import("../src/app.js");
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((res) => server.once("listening", res));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    await new Promise((res) => server.close(res));
  }

  // A second run (.env names the store) makes nothing new and keeps the generated secrets; a new code replaces the old.
  const again = await install({ prefix: P.fresh, named: false, envPath, buildScreen: async () => {}, setupCode: () => "OTRA-VEZP-RUEB" });
  assert.equal(again.created, false);
  assert.deepEqual(again.envKeys, []);
  assert.equal(again.setupCode, "OTRA-VEZP-RUEB");
  assert.deepEqual(parseEnv(readFileSync(envPath, "utf8")), env);
});

test("install stops on a failed machine check before opening anything", async () => {
  const envPath = path.join(scratch, "check.env");
  await assert.rejects(
    install({ prefix: P.check, named: false, envPath, machineCheck: async () => ({ ok: false, lines: ["falta git"] }) }),
    InstallError,
  );
  assert.ok(!(await lobes()).includes(`${P.check}_log`), "no lobe was declared");
  assert.equal(existsSync(envPath), false);
});

test("install refuses a store that holds data and that it did not make, unless it is named", async () => {
  await purge(P.held);
  const held = await DevvaStore.open({ prefix: P.held });
  await held.write("", {}, (uow) => uow.insert("machineState", { key: "someone.else", value: {} }));
  held.close();
  const envPath = path.join(scratch, "refuse.env");
  await assert.rejects(
    install({ prefix: P.held, named: false, envPath }),
    (e: Error) => e instanceof InstallError && e.message.includes(`--prefix ${P.held}`),
  );
  assert.throws(() => readFileSync(envPath));
  const r = await install({ prefix: P.held, named: true, envPath });
  assert.equal(r.created, false);
  assert.equal(parseEnv(readFileSync(envPath, "utf8")).PLANIA_DEVVA_PREFIX, P.held);
  // The data that was there is still there.
  const back = await DevvaStore.open({ prefix: P.held });
  assert.ok(await back.read((rd) => rd.get("machineState", { key: "someone.else" })));
  back.close();
});

test("a name that cannot be a prefix is refused with one sentence", async () => {
  await assert.rejects(install({ prefix: "Mi-Plania", named: true, envPath: path.join(scratch, "bad.env") }), (e: Error) => e instanceof InstallError && /Mi-Plania/.test(e.message));
});

test("an engine out of reach, a missing token file, a refused token: one sentence each, nothing opened", async () => {
  const envPath = path.join(scratch, "engine.env");
  const fail = (reason: "unreachable" | "no_token" | "bad_token" | "absent") => async () => ({ ok: false as const, reason, where: "127.0.0.1:2505", tokenFile: "/k/devva-token", message: "[CONNECTION_ERROR] Failed to connect" });
  const opened: string[] = [];
  const open = async (prefix: string) => (opened.push(prefix), Promise.reject(new Error("never")));
  for (const [reason, words] of [
    ["unreachable", /No se pudo conectar con el motor devva en 127\.0\.0\.1:2505.*deploy\/devva\/README\.md/],
    ["no_token", /No encuentro la clave del motor devva en \/k\/devva-token/],
    ["bad_token", /no aceptó la clave de \/k\/devva-token/],
    ["absent", /Falta el cliente de devva/],
  ] as const) {
    await assert.rejects(install({ prefix: P.check, named: true, envPath, probe: fail(reason), open }), (e: Error) => e instanceof InstallError && words.test(e.message) && !e.message.includes("\n"));
  }
  assert.deepEqual(opened, []);
  assert.equal(existsSync(envPath), false);
  // The real probe: nothing listens on port 1, and a token file that is not there.
  assert.deepEqual(((await readDevva({ ...process.env, DEVVA_PORT: "1" })) as { reason?: string }).reason, "unreachable");
  assert.deepEqual(((await readDevva({ ...process.env, DEVVA_TOKEN_FILE: path.join(scratch, "missing") })) as { reason?: string }).reason, "no_token");
});

test("check 7: the start-up check gives one sentence for an engine out of reach and for a missing token file", async () => {
  const off = await startupProblem({ ...process.env, DEVVA_HOST: "127.0.0.1", DEVVA_PORT: "1" });
  assert.ok(off && !off.includes("\n"));
  assert.match(off, /El motor devva no responde en 127\.0\.0\.1:1/);
  const token = await startupProblem({ ...process.env, DEVVA_TOKEN_FILE: path.join(scratch, "missing") });
  assert.ok(token && !token.includes("\n"));
  assert.match(token, /Falta la clave del motor devva/);
  assert.equal(await startupProblem(process.env), null);
});

test("check 7: the server refuses to start, with one sentence, when the engine is out of reach", async () => {
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/dev.ts", "--port", "3999"], {
    cwd: REPO,
    encoding: "utf8",
    // Never the live lobes: a prefix of this file, on a port where nothing listens.
    env: { ...process.env, DEVVA_HOST: "127.0.0.1", DEVVA_PORT: "1", PLANIA_DEVVA_PREFIX: P.check, PLANIA_UI_BUILD: "0", PLANIA_JOBS: "0" },
    timeout: 60_000,
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  // Node may add its own warnings (an ExperimentalWarning and its «--trace-warnings» hint on Node 26): not the server's words.
  const lines = r.stderr.trim().split(/\r?\n/).filter((l) => !/ExperimentalWarning|--trace-warnings/.test(l));
  assert.equal(lines.length, 1, r.stderr);
  assert.match(lines[0] ?? "", /El motor devva no responde/);
  assert.doesNotMatch(r.stdout, /plania on http/);
});
