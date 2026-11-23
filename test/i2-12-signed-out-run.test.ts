// PLA-I2-12 #2: a run that fails because Claude is signed out says so, not «sin resultado». The runner starts a fake
// child; what it prints is the fake Claude's own output (test/fixtures/fake-claude.mjs, FAKE_SIGNED_OUT=1).
// Throwaway store, fake values only.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, before, test } from "node:test";
import { resetTestStore, useTestEnv, type TestStore } from "./helpers.js";

useTestEnv();
const { makeDb } = await import("../src/db/client.js");
const { seedOrg } = await import("../scripts/seed-org.js");
const runner = await import("../src/runner/runner.js");
const writes = await import("../src/mcp/writes.js");
const { runWords } = (await import(new URL("../ui/src/lib/calidad.ts", import.meta.url).href)) as { runWords: (s: string) => string | null };
const { startFailureOf } = await import("../src/runner/start-failures.js");

const FAKE_CLAUDE = path.join(import.meta.dirname, "fixtures/fake-claude.mjs");
const scratch = mkdtempSync(path.join(tmpdir(), "plania-i2-12-"));
const ACT = { actor: { agent: "test", session_id: "s" } } as never;
let store: TestStore;
let db: ReturnType<typeof makeDb>["db"];
const id = async (table: "agents" | "projects", slug: string) => (table === "agents" ? (await store.get("agents", { slug }))!.id : store.projectId(slug));

const fakeClaudeOutput = (env: Record<string, string>) =>
  new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(process.execPath, [FAKE_CLAUDE], { env: { ...process.env, FAKE_MS: "30", ...env } }, (err, stdout) => {
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout) });
    });
  });

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  constructor(readonly pid: number) {
    super();
  }
  play(out: { code: number; stdout: string }): void {
    this.stdout.write(out.stdout);
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("exit", out.code, null));
  }
}

before(async () => {
  store = await resetTestStore();
  ({ db } = makeDb());
  await seedOrg(db);
  const repo = path.join(scratch, "repo-micasa");
  mkdirSync(repo, { recursive: true });
  const micasa = await id("projects", "micasa");
  await store.fix(async (uow) => {
    await uow.update("runnerSettings", { id: 1 }, { maxConcurrent: 10, cooldownMinutes: 0, maxStartsPerMinute: 100, companyPaused: false });
    await uow.insert("planReadings", { at: uow.now, source: "stream", status: "allowed", fiveHourPct: 10, fiveHourResetsAt: new Date(uow.now.getTime() + 3 * 3600_000) });
    const p = (await uow.get("projects", { id: micasa }))!;
    await uow.update("projects", { id: micasa }, { runsPaused: false, settings: { ...(p.settings ?? {}), local: { repo_path: repo } } as typeof p.settings });
    await uow.insert("docs", { projectId: micasa, title: "Prompt: Taller", markdown: "# Prompt: Taller", actor: { agent: "test", session_id: "s" } });
  });
});

after(async () => {
  await runner.waitForAllRuns();
  rmSync(scratch, { recursive: true, force: true });
});

async function runOnce(out: { code: number; stdout: string }) {
  const key = ((await writes.createTask(db, { project: "micasa", title: `Sesión ${Math.random()}`, scope: "s", checks: ["c"], status: "Ready" } as never, ACT)) as { key: string }).key;
  const agentId = await id("agents", "taller-micasa");
  const projectId = await id("projects", "micasa");
  const runId = (await store.fix((uow) => uow.insert("agentRuns", { agentId, projectId, role: "taller", status: "queued", summary: "queued: event x", taskKey: key, workKey: `task:${key}`, trigger: "event", lane: "work" }))).id;
  const spawned: FakeChild[] = [];
  const deps = {
    env: { HOME: scratch, PATH: "/usr/bin:/bin", PLANIA_RUNNER_TOKEN: "runner-token", PLANIA_PROMPTS_PROJECT: "micasa", CLAUDE_CODE_BIN: "/fake/bin/claude", PLANIA_WORKER_ID: "test:main" } as NodeJS.ProcessEnv,
    logDir: path.join(scratch, "logs"),
    tmpDir: path.join(scratch, "tmp"),
    worktreeRoot: path.join(scratch, "worktrees"),
    graceMs: 10,
    liveFlushMs: 0,
    footprints: false,
    git: async () => ({ code: 0, stdout: "", stderr: "" }),
    spawn: () => {
      const c = new FakeChild(70_000 + spawned.length);
      spawned.push(c);
      return c;
    },
    kill: () => undefined,
    reportTokens: async () => undefined,
    probeUsage: async () => null,
    machine: () => ({ freeMb: 99_999, freeDiskGb: 999 }),
  };
  await runner.drainQueue(db, new Date(), deps as never);
  assert.equal(spawned.length, 1, "the run started");
  spawned[0]!.play(out);
  await runner.waitForAllRuns();
  const r = (await store.get("agentRuns", { id: runId }))!;
  return { status: r.status, summary: r.summary } as { status: string; summary: string };
}

test("I2-12 #2: a run on a signed-out Claude fails with «sin sesión de Claude», not «sin resultado»", async () => {
  const out = await fakeClaudeOutput({ FAKE_SIGNED_OUT: "1" });
  assert.equal(out.code, 1);
  const row = await runOnce(out);
  assert.equal(row.status, "fail");
  assert.match(row.summary, /^fail: signed out \(1 turns/);
  assert.equal(startFailureOf(row.summary), null, "it started; it is not a start-up failure");
  const words = runWords(row.summary)!;
  assert.match(words, /^Falló: sin sesión de Claude en esta máquina/);
  assert.doesNotMatch(words, /sin dar resultado/);
  // A signed-out run spent nothing: the plan reading is not left unknown by it.
  const unknown = await store.count("planReadings", { status: "unknown" });
  assert.equal(unknown, 0);
});

test("I2-12 #2: the same fake Claude signed in ends ok", async () => {
  const row = await runOnce(await fakeClaudeOutput({}));
  assert.equal(row.status, "ok", row.summary);
});
