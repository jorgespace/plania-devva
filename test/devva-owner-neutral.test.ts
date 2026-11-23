// PLA-I2-14 on the devva store: main's 0062_owner_neutral as a data step (src/store/owner-neutral.ts).
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { resetTestStore, useTestEnv, type TestStore } from "./helpers.js";

useTestEnv();
const { ownerNeutral, neutralJson } = await import("../src/store/owner-neutral.js");

let store: TestStore;
before(async () => {
  store = await resetTestStore();
});

test("only whole JSON strings change; free text that names the first owner stays", () => {
  assert.deepEqual(neutralJson({ agent: "jorge", note: "jorge dijo que sí", to: "Needs Jorge" }), { agent: "owner", note: "jorge dijo que sí", to: "Needs owner" });
  assert.deepEqual(neutralJson(["needs_jorge", { code: "WAITING_ON_JORGE_FREE_TEXT" }]), ["needs_owner", { code: "WAITING_ON_OWNER_FREE_TEXT" }]);
  assert.equal(neutralJson({ agent: "owner" }), undefined);
  assert.equal(neutralJson(null), undefined);
});

test("statuses, origins, authors and jsonb values become neutral, and a second run changes nothing", async () => {
  const micasa = await store.projectId("micasa");
  const jorge = { agent: "jorge", session_id: "web", machine: "screen" };
  const task = await store.fix((uow) =>
    uow.insert("tasks", { projectId: micasa, kind: "ticket", key: "MIC-900", title: "Pedido", status: "Needs Jorge", origin: "jorge" }),
  );
  await store.fix(async (uow) => {
    await uow.insert("taskComments", { taskId: task.id, authorAgent: "jorge", body: "jorge pide esto" });
    await uow.insert("events", { projectId: micasa, taskId: task.id, taskKey: task.key, type: "task.status", actor: jorge, payload: { from: "Ready", to: "Needs Jorge" } });
  });

  const changed = await store.fix(ownerNeutral);
  assert.ok((changed.tasks ?? 0) >= 1 && (changed.taskComments ?? 0) >= 1 && (changed.events ?? 0) >= 1, JSON.stringify(changed));

  const after = await store.get("tasks", { id: task.id });
  assert.equal(after?.status, "Needs owner");
  assert.equal(after?.origin, "owner");
  const [comment] = await store.find("taskComments", { taskId: task.id });
  assert.equal(comment?.authorAgent, "owner");
  assert.equal(comment?.body, "jorge pide esto");
  const [event] = await store.find("events", { taskId: task.id });
  assert.deepEqual(event?.payload, { from: "Ready", to: "Needs owner" });
  assert.deepEqual(event?.actor, { agent: "owner", session_id: "web", machine: "screen" });

  assert.deepEqual(await store.fix(ownerNeutral), {});
});
