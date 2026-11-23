// PLA-I49-6: an idea card's five fates, from the brief (POST /api/brief/act with an idea id, d|<app>|<hash>):
//   keep      the idea becomes a Plania idea (kind idea, Open, stage idea) with its `Idea` doc. 0 tokens.
//   discard   one tap and a reason chip. Stored in brief_actions; when the idea is already a Plania record it closes
//             as Won't do with that reason. Pass B reads the last 60 days of discards and does not propose them again.
//   research  keep, then stage research: the event hook wakes the project's Research.
//   sketch    keep, then a Ready ticket "Sketch: <title>" for the project's Artist and its wake. The idea's stage does
//             not move: the full Design stage still follows Research.
//   plan      Give to PO: Send to Plania (sendToPlania), as before. PLA-I50 makes the PO choose the shape.
// An idea acted on keeps its Plania key in the action's result, so the same card twice makes one record.
import { z } from "zod";
import type { Db } from "../db/client.js";
import type { BriefAction, MorningBrief } from "../db/schema.js";
import { attachDoc } from "../mcp/docs.js";
import { ToolError } from "../mcp/errors.js";
import { webCtx } from "../mcp/tx.js";
import { createTask, setTask } from "../mcp/writes.js";
import { queueWake, serviceAgent } from "../runner/events.js";
import { homeSlug } from "../runner/threads.js";
import { readerOf } from "../store/port.js";
import { gte } from "../store/types.js";
import { PlanError, sendToPlania } from "./plan.js";
import { CROSS, type Idea } from "./types.js";
import { defineWords, ownerIn, say } from "../words.js";
import type { Language } from "../language.js";

export const IDEA_ACTIONS = ["keep", "discard", "research", "sketch", "plan"] as const;
export type IdeaAction = (typeof IDEA_ACTIONS)[number];
export const DISCARD_REASONS = ["not_now", "not_for_product", "exists", "too_big", "costs_money", "other"] as const;
export const DISCARD_DAYS = 60;

// PLA-I2-10: what an idea's fate writes and says, in the brief's language; the Spanish is unchanged.
export const IDEA_WORDS = defineWords({
  es: {
    reasons: { not_now: "ahora no", not_for_product: "no es para este producto", exists: "ya existe", too_big: "muy grande", costs_money: "cuesta dinero", other: "otra razón" } as Record<string, string>,
    whoFor: (source: string) => `Los usuarios de ${source}.`,
    keptFrom: "Guardada desde el brief de la mañana.",
    kept: (key: string) => `Guardada en Plania: ${key}`,
    discardReason: (reason: string, note: string) => `Descartada desde el brief: ${reason}${note ? ` (${note})` : ""}`,
    discarded: (words: string) => `Descartada: ${words}`,
    toResearch: (key: string) => `A Research: ${key}`,
    noArtist: "Este proyecto no tiene Artist.",
    sketchAsk: (owner: string, key: string, title: string) => `Pedido ${owner} desde el brief de la mañana: un boceto de la idea ${key} ("${title}").`,
    sketchWhat: (key: string) =>
      `Una pantalla y sus estados principales (vacío, error, cargando), en un canvas o artifact. Pon el enlace en un doc titulado \`Sketch\` en la idea ${key}. El boceto no mueve la etapa de la idea: el Diseño completo sigue después de Research.`,
    sketchCheck: (key: string) => `El doc Sketch en ${key} tiene el enlace al boceto`,
    toArtist: (key: string) => `A Artist: ${key}`,
    toPo: "Al PO para que la planee",
  },
  en: {
    reasons: { not_now: "not now", not_for_product: "not for this product", exists: "already exists", too_big: "too big", costs_money: "costs money", other: "other" } as Record<string, string>,
    whoFor: (source: string) => `The people who use ${source}.`,
    keptFrom: "Kept from the morning brief.",
    kept: (key: string) => `Kept in Plania: ${key}`,
    discardReason: (reason: string, note: string) => `Discarded from the brief: ${reason}${note ? ` (${note})` : ""}`,
    discarded: (words: string) => `Discarded: ${words}`,
    toResearch: (key: string) => `To Research: ${key}`,
    noArtist: "This project has no Artist.",
    sketchAsk: (owner: string, key: string, title: string) => `Asked by ${owner} from the morning brief: a sketch of the idea ${key} ("${title}").`,
    sketchWhat: (key: string) =>
      `One screen and its main states (empty, error, loading), in a canvas or artifact. Put the link in a doc titled \`Sketch\` on the idea ${key}. The sketch does not move the idea's stage: the full Design stage still follows Research.`,
    sketchCheck: (key: string) => `The Sketch doc on ${key} has the link to the sketch`,
    toArtist: (key: string) => `To Artist: ${key}`,
    toPo: "To the PO to plan it",
  },
});
const ideaLang = (lang: string): Language => (lang === "es" ? "es" : "en");
/** How many briefs an idea nobody acted on is shown in before it is dropped. */
export const IDEA_SEEN_MAX = 3;

export const IDEA_INPUT: Record<IdeaAction, z.ZodType<Record<string, unknown>>> = {
  keep: z.object({}).strict(),
  discard: z.object({ reason: z.enum(DISCARD_REASONS), note: z.string().trim().max(300).optional() }).strict(),
  research: z.object({}).strict(),
  sketch: z.object({}).strict(),
  plan: z.object({}).strict(),
};
export const IDEA_LEVEL: Record<IdeaAction, "instant" | "wake"> = { keep: "instant", discard: "instant", research: "wake", sketch: "wake", plan: "wake" };

const ctx = (tool: string) => ({ ...webCtx, tool: `screen.brief_${tool}` });
const isIdeaId = (id: string) => id.startsWith("d|");
export { isIdeaId };

/** An action that went through (outcome status done). */
export const actionDone = (a: Pick<BriefAction, "outcome">): boolean => a.outcome?.status === "done";

/** The project an idea goes to: its app, or the home project for a cross idea. */
export function ideaProject(idea: Pick<Idea, "app">, env: NodeJS.ProcessEnv = process.env): string {
  return idea.app === CROSS ? homeSlug(env) : idea.app;
}

export function ideaDoc(idea: Pick<Idea, "title" | "why" | "source" | "flags">, lang: string): string {
  const w = say(IDEA_WORDS, ideaLang(lang));
  return [
    `# Idea: ${idea.title}`,
    "",
    `## Problem`,
    idea.why,
    "",
    `## Who it is for`,
    w.whoFor(idea.source),
    "",
    `## Why now`,
    idea.why,
    ...(idea.flags?.length ? ["", `Flags: ${idea.flags.join(", ")}`] : []),
    "",
    w.keptFrom,
  ].join("\n");
}

/** The Plania idea a card already became (an earlier keep, research or sketch), or an Open idea with its title. */
export async function ideaRecord(db: Db, idea: Pick<Idea, "id" | "title" | "app">, env: NodeJS.ProcessEnv = process.env): Promise<{ key: string; status: string; stage: string | null; project: string } | null> {
  const r = readerOf(db);
  const [prior] = (await r.find("briefActions", { itemId: idea.id, undoneAt: null, action: ["keep", "research", "sketch"] }, { orderBy: [{ column: "createdAt", desc: true }] })).filter(actionDone);
  const slug = ideaProject(idea, env);
  const p = await r.get("projects", { slug });
  if (!p) return null;
  const result = prior?.outcome.result;
  const key = typeof result?.key === "string" ? result.key : null;
  const t = key
    ? await r.get("tasks", { projectId: p.id, key })
    : (await r.find("tasks", { projectId: p.id, kind: "idea", status: "Open" })).find((x) => x.title.toLowerCase() === idea.title.toLowerCase());
  return t ? { key: t.key, status: t.status, stage: t.stage, project: p.slug } : null;
}

async function keep(db: Db, idea: Idea, lang: string, env: NodeJS.ProcessEnv): Promise<{ key: string; project: string; created: boolean; stage: string | null }> {
  const have = await ideaRecord(db, idea, env);
  if (have && have.status === "Open") return { key: have.key, project: have.project, created: false, stage: have.stage };
  const project = ideaProject(idea, env);
  const made = (await createTask(db, { project, kind: "idea", title: idea.title, summary: idea.why } as never, ctx("keep"))) as { key: string };
  await attachDoc(db, { project, key: made.key, title: "Idea", markdown: ideaDoc(idea, lang) }, ctx("keep"));
  return { key: made.key, project, created: true, stage: "idea" };
}

export type IdeaOutcome = { line: string; result: Record<string, unknown> } | { error: string; hint: string };

export async function runIdea(db: Db, brief: MorningBrief, idea: Idea, action: IdeaAction, input: Record<string, unknown>, lang: string, env: NodeJS.ProcessEnv = process.env): Promise<IdeaOutcome> {
  const w = say(IDEA_WORDS, ideaLang(lang));
  try {
    if (action === "keep") {
      const k = await keep(db, idea, lang, env);
      return { line: w.kept(k.key), result: { ...k, title: idea.title, app: idea.app } };
    }
    if (action === "discard") {
      const have = await ideaRecord(db, idea, env);
      const reason = String(input.reason);
      if (have && have.status === "Open") {
        const t = await readerOf(db).get("tasks", { key: have.key });
        await setTask(db, { project: have.project, key: have.key, status: "Won't do", version: t!.version, reason: w.discardReason(reason, input.note ? String(input.note) : "") } as never, ctx("discard"));
      }
      const words = w.reasons[reason] ?? reason;
      return { line: w.discarded(words), result: { title: idea.title, app: idea.app, reason, note: input.note ?? null, key: have?.key ?? null } };
    }
    if (action === "research") {
      const k = await keep(db, idea, lang, env);
      if (k.stage === "idea") {
        const t = await readerOf(db).get("tasks", { key: k.key });
        // The stage move wakes the project's Research (src/runner/events.ts); a paused project's waits.
        await setTask(db, { project: k.project, key: k.key, stage: "research", version: t!.version } as never, ctx("research"));
      }
      return { line: w.toResearch(k.key), result: { ...k, stage: "research", title: idea.title, app: idea.app } };
    }
    if (action === "sketch") {
      const k = await keep(db, idea, lang, env);
      const p = await readerOf(db).get("projects", { slug: k.project });
      const artist = p ? await serviceAgent(db, "artist", p) : null;
      if (!artist) return { error: "NO_ARTIST", hint: w.noArtist };
      const ticket = (await createTask(
        db,
        {
          project: k.project,
          title: `Sketch: ${idea.title}`.slice(0, 200),
          status: "Ready",
          origin: "owner",
          work_type: "research",
          priority: "P2",
          owner_agent: artist.slug,
          scope: [
            w.sketchAsk(ownerIn(ideaLang(lang), "de"), k.key, idea.title),
            "",
            idea.why,
            "",
            w.sketchWhat(k.key),
          ].join("\n"),
          checks: [w.sketchCheck(k.key)],
        } as never,
        ctx("sketch"),
      )) as { key: string };
      const t = await readerOf(db).get("tasks", { projectId: p!.id, key: ticket.key });
      // An Artist-owned Ready ticket wakes nobody by itself: queue its wake (held while the project is paused;
      // turning runs on wakes it then, once).
      const wake = await queueWake(db, p!, t!, { agent: artist, taskKey: ticket.key, reason: `sketch from the morning brief: ${idea.title}` }, "brief.sketch");
      return { line: w.toArtist(ticket.key), result: { ...k, ticket: ticket.key, agent: artist.slug, wake: wake.kind === "queued" ? "queued" : wake.reason, title: idea.title, app: idea.app } };
    }
    // plan: Send to Plania, as V1.
    const sent = await sendToPlania(db, { briefId: brief.id, codes: [idea.code] }, { env });
    return { line: w.toPo, result: { request_id: sent.request_id, title: idea.title, app: idea.app, code: idea.code } };
  } catch (e) {
    if (e instanceof ToolError) return { error: e.code, hint: String((e.detail as { hint?: string } | undefined)?.hint ?? e.code) };
    if (e instanceof PlanError) return { error: e.code, hint: e.code };
    throw e;
  }
}

/** For pass B: ideas discarded in the last 60 days, with their reason (newest first, one per title). */
export async function discardedIdeas(db: Db, now: Date = new Date()): Promise<{ app: string; title: string; reason: string; note: string | null }[]> {
  const since = new Date(now.getTime() - DISCARD_DAYS * 86_400_000);
  const rows = (await readerOf(db).find("briefActions", { action: "discard", undoneAt: null, createdAt: gte(since) }, { orderBy: [{ column: "createdAt", desc: true }] })).filter(actionDone).slice(0, 200);
  const seen = new Set<string>();
  const out: { app: string; title: string; reason: string; note: string | null }[] = [];
  for (const r of rows) {
    const x = (r.outcome.result ?? {}) as { app?: string; title?: string; reason?: string; note?: string | null };
    if (!x.title || seen.has(x.title.toLowerCase())) continue;
    seen.add(x.title.toLowerCase());
    out.push({ app: x.app ?? "", title: x.title, reason: x.reason ?? "other", note: x.note ?? null });
  }
  return out;
}

// PLA-I51-4: promoted_to is the initiative the idea became (null while it is still open work); the page lists only
// the ones without it under "Ya en Plania" and counts the rest.
export type IdeaInMotion = { project: string; key: string; title: string; stage: string | null; next: "sketch_ready" | "research_ready" | "planned" | "in_motion"; sketch: boolean; research: boolean; doc_url: string | null; promoted_to: string | null };

/** Open Plania ideas of the brief's projects: their stage, and whether a Sketch or Research doc came back. */
export async function ideasInMotion(db: Db, slugs: string[]): Promise<IdeaInMotion[]> {
  if (!slugs.length) return [];
  const r = readerOf(db);
  const ps = await r.find("projects", { slug: slugs });
  if (!ps.length) return [];
  const slugOf = new Map(ps.map((p) => [p.id, p.slug]));
  // Ideas not planned yet first, so the limit never pushes them out behind planned ones; then newest change first.
  const rows = (await r.find("tasks", { projectId: ps.map((p) => p.id), kind: "idea", status: "Open" }, { orderBy: [{ column: "updatedAt", desc: true }] }))
    .sort((a, b) => Number(a.promotedTo !== null) - Number(b.promotedTo !== null))
    .slice(0, 30);
  const ids = rows.map((t) => t.id);
  const docRows = ids.length ? await r.find("docs", { taskId: ids }) : [];
  return rows.map((t) => {
    const mine = docRows.filter((d) => d.taskId === t.id);
    const sketch = mine.find((d) => d.title === "Sketch");
    const research = mine.some((d) => d.title === "Research");
    const url = sketch?.markdown.match(/https?:\/\/\S+/)?.[0]?.replace(/[).,]+$/, "") ?? null;
    const next = t.promotedTo ? "planned" : sketch ? "sketch_ready" : research ? "research_ready" : "in_motion";
    return { project: slugOf.get(t.projectId)!, key: t.key, title: t.title, stage: t.stage, next, sketch: !!sketch, research, doc_url: url, promoted_to: t.promotedTo ?? null };
  });
}

/** How many earlier briefs (newest first, up to IDEA_SEEN_MAX) already showed each idea id. */
export async function ideaSeen(db: Db, beforeDate: string): Promise<Map<string, number>> {
  // The newest brief of each earlier date, for the IDEA_SEEN_MAX newest dates.
  const rows = await readerOf(db).find("morningBriefs", {}, { orderBy: [{ column: "localDate", desc: true }, { column: "generatedAt", desc: true }] });
  const prev: { ideas?: { id?: string }[] }[] = [];
  const dates = new Set<string>();
  for (const b of rows) {
    if (!(b.localDate < beforeDate) || dates.has(b.localDate)) continue;
    dates.add(b.localDate);
    prev.push(b.data as { ideas?: { id?: string }[] });
    if (prev.length >= IDEA_SEEN_MAX) break;
  }
  const out = new Map<string, number>();
  for (const b of prev) for (const i of b.ideas ?? []) if (i.id) out.set(i.id, (out.get(i.id) ?? 0) + 1);
  return out;
}

/** Idea ids the owner already acted on (any fate): they leave Today's ideas. */
export async function actedIdeaIds(db: Db): Promise<Set<string>> {
  const rows = (await readerOf(db).find("briefActions", { undoneAt: null })).filter((a) => a.itemId.startsWith("d|") && actionDone(a));
  return new Set(rows.map((r) => r.itemId));
}

/** Keys of Plania objects a brief row was already acted on (so a "look at the sketch" row does not come back daily). */
export async function actedTargetKeys(db: Db): Promise<Set<string>> {
  const rows = (await readerOf(db).find("briefActions", { undoneAt: null })).filter(actionDone);
  const keys = new Set<string>();
  for (const a of rows) {
    // target->>'key': a string as is, any other non-null JSON value as its text.
    const k = a.target && typeof a.target === "object" ? (a.target as Record<string, unknown>).key : undefined;
    if (k === undefined || k === null) continue;
    keys.add(typeof k === "string" ? k : JSON.stringify(k));
  }
  return keys;
}
