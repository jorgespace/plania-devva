// PLA-I71-3: seats as the owner manages them from Equipo. The role catalog is data (puestos, 0075): the factory roles
// seeded from TEMPLATE_ROWS and the owner's own roles (a title, one line, a base factory role whose prompt the seat
// runs on). Every change here is the owner's (the screen's session); runs only propose a seat (propose_seat, the PO's).
//   moveSeat      a new manager: the owner (the company's ceo seat) or a teammate; a loop is MANAGER_LOOP.
//   pauseSeat     paused_at set or cleared; admission holds a paused seat's runs (runner.ts, held seat_paused).
//   retireSeat    status retired (its runs, lessons and skills stay); its reports move up to its manager.
//   addSeat       from the catalog or an owner role; it arrives paused; at most eight seats (TEAM_FULL).
//   proposeSeat / decideProposal   the PO's proposal, then the owner's yes (a paused seat) or no.
import type { Db } from "../db/client.js";
import type { Agent, Project, PuestoRow, SeatProposal } from "../db/schema.js";
import { ToolError } from "../mcp/errors.js";
import type { Q } from "../mcp/tx.js";
import { readerOf } from "../store/port.js";
import { ne } from "../store/types.js";
import { isRunnerRole, roleOf, writeVia } from "./limits.js";
import { RUNNER_CONFIG, TEAM_TEMPLATES, TEMPLATE_ROWS, ensureMember, isTeamTemplate, teamOf, teamSlug, type TeamTemplate } from "./team.js";

export const TEAM_MAX = 8;
const COMPANY = "ceo";

export type PuestoView = { slug: string; title: string; line: string; origin: "factory" | "owner"; base: string; taken: boolean };
export type ProposalView = { id: string; role: string; title: string; reason: string; proposed_by: string; state: SeatProposal["state"]; at: string };

async function projectOf(db: Q, slug: string): Promise<Project> {
  const p = await readerOf(db).get("projects", { slug });
  if (!p) throw new ToolError("PROJECT_NOT_FOUND", { project: slug });
  return p;
}
async function memberOf(db: Q, p: Project, agent: string): Promise<Agent> {
  const a = await readerOf(db).get("agents", { slug: agent, projectId: p.id, status: ne("retired") });
  if (!a) throw new ToolError("AGENT_NOT_FOUND", { agent });
  return a;
}
// One team change at a time per project (adds counting to eight, moves checking for a loop): each change reads and
// writes inside one store write, and the store serializes writes, so two clicks at the same moment cannot both pass
// the check.

const ceoId = async (db: Q): Promise<string | null> => (await readerOf(db).get("agents", { slug: COMPANY }))?.id ?? null;

/** The catalog: factory roles (the table's rows, else the code's list before 0075 ran) and the owner's. taken: on this
 *  project's team already. */
export async function catalog(db: Q, project: string): Promise<PuestoView[]> {
  const p = await projectOf(db, project);
  const team = await teamOf(db, p.id);
  const rows: PuestoRow[] = await readerOf(db).find("puestos", {}, { orderBy: [{ column: "createdAt" }] }).catch(() => []);
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const factory = TEAM_TEMPLATES.map((t) => ({ slug: t, title: bySlug.get(t)?.title ?? TEMPLATE_ROWS[t].title, line: bySlug.get(t)?.line ?? "", origin: "factory" as const, base: t }));
  const own = rows.filter((r) => r.origin === "owner").map((r) => ({ slug: r.slug, title: r.title, line: r.line, origin: "owner" as const, base: r.promptRef }));
  const takenSlugs = new Set(team.map((a) => (a.role && !isTeamTemplate(a.role) && !isRunnerRole(a.role) ? a.role : (a.roleTemplate ?? a.role))));
  return [...factory, ...own].map((x) => ({ ...x, taken: takenSlugs.has(x.slug) }));
}

const slugify = (title: string) =>
  title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30) || "puesto";

/** A role of the owner's own: two lines of text on a factory role's prompt. */
export async function createPuesto(db: Q, input: { title: string; line: string; base: string }): Promise<PuestoView> {
  const title = input.title.trim();
  const line = input.line.trim();
  if (title.length < 1 || title.length > 60) throw new ToolError("PUESTO_INVALID", { field: "title" });
  if (line.length > 200) throw new ToolError("PUESTO_INVALID", { field: "line" });
  if (!isTeamTemplate(input.base)) throw new ToolError("PUESTO_INVALID", { field: "base" });
  let slug = slugify(title);
  if (!/^[a-z]/.test(slug)) slug = `p-${slug}`;
  if ((TEAM_TEMPLATES as readonly string[]).includes(slug) || isRunnerRole(slug)) throw new ToolError("SEAT_TAKEN", { role: slug });
  const made = await writeVia(db, async (uow) => ((await uow.get("puestos", { slug })) ? null : uow.insert("puestos", { slug, title, line, origin: "owner", promptRef: input.base })));
  if (!made) throw new ToolError("SEAT_TAKEN", { role: slug });
  return { slug, title, line, origin: "owner", base: input.base, taken: false };
}

/** PLA-142: deletes a role of the owner's own that no live seat holds. Retired seats keep their history. */
export async function deletePuesto(db: Db, slug: string): Promise<{ deleted: string }> {
  return writeVia(db, async (uow) => {
    const own = await uow.get("puestos", { slug, origin: "owner" });
    if (!own) throw new ToolError("PUESTO_NOT_FOUND", { slug });
    const live = await uow.find("agents", { role: slug, status: ne("retired") });
    if (live.length) throw new ToolError("PUESTO_IN_USE", { seats: live.map((a) => a.slug) });
    await uow.delete("puestos", { slug: own.slug });
    return { deleted: slug };
  });
}

/** One seat on the team, from the catalog, arriving paused. Its manager is the PO (the owner for a PO). */
export async function addSeat(db: Db, project: string, role: string, opts: { fromTeam?: string | null; reportsTo?: string | null; paused?: boolean } = {}): Promise<Agent> {
  return writeVia(db, async (uow) => {
    const tx = uow.sql;
    const p = await projectOf(tx, project);
    const team = await teamOf(tx, p.id);
    if (team.length >= TEAM_MAX) throw new ToolError("TEAM_FULL", { max: TEAM_MAX });
    const po = team.find((a) => a.roleTemplate === "product-owner");
    const paused = opts.paused === false ? null : uow.now;
    if (isTeamTemplate(role)) {
      const slug = teamSlug(role, p.slug);
      const old = await uow.get("agents", { slug });
      if (old && old.status !== "retired") throw new ToolError("SEAT_TAKEN", { role });
      // A retired seat of that role comes back (its history stays its own).
      if (old) {
        const [back] = await uow.update("agents", { id: old.id }, { status: "idle", projectId: p.id, reportsTo: role === "product-owner" ? await ceoId(tx) : (po?.id ?? null), pausedAt: paused, fromTeam: opts.fromTeam ?? null, updatedAt: uow.now });
        return back!;
      }
      const made = await ensureMember(tx, p, role as TeamTemplate, { reportsTo: opts.reportsTo ?? (role === "product-owner" ? COMPANY : (po?.slug ?? COMPANY)) });
      const [set] = await uow.update("agents", { id: made.agent.id }, { pausedAt: paused, fromTeam: opts.fromTeam ?? null });
      return set!;
    }
    const own = await uow.get("puestos", { slug: role, origin: "owner" });
    if (!own) throw new ToolError("PUESTO_INVALID", { field: "role" });
    const slug = `${own.slug}-${p.slug}`.slice(0, 60);
    const old = await uow.get("agents", { slug });
    if (old && old.status !== "retired") throw new ToolError("SEAT_TAKEN", { role });
    const base = own.promptRef as TeamTemplate;
    const boss = opts.reportsTo ? (await uow.get("agents", { slug: opts.reportsTo }))?.id : po?.id;
    const values = {
      slug,
      name: `${own.title} ${p.title || p.slug}`.slice(0, 60),
      role: own.slug,
      title: own.title,
      kind: "bot",
      capabilities: TEMPLATE_ROWS[base].capabilities(p.slug),
      note: own.line,
      status: "idle",
      adapter: RUNNER_CONFIG.adapter,
      adapterConfig: RUNNER_CONFIG.adapterConfig,
      projectId: p.id,
      roleTemplate: base,
      reportsTo: boss ?? null,
      // The owner's line travels with every run, after the base role's prompt.
      manner: own.line || null,
      mannerUpdatedAt: own.line ? uow.now : null,
      pausedAt: paused,
      fromTeam: opts.fromTeam ?? null,
    };
    if (old) {
      const [back] = await uow.update("agents", { id: old.id }, { ...values, updatedAt: uow.now });
      return back!;
    }
    return uow.insert("agents", values);
  });
}

/** The chain of managers above a seat (by id), stopping at the top or a loop. */
async function chainAbove(db: Q, id: string | null): Promise<string[]> {
  const out: string[] = [];
  let at = id;
  while (at && !out.includes(at) && out.length < 50) {
    out.push(at);
    const row = await readerOf(db).get("agents", { id: at });
    at = row?.reportsTo ?? null;
  }
  return out;
}

/** The seats that would make a loop if made this seat's manager: itself and everyone below it. */
export async function belowOf(db: Q, project: string, agent: string): Promise<string[]> {
  const p = await projectOf(db, project);
  const team = await teamOf(db, p.id);
  const a = team.find((x) => x.slug === agent);
  if (!a) throw new ToolError("AGENT_NOT_FOUND", { agent });
  const below = new Set([a.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const x of team) if (x.reportsTo && below.has(x.reportsTo) && !below.has(x.id)) (below.add(x.id), (grew = true));
  }
  return team.filter((x) => below.has(x.id)).map((x) => x.slug);
}

/** to: a teammate's slug, or null for the owner (the company's ceo seat). */
export async function moveSeat(db: Db, project: string, agent: string, to: string | null): Promise<void> {
  await writeVia(db, async (uow) => {
    const tx = uow.sql;
    const p = await projectOf(tx, project);
    const a = await memberOf(tx, p, agent);
    let boss: string | null;
    if (to === null) boss = await ceoId(tx);
    else {
      const m = await uow.get("agents", { slug: to, projectId: p.id, status: ne("retired") });
      if (!m) throw new ToolError("MANAGER_NOT_ON_TEAM", { reports_to: to });
      const chain = await chainAbove(tx, m.id);
      if (m.id === a.id || chain.includes(a.id)) throw new ToolError("MANAGER_LOOP", { chain: [to, ...(await Promise.all(chain.slice(1).map(async (id) => (await uow.get("agents", { id }))?.slug)))].filter(Boolean) });
      boss = m.id;
    }
    await uow.update("agents", { id: a.id }, { reportsTo: boss, updatedAt: uow.now });
  });
}

export async function pauseSeat(db: Db, project: string, agent: string, paused: boolean): Promise<void> {
  const p = await projectOf(db, project);
  const a = await memberOf(db, p, agent);
  await writeVia(db, (uow) => uow.update("agents", { id: a.id }, { pausedAt: paused ? (a.pausedAt ?? uow.now) : null, updatedAt: uow.now }));
}

/** Retired: off the chart and the runner; its runs, lessons and skills stay. Its reports move up to its manager. */
export async function retireSeat(db: Db, project: string, agent: string): Promise<{ moved: string[] }> {
  return writeVia(db, async (uow) => {
    const tx = uow.sql;
    const p = await projectOf(tx, project);
    const a = await memberOf(tx, p, agent);
    if (roleOf(a) === "product-owner") throw new ToolError("SEAT_REQUIRED", { agent });
    const reports = await uow.find("agents", { reportsTo: a.id, status: ne("retired") });
    if (reports.length) await uow.update("agents", { reportsTo: a.id, status: ne("retired") }, { reportsTo: a.reportsTo, updatedAt: uow.now });
    await uow.update("agents", { id: a.id }, { status: "retired", pausedAt: null, updatedAt: uow.now });
    return { moved: reports.map((r) => r.slug) };
  });
}

// ---- proposals

const viewOf = (r: SeatProposal, cat: PuestoView[]): ProposalView => ({ id: r.id, role: r.role, title: cat.find((c) => c.slug === r.role)?.title ?? r.role, reason: r.reason, proposed_by: r.proposedBy, state: r.state, at: r.createdAt.toISOString() });

export async function proposalsOf(db: Q, project: string): Promise<ProposalView[]> {
  const p = await projectOf(db, project);
  const cat = await catalog(db, project);
  const rows = await readerOf(db).find("seatProposals", { projectId: p.id, state: "proposed" }, { orderBy: [{ column: "createdAt" }] });
  return rows.map((r) => viewOf(r, cat));
}

/** propose_seat: the project's PO (by its roster slug) proposes a role with a reason. One open proposal per role. */
export async function proposeSeat(db: Q, input: { project: string; role: string; reason: string }, by: Agent | null): Promise<ProposalView> {
  const p = await projectOf(db, input.project);
  if (!by || roleOf(by) !== "product-owner" || by.projectId !== p.id) throw new ToolError("SEAT_PROPOSAL_NOT_PO", { project: input.project });
  const cat = await catalog(db, input.project);
  const role = input.role.trim();
  const known = cat.find((c) => c.slug === role);
  if (!known) throw new ToolError("PUESTO_INVALID", { field: "role", known: cat.map((c) => c.slug) });
  if (known.taken) throw new ToolError("SEAT_TAKEN", { role });
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 600) throw new ToolError("PUESTO_INVALID", { field: "reason" });
  // The open one is looked for inside the write, so two proposals of one role at once stay one.
  const made = await writeVia(db, async (uow) => (await uow.get("seatProposals", { projectId: p.id, role, state: "proposed" })) ?? uow.insert("seatProposals", { projectId: p.id, role, reason, proposedBy: by.slug }), p.id);
  return viewOf(made, cat);
}

/** The owner's yes (the seat arrives paused) or no. */
export async function decideProposal(db: Db, project: string, id: string, accept: boolean): Promise<{ state: "accepted" | "declined"; agent: string | null }> {
  const p = await projectOf(db, project);
  const r = await readerOf(db).get("seatProposals", { id, projectId: p.id });
  if (!r) throw new ToolError("PROPOSAL_NOT_FOUND", { id });
  // Claim it first: of two answers at the same moment only one moves it out of «proposed».
  const [claimed] = await writeVia(db, (uow) => uow.update("seatProposals", { id, state: "proposed" }, { state: accept ? "accepted" : "declined", decidedAt: uow.now }), p.id);
  if (!claimed) throw new ToolError("PROPOSAL_DECIDED", { state: r.state === "proposed" ? "accepted" : r.state });
  if (!accept) return { state: "declined", agent: null };
  try {
    const made = await addSeat(db, project, r.role);
    await writeVia(db, (uow) => uow.update("seatProposals", { id }, { agentId: made.id }), p.id);
    return { state: "accepted", agent: made.slug };
  } catch (e) {
    // No room (or the role was taken meanwhile): the proposal waits again.
    await writeVia(db, (uow) => uow.update("seatProposals", { id }, { state: "proposed", decidedAt: null }), p.id);
    throw e;
  }
}

