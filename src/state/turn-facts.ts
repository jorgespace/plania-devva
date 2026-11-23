// PLA-I74-5: the facts turnOf reads, for every open ticket of one project, in a fixed number of queries: the tickets
// (with the workable rule's parts), live and queued runs, leases and whether the run behind one ended, open
// questions, blockers, and the board's stage of each ticket (projectEtapas, passed in).
import type { Db } from "../db/client.js";
import type { Actor, Agent, Project } from "../db/schema.js";
import { typedBlockerOpen } from "../mcp/blockers.js";
import { loadSettings, roleOf } from "../runner/limits.js";
import { isRunSession, sessionsOf } from "../runner/run-session.js";
import { serviceAgent } from "../runner/events.js";
import { readerOf } from "../store/port.js";
import { ST, SETTLED, isIn } from "./status.js";
import { turnOf, type TurnInput, type TurnOrNobody } from "./turn.js";
import { workableRule } from "./workable.js";

const TALLER_WORK = new Set(["code", "bug", "debt", "ops"]);
export const LIVE_RUN = ["starting", "running"] as const;

// What the board already knows of each ticket (src/api/etapa.ts ProjectTicket), by key.
export type BoardRow = { etapa: { etapa: string; qa: string | null; ci: string | null }; arranque: { summary: string } | null };

export type ItemTurn = { key: string; id: string; title: string; status: string; statusChangedAt: Date | null; turn: TurnOrNobody; worker: Agent | null };

export async function projectTurns(db: Db, p: Pick<Project, "id" | "slug" | "runsPaused">, board: Map<string, BoardRow>, now = new Date()): Promise<ItemTurn[]> {
  const r = readerOf(db);
  const open = (await r.find("tasks", { projectId: p.id, kind: "ticket" })).filter((t) => t.status !== ST.done && t.status !== ST.wontDo);
  if (open.length === 0) return [];
  const rule = await workableRule(r, open, now);
  const rows = open.map((t) => ({ ...t, workable: rule.workable(t), onHold: !rule.parentNotOnHold(t), personOwned: !rule.notPersonOwned(t) }));
  const ids = rows.map((t) => t.id);
  const byId = new Map(rows.map((t) => [t.id, t]));

  // Every run has its agent (the foreign key cascades), so a run without one is left out, as the join did.
  const projectRuns = await r.find("agentRuns", { projectId: p.id, status: ["queued", ...LIVE_RUN] });
  const slugOf = new Map((projectRuns.length ? await r.find("agents", { id: [...new Set(projectRuns.map((x) => x.agentId))] }) : []).map((a) => [a.id, a.slug]));
  const runs = projectRuns.filter((x) => slugOf.has(x.agentId)).map((x) => ({ id: x.id, status: x.status, taskKey: x.taskKey, startedAt: x.startedAt, agentId: x.agentId, slug: slugOf.get(x.agentId)! }));
  // Agents busy anywhere (a teammate shared across projects runs one thing at a time), and the sessions live runs write as.
  const busyRows = await r.find("agentRuns", { status: [...LIVE_RUN] });
  const busy = new Set(busyRows.map((x) => x.agentId));
  const liveSessions = new Set(busyRows.flatMap((x) => sessionsOf(x.id)));
  const asked = new Set((await r.find("questions", { projectId: p.id, answeredAt: null, taskId: ids })).map((q) => q.taskId));
  // The open typed blockers, oldest first.
  const isOpen = typedBlockerOpen(r, p.id, now);
  const typed: { task_id: string; type: string; spec: Record<string, unknown> }[] = [];
  for (const b of await r.find("blockers", { taskId: ids }, { orderBy: [{ column: "createdAt" }] })) {
    if (await isOpen(b)) typed.push({ task_id: b.taskId, type: b.type, spec: b.spec });
  }
  // The ticket steps each one waits on that have not landed (a Backlog step also waits on one In review), by phase
  // (none last), then key.
  const links = await r.find("taskBlockers", { taskId: ids });
  const blockerRows = new Map((links.length ? await r.find("tasks", { id: [...new Set(links.map((l) => l.blockerId))] }) : []).map((t) => [t.id, t]));
  const waits = links
    .flatMap((l) => {
      const b = blockerRows.get(l.blockerId);
      const w = byId.get(l.taskId);
      if (!b || !w) return [];
      return !isIn(SETTLED, b.status) || (w.status === ST.backlog && b.status === ST.inReview) ? [{ task_id: l.taskId, title: b.title, phase: b.phase, key: b.key }] : [];
    })
    .sort((a, b) => (a.phase ?? Number.MAX_SAFE_INTEGER) - (b.phase ?? Number.MAX_SAFE_INTEGER) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const ownerIds = [...new Set(rows.map((t) => t.ownerAgent).filter((x): x is string => !!x))];
  const owners = new Map((ownerIds.length ? await r.find("agents", { id: ownerIds }) : []).map((a) => [a.id, a]));
  const taller = await serviceAgent(db, "taller", p);
  const po = await serviceAgent(db, "product-owner", p);
  const paused = p.runsPaused || (await loadSettings(db)).companyPaused;

  const live = new Map<string, (typeof runs)[number]>();
  const queued = new Map<string, (typeof runs)[number]>();
  for (const x of runs) {
    if (!x.taskKey) continue;
    if ((LIVE_RUN as readonly string[]).includes(x.status)) live.set(x.taskKey, x);
    else if (!queued.has(x.taskKey)) queued.set(x.taskKey, x);
  }
  const typedBy = new Map<string, (typeof typed)[number]>();
  for (const b of typed) if (!typedBy.has(String(b.task_id))) typedBy.set(String(b.task_id), b);
  const waitBy = new Map<string, string>();
  for (const w of waits) if (!waitBy.has(String(w.task_id))) waitBy.set(String(w.task_id), String(w.title));

  return rows.flatMap((t): ItemTurn[] => {
    const ownerAgent = t.ownerAgent ? owners.get(t.ownerAgent) : undefined;
    const runnerOwner = ownerAgent && ownerAgent.kind !== "human" && ownerAgent.slug !== "ceo" && !!roleOf(ownerAgent) ? ownerAgent : null;
    const worker = runnerOwner ?? (TALLER_WORK.has(t.workType ?? "code") ? taller : po);
    const actor = t.owner as Actor | null;
    const leaseLive = !!actor && !!t.leaseUntil && t.leaseUntil.getTime() > now.getTime();
    const runner = isRunSession(actor?.session_id);
    const b = board.get(t.key);
    const tb = typedBy.get(t.id);
    const run = live.get(t.key);
    const q = queued.get(t.key);
    const input: TurnInput = {
      key: t.key,
      status: t.status,
      statusChangedAt: t.statusChangedAt ?? t.createdAt,
      paused,
      liveRun: run ? { id: run.id, agent: run.slug, since: run.startedAt } : null,
      queuedRun: q ? { id: q.id, agent: q.slug } : null,
      lease: leaseLive ? { agent: actor?.agent ?? null, runner, runnerEnded: runner && !liveSessions.has(actor!.session_id), since: t.claimedAt } : null,
      question: asked.has(t.id),
      couldNotStart: b?.arranque?.summary ?? null,
      onHold: !!t.onHold,
      personOwned: !!t.personOwned,
      workable: !!t.workable,
      waitsOnStep: waitBy.get(t.id) ?? null,
      typed: tb ? { type: String(tb.type), at: typeof tb.spec?.at === "string" ? tb.spec.at : null, text: typeof tb.spec?.text === "string" ? tb.spec.text : null } : null,
      etapa: b?.etapa.etapa ?? null,
      qa: b?.etapa.qa ?? null,
      ci: b?.etapa.ci ?? null,
      worker: worker?.slug ?? null,
      workerBusy: !!worker && busy.has(worker.id),
    };
    const turn = turnOf(input, now);
    return turn ? [{ key: t.key, id: t.id, title: t.title, status: t.status, statusChangedAt: input.statusChangedAt, turn, worker }] : [];
  });
}
