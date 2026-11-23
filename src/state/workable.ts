// PLA-I74-4: "can this step be worked on?" has one answer. Before, five readers each wrote their own (get_next's
// nextTask, the board's readyOf, the heartbeat's loadReady behind «Que empiece ya», and the idle sweeps in
// runner/events.ts), and PLA-161, 163, 164 and 165 were the same gap found four times: one reader learned about an
// On hold initiative, a blocker or a person's own step, the others did not.
//
// A step is workable when it is a Ready ticket, every blocker holds, its initiative is not On hold, no person owns it
// (a human agent or the ceo seat: the owner's own steps) and no live lease holds it. Unowned work stays workable:
// who takes it is pickReady's and the wake rules' business, not this predicate's.
//
// The rule runs over task rows: workableRule reads what it needs beyond the rows (their blockers, their initiatives,
// their owner agents) once for the whole batch, and its parts answer for one row at a time.
import type { Task } from "../db/schema.js";
import { blockedTaskIds } from "../mcp/blockers.js";
import type { Reader, UnitOfWork } from "../store/types.js";
import { ST } from "./status.js";

// The columns the rule reads.
export type WorkableRow = Pick<Task, "id" | "projectId" | "kind" | "status" | "parentId" | "ownerAgent" | "leaseUntil">;

export type WorkableRule = {
  // The ticket's initiative (if any) is not On hold (PLA-161, PLA-163).
  parentNotOnHold: (t: WorkableRow) => boolean;
  // No person owns it: a human agent or the ceo seat (PLA-165).
  notPersonOwned: (t: WorkableRow) => boolean;
  // Every blocker holds (R-15).
  unblocked: (t: WorkableRow) => boolean;
  // No lease that is still running.
  noLiveLease: (t: WorkableRow) => boolean;
  // What every reader shares, whatever statuses it starts from.
  workableCore: (t: WorkableRow) => boolean;
  // The one predicate: a Ready ticket an agent may start now.
  workable: (t: WorkableRow) => boolean;
  // The board's queues (readyOf) also show a Ready step that still waits on a blocker, so the teammate's card can say
  // «Espera a un paso» (PLA-I40-1): queueable is workable without the blocker and lease parts. Once its blockers hold it
  // is workable, and nothing else about it changed.
  queueable: (t: WorkableRow) => boolean;
  // get_next (nextTask) also offers Backlog unless the project says claim_from ready, and an In progress ticket whose
  // lease is gone (stale_claim: whoever held it hands it back). The rest of the rule is workable's.
  claimable: (t: WorkableRow, opts: { backlog: boolean }) => boolean;
};

// The write's clock inside a write (now() in the transaction), else the wall clock.
const clockOf = (r: Reader): Date => (r as Partial<UnitOfWork>).now ?? new Date();

// The rule for a batch of task rows (of one project or many). now is the clock leases and time_after blockers are read
// against: the write's own inside a write, else the wall clock.
export async function workableRule(r: Reader, rows: readonly WorkableRow[], now: Date = clockOf(r)): Promise<WorkableRule> {
  const tickets = rows.filter((t) => t.kind === "ticket");
  const parentIds = [...new Set(tickets.map((t) => t.parentId).filter((x): x is string => !!x))];
  const heldParents = new Set(parentIds.length ? (await r.find("tasks", { id: parentIds, status: ST.onHold })).map((p) => p.id) : []);
  const ownerIds = [...new Set(tickets.map((t) => t.ownerAgent).filter((x): x is string => !!x))];
  const persons = new Set(ownerIds.length ? (await r.find("agents", { id: ownerIds })).filter((a) => a.kind === "human" || a.slug === "ceo").map((a) => a.id) : []);
  // Blockers are read per project: a typed blocker holds against its own project's environments and metrics.
  const byProject = new Map<string, string[]>();
  for (const t of tickets) byProject.set(t.projectId, [...(byProject.get(t.projectId) ?? []), t.id]);
  const blocked = new Set<string>();
  for (const [projectId, ids] of byProject) for (const id of await blockedTaskIds(r, projectId, ids, now)) blocked.add(id);

  const parentNotOnHold = (t: WorkableRow) => !t.parentId || !heldParents.has(t.parentId);
  const notPersonOwned = (t: WorkableRow) => !t.ownerAgent || !persons.has(t.ownerAgent);
  const unblocked = (t: WorkableRow) => !blocked.has(t.id);
  const noLiveLease = (t: WorkableRow) => t.leaseUntil === null || t.leaseUntil.getTime() <= now.getTime();
  const workableCore = (t: WorkableRow) => t.kind === "ticket" && unblocked(t) && parentNotOnHold(t) && notPersonOwned(t);
  return {
    parentNotOnHold,
    notPersonOwned,
    unblocked,
    noLiveLease,
    workableCore,
    workable: (t) => t.status === ST.ready && noLiveLease(t) && workableCore(t),
    queueable: (t) => t.kind === "ticket" && t.status === ST.ready && parentNotOnHold(t) && notPersonOwned(t),
    claimable: (t, opts) => {
      const from: string[] = opts.backlog ? [ST.backlog, ST.ready, ST.inProgress] : [ST.ready, ST.inProgress];
      return from.includes(t.status) && noLiveLease(t) && workableCore(t);
    },
  };
}

// The rows a reader keeps, by each of the rule's three entry points.
export async function workable<T extends WorkableRow>(r: Reader, rows: T[], now?: Date): Promise<T[]> {
  const rule = await workableRule(r, rows, now);
  return rows.filter(rule.workable);
}

export async function queueable<T extends WorkableRow>(r: Reader, rows: T[], now?: Date): Promise<T[]> {
  const rule = await workableRule(r, rows, now);
  return rows.filter(rule.queueable);
}

export async function claimable<T extends WorkableRow>(r: Reader, rows: T[], opts: { backlog: boolean }, now?: Date): Promise<T[]> {
  const rule = await workableRule(r, rows, now);
  return rows.filter((t) => rule.claimable(t, opts));
}
