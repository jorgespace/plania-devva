// PLA-104: a wake for Taller that arrived while it was busy was coalesced and lost, so an idle Taller sat next to its
// own Ready tickets (MIA-38, MIA-40 in guided test 2). When a Taller run ends well it takes the next one it owns:
// «Hacer primero» first, never the ticket that just ran, never a blocked one. Throwaway DB, fake values only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { resetTestStore, useOwnerCode, useTestEnv, type TestStore } from "./helpers.js";

useTestEnv();
await useOwnerCode();
process.env.PLANIA_EVENT_WAKES = "1";
process.env.PLANIA_HOME_PROJECT = "zigzag";
process.env.PLANIA_PROMPTS_PROJECT = "micasa";
const { makeDb } = await import("../src/db/client.js");
const { seedOrg } = await import("../scripts/seed-org.js");
const writes = await import("../src/mcp/writes.js");
const events = await import("../src/runner/events.js");

type Json = Record<string, any>;
let store: TestStore;
let db: ReturnType<typeof makeDb>["db"];
let closeDb: () => Promise<void>;
const ME = { actor: { agent: "test", session_id: "pla104" } };

before(async () => {
  store = await resetTestStore();
  const made = makeDb();
  db = made.db;
  closeDb = made.close;
  await seedOrg(made.db);
  await store.fix(async (uow) => {
    await uow.update("runnerSettings", { id: 1 }, { companyPaused: false });
    await uow.update("projects", {}, { runsPaused: false });
  });
});
after(async () => {
  await closeDb?.();
  await store?.end();
});

async function taller(): Promise<{ agent: never; slug: string }> {
  const micasa = await store.projectId("micasa");
  // micasa's own Taller first, then a company-level one (project_id null sorts last).
  const rows = (await store.find("agents", { roleTemplate: "taller" })).filter((a) => a.projectId === micasa || a.projectId === null).sort((x, y) => Number(x.projectId === null) - Number(y.projectId === null));
  const a = rows[0];
  assert.ok(a, "seed has a Taller");
  return { agent: a as never, slug: a.slug };
}
const projectRef = async () => ({ id: await store.projectId("micasa"), slug: "micasa" });
// Every run gone; run_locks went with them through the foreign key.
const deleteRuns = () =>
  store.fix(async (uow) => {
    await uow.delete("runLocks", {});
    await uow.delete("agentRuns", {});
  });
// settings.next_first set, or removed with null.
const setNextFirst = (key: string | null) =>
  store.fix(async (uow) => {
    const p = (await uow.get("projects", { slug: "micasa" }))!;
    const { next_first: _old, ...rest } = p.settings as Json;
    await uow.update("projects", { id: p.id }, { settings: key === null ? rest : { ...rest, next_first: key } });
  });
const ticket = async (title: string, extra: Json = {}) =>
  ((await writes.createTask(db, { project: "micasa", title, scope: "s", checks: ["c"], status: "Ready", ...extra } as never, ME)) as Json).key as string;

test("PLA-104 #1: a Taller run that ends takes its next unblocked Ready ticket, «Hacer primero» first, never the one that ran", async () => {
  const { agent, slug } = await taller();
  const ran = await ticket("La que corrió", { owner_agent: slug });
  const older = await ticket("Más vieja", { owner_agent: slug });
  const first = await ticket("Hacer primero", { owner_agent: slug });
  await ticket("Bloqueada", { owner_agent: slug, blocked_by: [{ human_action: { text: "Owner: algo" } }] });
  await ticket("[PRUEBA] no", { owner_agent: slug });
  await deleteRuns();
  await setNextFirst(first);
  const out = (await events.wakePoIfWaiting(db as never, agent, await projectRef(), ran)) as Json;
  assert.equal(out?.kind, "queued", JSON.stringify(out));
  assert.equal(out.taskKey, first);
  // Without «Hacer primero»: the oldest one that is not the ticket that ran.
  await deleteRuns();
  await setNextFirst(null);
  const again = (await events.wakePoIfWaiting(db as never, agent, await projectRef(), ran)) as Json;
  assert.equal(again?.taskKey, older, JSON.stringify(again));
});

test("PLA-104 #2: nothing is queued when Taller owns no unblocked Ready ticket besides the one that ran", async () => {
  const { agent } = await taller();
  const left = (await store.get("tasks", { kind: "ticket", status: "Ready", title: "La que corrió" }))!.key;
  await store.fix((uow) => uow.update("tasks", { kind: "ticket", status: "Ready", title: ["Más vieja", "Hacer primero"] }, { status: "Done" }));
  await deleteRuns();
  const out = await events.wakePoIfWaiting(db as never, agent, await projectRef(), left);
  assert.equal(out, null);
});
