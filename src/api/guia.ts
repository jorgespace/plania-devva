// PLA-I2-16: the guide to a first delivery (GET /api/guia, cookie only, mounted in src/api/routes.ts). Every step is
// read from data, so it ticks itself; the screen turns this read into steps and words (ui/src/lib/primera-entrega.ts).
//   maquina   the newest machine check reading any page took (src/api/machine-check.ts): lista, falta, sin_revisar
//   proyecto  the first project made after first start (not Asistente's home), with its team
//   reanudar  the company and that project are both running
//   pedido    that project has a task (a request makes the product owner's ticket or idea)
//   plan      a plan from its product owner waits for «Sí, empiecen» (espera), or one was approved or needed none
//   entrega   a delivery waits for Aceptar (a ticket In review), or one was accepted anywhere (the guide goes away)
//   fallo     the project's newest run, when it could not start or found Claude signed out: the reason and the fix
// POST /api/guia/ejemplo makes the example project for someone with no repository at hand: no code, paused, its team.
import { Hono } from "hono";
import { withDb, type Db } from "../db/client.js";
import type { ThreadMessage } from "../db/schema.js";
import { loadSettings } from "../runner/limits.js";
import { createProjectFromTemplate } from "../runner/new-project.js";
import { failReason, startFailureOf } from "../runner/start-failures.js";
import { SIGNED_OUT } from "../runner/signed-out.js";
import { homeSlug } from "../runner/threads.js";
import { readerOf } from "../store/port.js";
import { notNull } from "../store/types.js";
import { arranqueOf } from "../../ui/src/lib/arranque.js";
import { EJEMPLO, type GuiaRead } from "../../ui/src/lib/primera-entrega.js";
import { latestMachineReading } from "./machine-check.js";
import type { MachineCheckReading } from "../../ui/src/lib/falta.js";

export type GuiaDeps = { machine?: () => MachineCheckReading | null; env?: NodeJS.ProcessEnv };

// jsonb's `?`: a key of an object, a string element of an array, or the string itself.
const hasKey = (v: unknown, k: string): boolean =>
  Array.isArray(v) ? v.includes(k) : v !== null && typeof v === "object" ? Object.prototype.hasOwnProperty.call(v, k) : v === k;

// action_state->>'action' in ('aceptar', 'fusionar') and not (action_state->'result' ? 'error'); a missing result is
// SQL null there, so it does not count.
const ACCEPTED = (m: Pick<ThreadMessage, "actionState">): boolean => {
  const state = m.actionState as { action?: unknown; result?: unknown } | null;
  if (!state || (state.action !== "aceptar" && state.action !== "fusionar") || state.result === undefined) return false;
  return !hasKey(state.result, "error");
};

/** True once the owner (or the project's own switch) accepted any delivery: the guide's job is done. */
export async function firstDeliveryAccepted(db: Db): Promise<boolean> {
  return (await readerOf(db).find("threadMessages", { actionState: notNull() })).some(ACCEPTED);
}

const showsFailure = (summary: string): boolean => !!startFailureOf(summary) || failReason(summary) === SIGNED_OUT;

export async function guiaRead(db: Db, deps: GuiaDeps = {}): Promise<GuiaRead> {
  const env = deps.env ?? process.env;
  const settings = await loadSettings(db);
  const reading = (deps.machine ?? latestMachineReading)();
  const accepted = await firstDeliveryAccepted(db);

  // The first project with a team, other than Asistente's home (first start makes it with no team).
  const r = readerOf(db);
  const staffed = new Set((await r.find("agents", { projectId: notNull() })).map((a) => a.projectId));
  const first = (await r.find("projects", {}, { orderBy: [{ column: "createdAt" }] })).find((x) => x.slug !== homeSlug(env) && staffed.has(x.id));
  const p = first ? { id: first.id, slug: first.slug, title: first.title, paused: first.runsPaused } : undefined;

  let pedido = false;
  let plan: GuiaRead["plan"] = "nada";
  let entrega: GuiaRead["entrega"] = accepted ? "aceptada" : "nada";
  let fallo: GuiaRead["fallo"] = null;
  if (p) {
    pedido = (await r.count("tasks", { projectId: p.id })) > 0;
    const threadIds = (await r.find("threads", { projectId: p.id })).map((th) => th.id);
    const plans = (threadIds.length ? await r.find("threadMessages", { threadId: threadIds, proposal: notNull() }) : [])
      .filter((m) => (m.proposal as { kind?: unknown } | null)?.kind === "plan")
      .map((m) => ({ proposal: m.proposal, state: m.actionState }));
    if (plans.some((m) => (m.state?.action as string | undefined) === "empezar" || (m.proposal && !m.proposal.needs_approval))) plan = "aprobado";
    else if (plans.some((m) => !m.state && m.proposal?.needs_approval)) plan = "espera";
    if (entrega !== "aceptada") {
      if ((await r.count("tasks", { projectId: p.id, status: "In review" })) > 0) entrega = "espera";
    }
    // A plan whose steps were made also means the owner said yes; a delivery means a plan went ahead.
    if (plan === "nada" && entrega !== "nada") plan = "aprobado";

    const team = (await r.find("agents", { projectId: p.id })).map((a) => a.id);
    const [last] = team.length
      ? await r.find("agentRuns", { agentId: team, status: ["ok", "fail", "stopped", "running", "starting", "queued"], queuedAt: notNull() }, { orderBy: [{ column: "queuedAt", desc: true }], limit: 1 })
      : [];
    const run = last ? { status: last.status, summary: last.summary, ticket: last.taskKey, at: last.endedAt } : undefined;
    const summary = run?.summary ?? "";
    if (run?.status === "fail" && showsFailure(summary)) {
      const w = arranqueOf(summary)!;
      fallo = { summary, ticket: run.ticket ?? null, at: run.at ? run.at.toISOString() : null, por: w.por, arregla: w.arregla };
    }
  }

  return {
    visible: !accepted,
    proyecto: p ? { slug: p.slug, title: p.title } : null,
    maquina: !reading ? "sin_revisar" : reading.ready ? "lista" : "falta",
    company_paused: settings.companyPaused,
    project_paused: p ? p.paused : true,
    pedido,
    plan,
    entrega,
    fallo,
    est_pct_per_run: settings.estPctPerRun,
  };
}

export function guiaRoutes(deps: GuiaDeps = {}) {
  const routes = new Hono();
  routes.get("/", async (c) => c.json(await withDb((db) => guiaRead(db, deps))));
  // The example: refused once a project exists, so a second click cannot make a second one.
  routes.post("/ejemplo", async (c) => {
    const out = await withDb(async (db) => {
      const read = await guiaRead(db, deps);
      if (read.proyecto) return { error: "PROJECT_EXISTS", status: 409 as const, slug: read.proyecto.slug };
      return createProjectFromTemplate(db, { name: EJEMPLO.name, goal: EJEMPLO.goal, no_code: true }, { ctx: undefined });
    });
    if ("error" in out) {
      const { status, ...rest } = out as { status: number } & Record<string, unknown>;
      return c.json(rest, status as 400 | 409);
    }
    return c.json(out, 201);
  });
  return routes;
}
