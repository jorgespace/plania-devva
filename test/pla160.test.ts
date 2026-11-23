// PLA-160: an answer gives a finished run's claim back (F-33); the Publicar sheet rechecks GitHub (F-35).
// Throwaway DB (test/helpers.ts). No real claude: runs are rows.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { resetTestStore, useTestEnv, type TestStore } from "./helpers.js";

useTestEnv();
const { makeDb } = await import("../src/db/client.js");
const { seedLegacyOrg: seedOrg } = await import("./fixtures/legacy-org.js");
const writes = await import("../src/mcp/writes.js");
const questions = await import("../src/mcp/questions.js");
const { webCtx } = await import("../src/mcp/tx.js");
const { runSession } = await import("../src/runner/run-session.js");

type Db = ReturnType<typeof makeDb>["db"];
let store: TestStore;
let db: Db;
let closeDb: () => Promise<void>;
const ctx = { actor: { agent: "test-agent", session_id: "s-pla160" } };

const id = async (table: "agents" | "projects", slug: string): Promise<string> =>
  table === "agents" ? (await store.get("agents", { slug }))!.id : store.projectId(slug);
// settings.github on micasa set to this value, or removed with null.
const setGithub = (github: { repo: string } | null) =>
  store.fix(async (uow) => {
    const p = (await uow.get("projects", { slug: "micasa" }))!;
    const { github: _old, ...rest } = p.settings;
    await uow.update("projects", { id: p.id }, { settings: github === null ? rest : { ...rest, github } });
  });

before(async () => {
  store = await resetTestStore();
  ({ db, close: closeDb } = makeDb());
  await seedOrg(db);
});
after(async () => {
  await closeDb();
  await store.end();
});

// A ticket In progress, claimed by a Taller run, which then asks the owner. Returns the question id.
async function askedByRun(key: string, runStatus: string): Promise<{ q: string; session: string }> {
  await writes.createTask(db, { project: "micasa", key, title: `Ticket ${key}`, scope: "Scope", checks: ["Done"], status: "Ready" } as never, ctx);
  const [agentId, projectId] = [await id("agents", "taller"), await id("projects", "micasa")];
  const run = await store.fix((uow) => uow.insert("agentRuns", { agentId, projectId, role: "taller", status: "running", taskKey: key, startedAt: uow.now, queuedAt: uow.now }));
  const session = runSession(run.id);
  const runCtx = { actor: { agent: "plania-runner", session_id: session, machine: "m" } };
  await writes.claim(db, { project: "micasa", key } as never, runCtx as never);
  const { version } = (await store.get("tasks", { key }))!;
  await writes.setTask(db, { project: "micasa", key, status: "In progress", version } as never, runCtx as never);
  const asked = await questions.ask(db, { project: "micasa", key, question: "¿Cuál?", options: ["A", "B"] }, runCtx as never);
  await store.fix((uow) => uow.update("agentRuns", { id: run.id }, { status: runStatus, endedAt: ["starting", "running"].includes(runStatus) ? null : uow.now }));
  return { q: (asked as { question_id: string }).question_id, session };
}

const row = async (key: string) => {
  const t = (await store.get("tasks", { key }))!;
  return { status: t.status, owner: t.owner as { session_id: string } | null, lease_until: t.leaseUntil };
};

test("PLA-160 #1: answering after the asking run ended frees its claim; the ticket is Ready for the woken run", async () => {
  const { q } = await askedByRun("P160-A", "ok");
  assert.equal((await row("P160-A")).status, "Needs owner");
  await questions.answer(db, { project: "micasa", question_id: q, answer: "A" }, webCtx);
  const t = await row("P160-A");
  assert.deepEqual([t.status, t.owner, t.lease_until], ["Ready", null, null]);
  const ev = await store.find("events", { type: "claim.released", taskKey: "P160-A" });
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.payload.reason, "answered");
  // The next run can claim it straight away.
  const next = { actor: { agent: "plania-runner", session_id: "run-1111222233334444", machine: "m" } };
  await writes.claim(db, { project: "micasa", key: "P160-A" } as never, next as never);
  assert.equal((await row("P160-A")).owner?.session_id, "run-1111222233334444");
});

test("PLA-160 #2: a run still running keeps its claim, and the ticket goes back In progress", async () => {
  const { q, session } = await askedByRun("P160-B", "running");
  await questions.answer(db, { project: "micasa", question_id: q, answer: "B" }, webCtx);
  const t = await row("P160-B");
  assert.equal(t.status, "In progress");
  assert.equal(t.owner?.session_id, session);
});

test("PLA-160 #3: a person's claim is never touched by an answer", async () => {
  await writes.createTask(db, { project: "micasa", key: "P160-C", title: "Ticket", scope: "Scope", checks: ["Done"], status: "Ready" } as never, ctx);
  await writes.claim(db, { project: "micasa", key: "P160-C" } as never, ctx as never);
  const { version } = (await store.get("tasks", { key: "P160-C" }))!;
  await writes.setTask(db, { project: "micasa", key: "P160-C", status: "In progress", version } as never, ctx as never);
  const asked = (await questions.ask(db, { project: "micasa", key: "P160-C", question: "¿Cuál?" }, ctx as never)) as { question_id: string };
  await questions.answer(db, { project: "micasa", question_id: asked.question_id, answer: "Esa" }, webCtx);
  const t = await row("P160-C");
  assert.equal(t.status, "In progress");
  assert.equal(t.owner?.session_id, "s-pla160");
});

// PLA-160 (F-35): the Publicar sheet's recheck polls the project's GitHub once, throttled.
test("PLA-160 #4: a recheck polls GitHub once; a second inside the window does not; later it polls again", async () => {
  const gh = await import("../src/jobs/github.js");
  gh.resetRechecksForTests();
  await setGithub({ repo: "acme/micasa" });
  let calls = 0;
  const fetch = async () => {
    calls++;
    return { status: 200, headers: { get: () => null }, json: async () => [] };
  };
  const deps = { fetch, env: { GITHUB_TOKEN: "ghp_test" } } as never;
  const t0 = 1_000_000;
  assert.deepEqual(await gh.recheckGithubProject(db, "micasa", deps, t0), { checked: true });
  const first = calls;
  assert.ok(first > 0, "it asked GitHub");
  assert.deepEqual(await gh.recheckGithubProject(db, "micasa", deps, t0 + 5_000), { checked: false });
  assert.equal(calls, first, "throttled: no second poll inside the window");
  assert.deepEqual(await gh.recheckGithubProject(db, "micasa", deps, t0 + gh.RECHECK_MS + 1), { checked: true });
  assert.ok(calls > first);
});

test("PLA-160 #5: a project with no GitHub repo is not polled; an unknown project is PROJECT_NOT_FOUND", async () => {
  const gh = await import("../src/jobs/github.js");
  gh.resetRechecksForTests();
  await setGithub(null);
  let calls = 0;
  const deps = { fetch: async () => (calls++, { status: 200, headers: { get: () => null }, json: async () => [] }), env: { GITHUB_TOKEN: "ghp_test" } } as never;
  assert.deepEqual(await gh.recheckGithubProject(db, "micasa", deps), { checked: false });
  assert.equal(calls, 0);
  await assert.rejects(gh.recheckGithubProject(db, "no-such-project", deps), /PROJECT_NOT_FOUND/);
});
