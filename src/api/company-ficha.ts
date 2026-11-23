// PLA-I47-1: what La ficha's tabs read for one project (Plan doc of PLA-IDEA13, answer 1).
//   GET /api/company/projects/:slug/ficha → {slug, counts, ideas[], prs[], docs[], designs[]}
//   ideas[]   open ideas, newest first: key, title, stage, waits (ideaWaits), updated_at, docs {Idea, Research, Design, Plan} ids
//   prs[]     the project's pull requests, newest first, at most 20
//   docs[]    the project's docs (task docs and project docs), newest first, at most 30, never the markdown
//   designs[] the lienzo links written in the Design docs of the project's ideas
// Read only; the owner's session like the rest of /api/company. projectDocRead serves one doc of one project.
import type { Db } from "../db/client.js";
import type { Task } from "../db/schema.js";
import { ToolError } from "../mcp/errors.js";
import { screenTz } from "../runner/limits.js";
import { ideaWaits } from "../mcp/ideas.js";
import { addDays, dayInTz } from "../mcp/progress.js";
import { readerOf } from "../store/port.js";
import { notNull } from "../store/types.js";
import { ideasWithFrames, unseenByIdea } from "./company-idea.js";
import { CONSTRUIR, factsOf, pedidoOf, type PedidoState, type PedidoStop } from "./company-pedidos.js";

export const FICHA_LIMITS = { ideas: 30, prs: 20, docs: 30, designs: 20 } as const;
// PLA-I64-6: Archivo reads every doc and PR (titles only), so the one opened is always the one clicked.
export const ARCHIVO_LIMITS = { ideas: 30, prs: 1000, docs: 2000, designs: 200 } as const;
const STAGE_DOC_TITLES = ["Idea", "Research", "Design", "Plan"] as const;
// A lienzo is a claude.ai artifact link (claude.ai/artifact/<id> or claude.ai/code/artifact/<uuid>).
const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/g;

const iso = (v: Date | null): string | null => (v == null ? null : v.toISOString());
// Text compared by code unit, as the store orders it.
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export type FichaIdea = {
  key: string;
  title: string;
  stage: string | null;
  waits: string | null;
  updated_at: string;
  docs: Record<(typeof STAGE_DOC_TITLES)[number], string | null>;
  // PLA-I61-3: the summary the PO wrote, the stops it passed (stage index) and what the owner has not opened.
  summary: string;
  unseen: number;
  // PLA-I64-1: the initiative it became (then it is not a row of its own), who asked (owner: a pedido), and for an
  // idea not promoted yet its stop and state as the tube reads them (src/api/company-pedidos.ts), shelf and question.
  promoted_to: string | null;
  origin: string | null;
  stop: PedidoStop | null;
  state: PedidoState | null;
  guardada: boolean;
  question: { id: string; text: string } | null;
  // PLA-62: when he last said «Constrúyelo» (the valve's clock), null when he never did.
  ordered_at: string | null;
};
// PLA-I61-2: an idea whose design lives in Plania (Artist's frames), for the Diseño tab.
export type FichaLienzo = { key: string; title: string; count: number; thumbs: string[]; unseen: number };
export type FichaPr = {
  number: number;
  title: string;
  url: string;
  state: string;
  ci_state: string | null;
  task_key: string | null;
  merged_at: string | null;
  head_branch: string | null;
};
export type FichaDoc = { id: string; title: string; task_key: string | null; updated_at: string };
export type FichaDesign = { idea_key: string; doc_id: string; url: string };
export type Ficha = {
  slug: string;
  counts: { ideas: number; prs: number; docs: number; designs: number };
  ideas: FichaIdea[];
  prs: FichaPr[];
  docs: FichaDoc[];
  designs: FichaDesign[];
  lienzos: FichaLienzo[];
  // PLA-I64-1: every idea of the project that became an initiative (any status), so an initiative carries its idea.
  promoted: { idea: string; initiative: string }[];
};

export function artifactLinks(markdown: string): string[] {
  return [...new Set(markdown.match(ARTIFACT_URL) ?? [])];
}

async function projectId(db: Db, slug: string): Promise<string> {
  const p = slug == null ? undefined : await readerOf(db).get("projects", { slug });
  if (!p) throw new ToolError("PROJECT_NOT_FOUND", { project: slug });
  return p.id;
}

// The keys of the tasks a set of rows points at (for a left join on tasks).
async function keysOf(db: Db, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  const ts = wanted.length ? await readerOf(db).find("tasks", { id: wanted }) : [];
  return new Map(ts.map((t) => [t.id, t.key]));
}

export async function fichaRead(db: Db, slug: string, opts: { all?: boolean } = {}): Promise<Ficha> {
  const id = await projectId(db, slug);
  const r = readerOf(db);
  const L = opts.all ? ARCHIVO_LIMITS : FICHA_LIMITS;

  // Not promoted first, then newest, then key.
  const ideaRows = (await r.find("tasks", { projectId: id, kind: "idea", status: "Open" }))
    .sort((a, b) => Number(a.promotedTo !== null) - Number(b.promotedTo !== null) || b.updatedAt.getTime() - a.updatedAt.getTime() || byText(a.key, b.key))
    .slice(0, L.ideas);
  const ideaCount = await r.count("tasks", { projectId: id, kind: "idea", status: "Open" });
  const ideaIds = ideaRows.map((t) => t.id);
  const stageDocs = ideaIds.length ? await r.find("docs", { taskId: ideaIds, title: [...STAGE_DOC_TITLES] }) : [];
  const waits = ideaIds.length ? await ideaWaits(db, id) : new Map<string, string>();
  const unseen = await unseenByIdea(db, slug, ideaRows.map((t) => t.key));
  // PLA-I64-1: the tube's stop and state for every open idea not promoted yet (any origin).
  const looseTasks = ideaRows.filter((t) => !t.promotedTo);
  const loose = looseTasks.map((t) => t.id);
  const facts = looseTasks.length ? await factsOf(db, id, looseTasks) : null;
  const tube = new Map<string, Awaited<ReturnType<typeof pedidoOf>>>();
  for (const t of looseTasks) tube.set(t.key, await pedidoOf(db, id, t, facts!));
  // The newest «Constrúyelo» of each (oldest first, so the last one written stays).
  const orderedAt = new Map<string, string | null>();
  for (const e of loose.length ? await r.find("events", { taskId: loose, type: CONSTRUIR }, { orderBy: [{ column: "createdAt" }] }) : []) orderedAt.set(e.taskId!, iso(e.createdAt));
  const promotedRows = (await r.find("tasks", { projectId: id, kind: "idea", promotedTo: notNull() })).sort((a, b) => byText(a.key, b.key));
  const ideas: FichaIdea[] = ideaRows.map((t) => {
    const mine = stageDocs.filter((d) => d.taskId === t.id);
    const docs = Object.fromEntries(
      STAGE_DOC_TITLES.map((title) => {
        const found = mine.find((d) => d.title === title);
        return [title, found ? found.id : null];
      }),
    ) as FichaIdea["docs"];
    return {
      key: t.key,
      title: t.title,
      stage: t.stage ?? null,
      waits: waits.get(t.key) ?? null,
      updated_at: t.updatedAt.toISOString(),
      docs,
      summary: t.summary ?? "",
      unseen: unseen[t.key] ?? 0,
      promoted_to: t.promotedTo ?? null,
      origin: t.origin ?? null,
      stop: tube.get(t.key)?.stop ?? null,
      state: tube.get(t.key)?.state ?? null,
      guardada: tube.get(t.key)?.guardada ?? false,
      question: tube.get(t.key)?.question ?? null,
      ordered_at: orderedAt.get(t.id) ?? null,
    };
  });

  // Newest first by GitHub's own clock when known, else the row's.
  const allPrs = (await r.find("pullRequests", { projectId: id })).sort(
    (a, b) => (b.ghUpdatedAt ?? b.updatedAt).getTime() - (a.ghUpdatedAt ?? a.updatedAt).getTime() || b.number - a.number,
  );
  const prRows = allPrs.slice(0, L.prs);
  const prKeys = await keysOf(db, prRows.map((pr) => pr.taskId));
  const prs: FichaPr[] = prRows.map((pr) => ({
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    ci_state: pr.ciState ?? null,
    task_key: (pr.taskId && prKeys.get(pr.taskId)) || null,
    merged_at: iso(pr.mergedAt),
    head_branch: pr.headBranch ?? null,
  }));

  const allDocs = await r.find("docs", { projectId: id }, { orderBy: [{ column: "updatedAt", desc: true }, { column: "title" }] });
  const docRows = allDocs.slice(0, L.docs);
  const docKeys = await keysOf(db, docRows.map((d) => d.taskId));
  const docs: FichaDoc[] = docRows.map((d) => ({
    id: d.id,
    title: d.title,
    task_key: (d.taskId && docKeys.get(d.taskId)) || null,
    updated_at: d.updatedAt.toISOString(),
  }));

  // Every idea of the project (not only open ones): a lienzo stays useful after its idea is promoted.
  const designDocs = await r.find("docs", { projectId: id, title: "Design" });
  const designIdeas = designDocs.length ? await r.find("tasks", { id: [...new Set(designDocs.map((d) => d.taskId).filter((x): x is string => !!x))], kind: "idea" }) : [];
  const ideaKey = new Map(designIdeas.map((t) => [t.id, t.key]));
  const designRows = designDocs
    .filter((d) => d.taskId && ideaKey.has(d.taskId))
    .map((d) => ({ id: d.id, markdown: d.markdown, at: d.updatedAt, key: ideaKey.get(d.taskId!)! }))
    .sort((a, b) => b.at.getTime() - a.at.getTime() || byText(a.key, b.key));
  const allDesigns: FichaDesign[] = designRows.flatMap((d) => artifactLinks(d.markdown).map((url) => ({ idea_key: d.key, doc_id: d.id, url })));

  // PLA-I61-2: ideas carrying Artist's frames count as a design too (once per idea, with or without a link).
  const framed = await ideasWithFrames(db, id, slug);
  const lienzos: FichaLienzo[] = framed.map((f) => ({ ...f, unseen: unseen[f.key] ?? 0 }));
  const linkOnly = new Set(allDesigns.map((d) => d.idea_key).filter((k) => !framed.some((f) => f.key === k)));
  return {
    slug,
    counts: { ideas: ideaCount, prs: allPrs.length, docs: allDocs.length, designs: lienzos.length + linkOnly.size },
    lienzos,
    ideas,
    prs,
    docs,
    designs: allDesigns.slice(0, L.designs),
    promoted: promotedRows.map((t) => ({ idea: t.key, initiative: t.promotedTo! })),
  };
}

// One doc of one project, task doc or project doc, read-only (La ficha's doc detail).
export async function projectDocRead(db: Db, slug: string, docId: string): Promise<{ id: string; title: string; version: number; markdown: string; task_key: string | null }> {
  const r = readerOf(db);
  const doc = docId == null ? undefined : await r.get("docs", { id: docId });
  const p = doc ? await r.get("projects", { id: doc.projectId }) : undefined;
  if (!doc || !p || p.slug !== slug) throw new ToolError("DOC_NOT_FOUND", { doc_id: docId });
  const t = doc.taskId ? await r.get("tasks", { id: doc.taskId }) : undefined;
  return { id: doc.id, title: doc.title, version: doc.version, markdown: doc.markdown, task_key: t?.key ?? null };
}

// When a task landed: resolved_at, else its last status change, else its last update.
const landedAt = (t: Task): Date => t.resolvedAt ?? t.statusChangedAt ?? t.updatedAt;

// PLA-I64-3: el pulso, steps done per day over the last `days` days (default 14) in the screen's time zone, oldest
// first, every day present (0 when nothing landed). A step counts on the day it landed (Merged, Released or Done:
// resolved_at, else its last status change), once. Initiatives and ideas are not steps.
export type Pulso = { days: { day: string; n: number }[]; total: number; tz: string };
export async function pulsoRead(db: Db, slug: string, opts: { days?: number; tz?: string; now?: Date } = {}): Promise<Pulso> {
  const id = await projectId(db, slug);
  const days = Math.min(Math.max(opts.days ?? 14, 1), 90);
  const tz = opts.tz ?? screenTz();
  const now = opts.now ?? new Date();
  const today = dayInTz(now, tz);
  const landed = new Map<string, number>();
  for (const t of await readerOf(db).find("tasks", { projectId: id, kind: "ticket", status: ["Merged", "Released", "Done"] })) {
    const d = dayInTz(landedAt(t), tz);
    landed.set(d, (landed.get(d) ?? 0) + 1);
  }
  const list = Array.from({ length: days }, (_, i) => addDays(today, i - (days - 1))).map((day) => ({ day, n: landed.get(day) ?? 0 }));
  return { days: list, total: list.reduce((a, d) => a + d.n, 0), tz };
}

// PLA-I64-6: Hecho, what landed day by day. A window of `days` days ending on `until` (default today, screen time
// zone): the steps that landed each day (Merged, Released or Done; at most HECHO_TOP titles per day, the rest
// counted), the initiatives closed that day with their step count and the idea they were, and whether anything
// landed before the window (Ver antes).
export const HECHO_TOP = 6;
export type HechoDay = { day: string; n: number; steps: { key: string; title: string; parent: string | null }[]; more: number; initiatives: { key: string; title: string }[]; prs: number };
export type Hecho = {
  from: string;
  to: string;
  tz: string;
  total: number;
  days: HechoDay[];
  initiatives: { key: string; title: string; done_at: string; steps: number; idea: string | null; origin: string | null }[];
  before: string | null;
};
export async function hechoRead(db: Db, slug: string, opts: { until?: string; days?: number; tz?: string; now?: Date } = {}): Promise<Hecho> {
  const id = await projectId(db, slug);
  const r = readerOf(db);
  const tz = opts.tz ?? screenTz();
  const days = Math.min(Math.max(opts.days ?? 14, 1), 60);
  const now = opts.now ?? new Date();
  const to = opts.until ?? dayInTz(now, tz);
  const from = addDays(to, -(days - 1));
  const landedOn = (t: Task) => dayInTz(landedAt(t), tz);
  const inWindow = (t: Task) => landedOn(t) >= from && landedOn(t) <= to;
  // Newest landing first, then key.
  const newest = (a: Task, b: Task) => landedAt(b).getTime() - landedAt(a).getTime() || byText(a.key, b.key);
  const steps = (await r.find("tasks", { projectId: id, kind: "ticket", status: ["Merged", "Released", "Done"] })).filter(inWindow).sort(newest);
  const parentKeys = await keysOf(db, steps.map((t) => t.parentId));
  const closed = (await r.find("tasks", { projectId: id, kind: "initiative", status: "Done" })).filter(inWindow).sort(newest);
  // Each closed initiative's steps (Won't do left out) and the idea it was (the first one found, like limit 1).
  const children = closed.length ? (await r.find("tasks", { parentId: closed.map((t) => t.id), kind: "ticket" })).filter((c) => c.status !== "Won't do") : [];
  const ideasOf = closed.length ? await r.find("tasks", { projectId: id, kind: "idea", promotedTo: closed.map((t) => t.key) }) : [];
  const inis = closed.map((t) => {
    const idea = ideasOf.find((i) => i.promotedTo === t.key);
    return { day: landedOn(t), key: t.key, title: t.title, at: landedAt(t), steps: children.filter((c) => c.parentId === t.id).length, idea: idea?.key ?? null, origin: idea?.origin ?? null };
  });
  const prs = new Map<string, number>();
  for (const pr of await r.find("pullRequests", { projectId: id, mergedAt: notNull() })) {
    const d = dayInTz(pr.mergedAt!, tz);
    if (d >= from && d <= to) prs.set(d, (prs.get(d) ?? 0) + 1);
  }
  // The newest day a step landed before the window.
  const earlier = (await r.find("tasks", { projectId: id, kind: "ticket", status: ["Merged", "Released", "Done"] })).map(landedOn).filter((d) => d < from);
  const prev = earlier.length ? earlier.reduce((a, b) => (b > a ? b : a)) : null;
  const byDay = new Map<string, HechoDay>();
  const dayOf = (d: string) => byDay.get(d) ?? (byDay.set(d, { day: d, n: 0, steps: [], more: 0, initiatives: [], prs: 0 }), byDay.get(d)!);
  for (const t of steps) {
    const d = dayOf(landedOn(t));
    d.n++;
    if (d.steps.length < HECHO_TOP) d.steps.push({ key: t.key, title: t.title, parent: (t.parentId && parentKeys.get(t.parentId)) || null });
    else d.more++;
  }
  for (const i of inis) dayOf(i.day).initiatives.push({ key: i.key, title: i.title });
  for (const [day, n] of prs) dayOf(day).prs = n;
  return {
    from,
    to,
    tz,
    total: steps.length,
    days: [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)),
    initiatives: inis.map((i) => ({ key: i.key, title: i.title, done_at: iso(i.at)!, steps: i.steps, idea: i.idea, origin: i.origin })),
    before: prev,
  };
}
