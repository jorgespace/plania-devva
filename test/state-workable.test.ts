// PLA-I74-4: one answer to "can this step be worked on?". The predicate, the readers that use it (get_next's nextTask,
// the heartbeat's loadReady behind «Que empiece ya», the board's readyOf) and the transitions table the wake rules read.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { resetTestStore, useTestEnv, type TestStore } from "./helpers.js";

useTestEnv();
const { makeDb } = await import("../src/db/client.js");
const writes = await import("../src/mcp/writes.js");
const { nextTask, findProject } = await import("../src/mcp/queries.js");
const { loadReady } = await import("../src/jobs/heartbeat.js");
const { readyOf } = await import("../src/api/company-plan.js");
const { workable, queueable, claimable } = await import("../src/state/workable.js");
const { ST } = await import("../src/state/status.js");
const { TRANSITIONS, wakeOf } = await import("../src/state/transitions.js");
const { assertTransition } = await import("../src/mcp/lifecycle.js");

const A = { actor: { agent: "test-agent", session_id: "s-state" } };
let store: TestStore;
let db: ReturnType<typeof makeDb>["db"];
let closeDb: () => Promise<void>;
let projectId = "";
const keys: Record<string, string> = {};

const create = async (args: Record<string, unknown>) => ((await writes.createTask(db, { project: "filmia", scope: "s", checks: ["c"], ...args } as never, A)) as { key: string }).key;

before(async () => {
  store = await resetTestStore();
  ({ db, close: closeDb } = makeDb());
  projectId = await store.projectId("filmia");
  const person = await store.fix(async (uow) => {
    await uow.update("projects", { id: projectId }, { runsPaused: false });
    return (await uow.insert("agents", { slug: "dueno-state", name: "Dueño", role: "owner", kind: "human" })).id;
  });
  const held = await create({ kind: "initiative", title: "Pospuesta" });
  keys.free = await create({ title: "Libre", status: "Ready", priority: "P3" });
  const blocker = await create({ title: "Antes" });
  keys.blocked = await create({ title: "Detrás de otro", status: "Ready", priority: "P0", blocked_by: [blocker] });
  keys.onHold = await create({ title: "En una iniciativa en espera", status: "Ready", priority: "P0", parent_key: held, phase: 1 });
  keys.person = await create({ title: "Del dueño", status: "Ready", priority: "P0" });
  keys.leased = await create({ title: "Tomado", status: "Ready", priority: "P0" });
  await store.fix(async (uow) => {
    await uow.update("tasks", { projectId, key: held }, { status: "On hold" });
    await uow.update("tasks", { projectId, key: keys.person! }, { ownerAgent: person });
    await uow.update("tasks", { projectId, key: keys.leased! }, { owner: { agent: "otro", session_id: "s-otro" }, claimedAt: uow.now, leaseUntil: new Date(uow.now.getTime() + 20 * 60_000) });
    // The blocker itself waits (Blocked), so get_next, which offers Backlog too, has nothing else to offer.
    await uow.update("tasks", { projectId, key: blocker }, { status: "Blocked" });
  });
});

after(async () => {
  await closeDb?.();
  await store?.end();
});

const among = (list: string[]) => Object.entries(keys).filter(([, k]) => list.includes(k)).map(([name]) => name).sort();

describe("the workable predicate", () => {
  test("only the free step is workable: not blocked, not under On hold, not a person's, not leased", async () => {
    const rows = await workable(store, await store.find("tasks", { projectId }));
    assert.deepEqual(among(rows.map((r) => r.key)), ["free"]);
  });

  test("queueable keeps the step behind a blocker (the card says «Espera a un paso») and still leaves out On hold and a person's step", async () => {
    const rows = await queueable(store, await store.find("tasks", { projectId }));
    assert.deepEqual(among(rows.map((r) => r.key)), ["blocked", "free", "leased"]);
  });

  test("claimable is workable from Backlog or Ready, or a stale claim; a live lease holds it whatever its status", async () => {
    const rows = await claimable(store, await store.find("tasks", { projectId }), { backlog: false });
    assert.deepEqual(among(rows.map((r) => r.key)), ["free"]);
  });
});

describe("every reader gives the same answer", () => {
  test("get_next offers the free step though four P0 steps outrank it", async () => {
    assert.equal((await nextTask(db, projectId)).task?.key, keys.free);
  });

  test("the heartbeat's ready work (behind «Que empiece ya» and the cadence) is the free step only", async () => {
    const ready = (await loadReady(db)).filter((r) => r.project === "filmia").map((r) => r.key);
    assert.deepEqual(among(ready), ["free"]);
  });

  test("the board's queues hold no On hold step and no person's step; the person's step leads Siguiente", async () => {
    const out = await readyOf(db, await findProject(db, "filmia"), null, null);
    const queued = out.queued.map((q) => q.key);
    assert.deepEqual(among(queued), ["blocked", "free", "leased"]);
    assert.equal(out.next?.key, keys.person);
    assert.equal(out.next?.owner, "owner");
  });
});

describe("the transitions table", () => {
  test("every row the table lists is a move the status machine allows its mover to make", () => {
    for (const t of TRANSITIONS) {
      if (t.from === null) continue;
      for (const by of t.by) {
        const via = by === "system" ? "system" : by === "claim" ? "claim" : by === "ask" ? "ask" : by === "answer" ? "answer" : "set_task";
        const ctx = { via, human: by === "owner", workType: t.to === ST.done && t.kind === "ticket" ? (t.from === ST.inReview ? "ops" : t.from === ST.backlog || t.from === ST.ready || t.from === ST.inProgress ? "decision-needed" : "code") : "code" } as const;
        if (t.kind === "ticket" && t.from === ST.inProgress && t.to === ST.ready && by === "system") continue; // the lease reaper writes directly
        if (t.kind === "ticket" && t.from === ST.blocked && t.to === ST.ready && by === "system") continue; // blocker.satisfied writes directly
        assert.doesNotThrow(() => assertTransition(t.kind, t.from!, t.to, ctx as never), `${t.kind} ${t.from} → ${t.to} by ${by}`);
      }
    }
  });

  test("the wakes: a move into Ready, a landing, an initiative turning Active; nothing else", () => {
    assert.equal(wakeOf(ST.backlog, ST.ready), "ready");
    assert.equal(wakeOf(null, ST.ready, "ticket"), "ready");
    assert.equal(wakeOf(ST.ready, ST.ready), null);
    assert.equal(wakeOf(ST.inReview, ST.merged), "landed");
    assert.equal(wakeOf(ST.inReview, ST.done), "landed");
    assert.equal(wakeOf(ST.merged, ST.released), null);
    assert.equal(wakeOf(ST.planning, ST.active, "initiative"), "initiative-started");
    assert.equal(wakeOf(ST.active, ST.onHold, "initiative"), null);
    assert.equal(wakeOf(ST.ready, ST.inProgress), null);
    const woke = TRANSITIONS.filter((t) => t.wake).map((t) => `${t.kind}:${t.from}→${t.to}=${t.wake}`);
    assert.ok(woke.includes(`ticket:${ST.inProgress}→${ST.ready}=ready`));
    assert.ok(woke.includes(`initiative:${ST.onHold}→${ST.active}=initiative-started`));
  });
});
