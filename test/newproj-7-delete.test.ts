// NEWPROJ-7: deleting a project from the screen. Its live runs stop before the rows go, its worktrees are removed
// (the product repo stays), its team goes so the name can be used again and no orphan serves another project.
// Fake children and fake git (test/runner.test.ts's shape); throwaway DB (test/helpers.ts). No real claude.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, before, test } from "node:test";
import { ownerCode, resetTestStore, useOwnerCode, useTestEnv, type TestStore } from "./helpers.js";

useTestEnv();
await useOwnerCode();
process.env.PLANIA_PROMPTS_PROJECT = "micasa";
const { makeDb } = await import("../src/db/client.js");
const { app } = await import("../src/app.js");
const { createSession, SESSION_COOKIE } = await import("../src/auth/session.js");
const { seedOrg } = await import("../scripts/seed-org.js");
const writes = await import("../src/mcp/writes.js");
const { wakeAgent } = await import("../src/jobs/heartbeat.js");
const runner = await import("../src/runner/runner.js");
const { serviceAgent } = await import("../src/runner/events.js");
const { deleteProjectDeps } = await import("../src/runner/delete-project.js");

type Json = Record<string, any>;
let store: TestStore;
let db: ReturnType<typeof makeDb>["db"];
let closeDb: () => Promise<void>;
const scratch = mkdtempSync(path.join(tmpdir(), "plania-newproj7-"));
const repo = path.join(scratch, "repos", "cafe-lindo");
const wtRoot = path.join(scratch, "worktrees");
const ctx = { actor: { agent: "test-agent", session_id: "s-np7" } };
const TEAM = ["po-cafe-lindo", "research-cafe-lindo", "artist-cafe-lindo", "taller-cafe-lindo"];

const jorge = () => ({ Cookie: `${SESSION_COOKIE}=${createSession()}`, "Content-Type": "application/json" });
const create = () => app.request("/api/company/projects", { method: "POST", headers: jorge(), body: JSON.stringify({ name: "Café Lindo", goal: "Vender café en línea." }) });
const remove = async (slug: string) => app.request(`/api/company/projects/${slug}`, { method: "DELETE", headers: jorge(), body: JSON.stringify({ code: await ownerCode() }) });

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  constructor(readonly pid: number) {
    super();
  }
  exit(code: number | null): void {
    this.stdout.end();
    setImmediate(() => this.emit("exit", code, null));
  }
}

function fakes() {
  const signals: { pid: number; signal: NodeJS.Signals }[] = [];
  const gitCalls: string[][] = [];
  const byPid = new Map<number, FakeChild>();
  let pid = 70_000;
  const git = async (args: string[]) => {
    gitCalls.push(args);
    if (args[0] === "worktree" && args[1] === "add") {
      const target = args.find((a) => a.startsWith(wtRoot))!;
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, ".git"), `gitdir: ${repo}/.git/worktrees/x\n`);
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 1, stdout: "", stderr: "" };
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "jl/caf-1\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const deps = {
    env: { HOME: scratch, PATH: "/usr/bin:/bin", PLANIA_RUNNER_TOKEN: "runner-token", PLANIA_PROMPTS_PROJECT: "micasa", CLAUDE_CODE_BIN: "/fake/bin/claude" } as NodeJS.ProcessEnv,
    logDir: path.join(scratch, "logs"),
    tmpDir: path.join(scratch, "tmp"),
    worktreeRoot: wtRoot,
    graceMs: 10,
    liveFlushMs: 0,
    footprints: false,
    git,
    spawn: () => {
      const child = new FakeChild(++pid);
      byPid.set(pid, child);
      return child;
    },
    // SIGINT ends the fake run, like claude -p does.
    kill: (target: number, signal: NodeJS.Signals) => {
      signals.push({ pid: target, signal });
      if (signal === "SIGINT") byPid.get(target)?.exit(130);
    },
    reportTokens: async () => undefined,
    probeUsage: async () => null,
  };
  return { deps, signals, gitCalls, git };
}

before(async () => {
  store = await resetTestStore();
  ({ db, close: closeDb } = makeDb());
  await seedOrg(db);
  mkdirSync(repo, { recursive: true });
  const micasa = await store.projectId("micasa");
  const actor = { agent: "test", session_id: "s" };
  await store.fix(async (uow) => {
    await uow.update("runnerSettings", { id: 1 }, { companyPaused: false, maxConcurrent: 2, cooldownMinutes: 0, guardOverride: false, planGuardPct: 70 });
    await uow.insert("planReadings", { at: uow.now, source: "stream", status: "allowed", fiveHourPct: 10, sevenDayPct: 19, fiveHourResetsAt: new Date(uow.now.getTime() + 3 * 3_600_000) });
    for (const title of ["Prompt: Product owner", "Prompt: Taller", "Prompt: Research", "Prompt: Artist", "Prompt: Asistente"]) {
      await uow.insert("docs", { projectId: micasa, title, markdown: `# ${title}`, actor });
    }
  });
});

after(async () => {
  await runner.waitForAllRuns();
  await closeDb?.();
  await store?.end();
  rmSync(scratch, { recursive: true, force: true });
});

test("NEWPROJ-7: a deleted project's team goes with it, no row of it serves another project, and the same name can be created again", async () => {
  assert.equal((await create()).status, 201);
  await store.fix((uow) => uow.insert("agentTokens", { name: "po token", agent: "po-cafe-lindo", tokenHash: "hash-np7", prefix: "pla_np7" }));
  const res = await remove("cafe-lindo");
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as Json;
  assert.equal(body.deleted, "cafe-lindo");
  assert.deepEqual([...body.agents].sort(), [...TEAM].sort());
  assert.equal(await store.count("agents", { slug: TEAM }), 0, "no orphan rows");
  assert.notEqual((await store.get("agentTokens", { tokenHash: "hash-np7" }))!.revokedAt, null, "its tokens are revoked");

  // A project with no team of its own: the runner's company-level fallback must never be a deleted project's member.
  const otro = await store.fix((uow) => uow.insert("projects", { slug: "otro", title: "Otro", keyPrefix: "OTR" }));
  for (const role of ["product-owner", "research", "artist", "taller"] as const) {
    const picked = await serviceAgent(db, role, otro);
    assert.ok(!picked || !TEAM.includes(picked.slug), `${role} → ${picked?.slug}`);
  }

  const again = await create();
  assert.equal(again.status, 201, await again.clone().text());
  assert.deepEqual(((await again.json()) as Json).team, TEAM);
});

test("NEWPROJ-7: live runs are stopped and have ended before the rows go; its worktrees are removed and the repo stays", async () => {
  const f = fakes();
  const p = await store.projectId("cafe-lindo");
  await store.fix((uow) => uow.update("projects", { id: p }, { runsPaused: false, settings: { local: { repo_path: repo } } }));
  await writes.createTask(db, { project: "cafe-lindo", key: "CAF-1", title: "Una tarea", scope: "Scope", checks: ["Done"], status: "Ready" } as never, ctx);
  const woke = await wakeAgent(db, { agent: "taller-cafe-lindo", taskKey: "CAF-1", now: new Date() }, { runner: f.deps as never });
  assert.equal(woke.run?.status, "running", JSON.stringify(woke));
  const wt = path.join(wtRoot, "cafe-lindo", "CAF-1");
  assert.ok(existsSync(wt), "the run has its worktree");
  mkdirSync(path.join(wtRoot, "cafe-lindo", "_taller-cafe-lindo"), { recursive: true });

  let atStop: { runs: { status: string }[]; projects: number } | null = null;
  Object.assign(deleteProjectDeps, {
    worktreeRoot: wtRoot,
    git: f.git,
    stop: async (id: string, reason: string) => {
      const n = await runner.stopProjectRuns(id, reason, 5_000);
      atStop = {
        runs: (await store.find("agentRuns", { projectId: id, taskKey: "CAF-1" })).map((r) => ({ status: r.status })),
        projects: await store.count("projects", { id }),
      };
      return n;
    },
  });
  try {
    const res = await remove("cafe-lindo");
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as Json;
    assert.equal(body.stopped, 1);
    assert.equal(body.worktrees, 1);
    assert.equal(f.signals[0]?.signal, "SIGINT");
    assert.deepEqual(atStop, { runs: [{ status: "stopped" }], projects: 1 }, "the run had ended while the project row was still there");
    assert.ok(f.gitCalls.some((a) => a.join(" ") === `worktree remove --force ${wt}`));
    assert.equal(existsSync(path.join(wtRoot, "cafe-lindo")), false, "the project's folder under the worktrees root is gone");
    assert.ok(existsSync(repo), "the product repo is never touched");
    assert.equal(await store.count("agentRuns", { projectId: p }), 0);
    // NEWPROJ-7 on the store (no foreign keys): every row that hung off the project or its team went with it, as the
    // ON DELETE cascades took them on main.
    for (const t of ["tasks", "events", "goals", "threads", "heartbeatRuns", "agentSessions", "runLocks"] as const) {
      const rows = (await store.find(t)) as { projectId?: string; agentId?: string }[];
      const team = new Set((await store.find("agents")).map((a) => a.id));
      assert.equal(rows.filter((r) => r.projectId === p || (r.agentId !== undefined && !team.has(r.agentId))).length, 0, `${t} rows left`);
    }
  } finally {
    for (const k of Object.keys(deleteProjectDeps)) delete (deleteProjectDeps as Record<string, unknown>)[k];
  }
});

test("NEWPROJ-7: without the owner's code nothing is stopped or removed", async () => {
  assert.equal((await create()).status, 201);
  let stopped = false;
  Object.assign(deleteProjectDeps, { stop: async () => ((stopped = true), 0) });
  try {
    const res = await app.request(`/api/company/projects/cafe-lindo`, { method: "DELETE", headers: jorge(), body: "{}" });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as Json).error, "OWNER_CODE_REQUIRED");
    assert.equal(stopped, false);
    assert.equal(await store.count("agents", { slug: TEAM }), 4);
  } finally {
    delete deleteProjectDeps.stop;
  }
});
