// PLA-I73-2: stacked steps. With settings.velocidad.apilar on, a chained step goes Ready as soon as the step it waits
// on is delivered (In review with a branch: src/mcp/blockers.ts chainedReady). Its worktree is cut from that branch,
// so it builds on code that is not in the start branch yet; its PR still goes to the start branch and shows the step
// under it too until that one merges. It may only be accepted after the step under it (stackHold).
import type { Q } from "../mcp/tx.js";
import type { Task } from "../db/schema.js";
import { readerOf } from "../store/port.js";
import type { Reader } from "../store/types.js";
import { velocidadOf } from "./velocidad.js";
import { ST } from "../state/status.js";

const LANDED = [ST.merged, ST.released, ST.done];

export type StackBase = { key: string; title: string; branch: string; status: string };

// The tasks on the other side of a task's blocker links: what it waits on (its blockers), or what waits on it.
async function linked(r: Reader, where: { taskId: string } | { blockerId: string }): Promise<Task[]> {
  const links = await r.find("taskBlockers", where);
  const ids = links.map((l) => ("taskId" in where ? l.blockerId : l.taskId));
  return ids.length ? r.find("tasks", { id: ids }) : [];
}

/** The step this one is stacked on: its one unlanded task blocker, when that blocker has a branch. */
export async function stackBaseOf(db: Q, taskId: string): Promise<StackBase | null> {
  const r = readerOf(db);
  const rows = (await linked(r, { taskId })).filter((t) => !LANDED.includes(t.status as (typeof LANDED)[number]));
  if (rows.length !== 1) return null;
  const b = rows[0]!;
  if (!b.branch?.trim()) return null;
  const p = await r.get("projects", { id: b.projectId });
  if (!velocidadOf(p?.settings).apilar) return null;
  return { key: b.key, title: b.title, branch: b.branch.trim(), status: b.status };
}

/** Why this step cannot be accepted yet: a step it waits on has not landed. null: it may be accepted. */
export async function stackHold(db: Q, taskId: string): Promise<StackBase | null> {
  const held: string[] = [...LANDED, ST.wontDo];
  const [b] = (await linked(readerOf(db), { taskId })).filter((t) => !held.includes(t.status));
  return b ? { key: b.key, title: b.title, branch: b.branch ?? "", status: b.status } : null;
}

/** Open steps stacked on this one (they wait on it and have started): told when it goes back to Taller. */
export async function stackedOn(db: Q, blockerId: string): Promise<{ id: string; key: string }[]> {
  const open: string[] = [ST.ready, ST.inProgress, ST.inReview];
  return (await linked(readerOf(db), { blockerId })).filter((t) => open.includes(t.status)).map((t) => ({ id: t.id, key: t.key }));
}

// PLA-I73-6: the early skeleton. When an idea's plan is delivered and its first step is the skeleton, Taller builds
// that step on the idea's own branch before «Constrúyelo» (src/mcp/stage-docs.ts queues it). Step 1's ticket then
// starts from that branch, as long as the plan it was built for is still the current one.
export const EARLY_EVENT = "esqueleto.temprano";

export async function earlyBaseOf(db: Q, taskId: string): Promise<{ idea: string; branch: string } | null> {
  const r = readerOf(db);
  const t = await r.get("tasks", { id: taskId });
  if (!t?.parentId || t.phase !== 1) return null;
  const init = await r.get("tasks", { id: t.parentId });
  if (!init) return null;
  const idea = await r.get("tasks", { projectId: t.projectId, kind: "idea", promotedTo: init.key });
  if (!idea) return null;
  const evs = await r.find("events", { taskId: idea.id, type: [EARLY_EVENT, "stage.delivered"] }, { orderBy: [{ column: "id", desc: true }] });
  const early = evs.find((e) => e.type === EARLY_EVENT);
  const plan = evs.find((e) => e.type === "stage.delivered" && (e.payload as { stage?: string }).stage === "planning");
  if (!early || !plan) return null;
  if ((early.payload as { doc_version?: number }).doc_version !== (plan.payload as { doc_version?: number }).doc_version) return null;
  const branch = (early.payload as { branch?: string }).branch;
  return branch ? { idea: idea.key, branch } : null;
}
