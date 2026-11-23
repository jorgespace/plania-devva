// PLA-I67-1: «Oficio», one agent's page, read from what Plania already stores (no table of its own).
//   GET /api/company/projects/:slug/team/:agent/oficio
//     → {project, agent, role, own, skills, deliveries, counts, runs, live}
//     404 PROJECT_NOT_FOUND | AGENT_NOT_FOUND
//
// skills       every skill on the shelf (the kit's folders and the `Pack:` docs, listPacks), each with on (the seat's
//              next run carries it: packsOf with the role, so a seat with no list of its own shows its default kit),
//              factory (in the role's default kit) and its use: runs that carried it and runs that used it, and
//              the deliveries (below) that carried it and that used it. Version strings on a run are "slug@sha".
// deliveries   the seat's last DELIVERIES tickets or ideas, newest work first: one per task key its runs worked on in
//              the last WINDOW_DAYS. outcome says how it went: primera (closed with no send-back), devuelta (the owner
//              asked for changes at least once; words are the newest request), espera (in review or waiting on the
//              owner), trabajando (a run is on it), en_curso (anything else still open), descartada (Won't do).
//              carried / used are the skill slugs its runs carried and used.
// counts       closed deliveries (primera + devuelta that landed), how many landed first time, and of the last five
//              closed how many landed first time.
// runs         the seat's finished runs in the window: total, how many carried a kit, how many used a skill.
//
// The owner's words pass through scrub (no paths, no secret-looking strings). A run's cwd, log or worktree is never
// selected.
import type { Db } from "../db/client.js";
import { readerOf } from "../store/port.js";
import { gte } from "../store/types.js";
import { defaultSkills } from "../runner/kit.js";
import { roleOf } from "../runner/limits.js";
import { listPacks } from "../runner/packs.js";
import { ownerEntry, ownerSkillsFor, resolvedKit, SKILLS_WARN } from "../runner/skills.js";
import { LEGACY_CHANGES_LIKE, LEGACY_CHANGES_PREFIX } from "../runner/runner.js";
import { scrub } from "./scoreboard.js";

export const WINDOW_DAYS = 90;
export const DELIVERIES = 12;
const LANDED = new Set(["Merged", "Released", "Done"]);
const WAITING = new Set(["In review", "Needs owner"]);
const LIVE = new Set(["starting", "running"]);

export type Outcome = "primera" | "devuelta" | "espera" | "trabajando" | "en_curso" | "descartada";
export type OficioSkill = {
  slug: string;
  name: string;
  when: string;
  source: "kit" | "doc" | "owner";
  version: string;
  on: boolean;
  factory: boolean;
  // PLA-I67-2: an owner skill (or an owner copy of a factory one) in this agent's scope; null for the factory kit.
  owner: { scope: string; state: string; origin: string; n: number } | null;
  runs_carried: number;
  runs_used: number;
  deliveries_carried: number;
  deliveries_used: number;
};
export type OficioDelivery = {
  key: string;
  title: string;
  kind: string;
  status: string;
  outcome: Outcome;
  closed: boolean;
  sent_back: number;
  words: string | null;
  at: string;
  runs: number;
  carried: string[];
  used: string[];
};
export type Oficio = {
  project: string;
  agent: string;
  role: string;
  own: boolean;
  skills: OficioSkill[];
  deliveries: OficioDelivery[];
  counts: { closed: number; first_time: number; last_five: number; last_five_first: number };
  runs: { total: number; with_kit: number; used_any: number };
  live: { key: string | null; since: string } | null;
  window_days: number;
  // PLA-I67-2: more skills on than the screen recommends.
  too_many: boolean;
};
export type OficioError = { error: "PROJECT_NOT_FOUND" | "AGENT_NOT_FOUND"; status: 404; hint: string };

type RunRow = { task_key: string | null; status: string; skills: string[]; skills_used: string[]; at: string; started_at: string | null } & Record<string, unknown>;
type TaskRow = { key: string; title: string; kind: string; status: string } & Record<string, unknown>;
type ChangeRow = { task_key: string; text: string | null; changes: string | null } & Record<string, unknown>;

const slugOf = (version: string) => version.split("@")[0]!;
// A SQL LIKE pattern as a whole-text match (% any run, _ any one character).
const likeOf = (pattern: string) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, "[\\s\\S]*").replace(/_/g, "[\\s\\S]")}$`);
// payload->>'key': a string as it is, null when missing or null, anything else as its JSON text.
const jsonText = (v: unknown): string | null => (v === undefined || v === null ? null : typeof v === "string" ? v : JSON.stringify(v));

export function outcomeOf(t: { status: string; kind: string } | undefined, sentBack: number, live: boolean): { outcome: Outcome; closed: boolean } {
  if (live) return { outcome: "trabajando", closed: false };
  const status = t?.status ?? "";
  if (status === "Won't do") return { outcome: "descartada", closed: false };
  if (LANDED.has(status)) return { outcome: sentBack ? "devuelta" : "primera", closed: true };
  if (sentBack) return { outcome: "devuelta", closed: false };
  // An idea is delivered stage by stage; while it is open, the owner has it.
  if (WAITING.has(status) || (t?.kind === "idea" && status === "Open")) return { outcome: "espera", closed: false };
  return { outcome: "en_curso", closed: false };
}

export async function oficioRead(db: Db, slug: string, agentSlug: string, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): Promise<Oficio | OficioError> {
  const r = readerOf(db);
  const p = await r.get("projects", { slug });
  if (!p) return { error: "PROJECT_NOT_FOUND", status: 404, hint: "no such project" };
  const a = await r.get("agents", { slug: agentSlug, projectId: p.id });
  if (!a || a.status === "retired") return { error: "AGENT_NOT_FOUND", status: 404, hint: `${agentSlug} is not on ${slug}'s team` };
  const role = roleOf(a);
  // PLA-I67-2: the shelf is the factory kit and the owner's skills in this agent's scope; an owner copy takes its
  // factory skill's place. on is what the next run carries (resolvedKit), in its order.
  const mine = await ownerSkillsFor(db, a);
  const owned = new Map(mine.map((m) => [m.row.slug, m]));
  const shelf = [...(await listPacks(db, env)).filter((x) => !owned.has(x.slug)).map((x) => ({ ...x, owner: null })), ...mine.map((m) => ({ ...ownerEntry(m), owner: { scope: m.row.scope, state: m.row.state, origin: m.row.origin, n: m.version.n } }))];
  const on = new Set((await resolvedKit(db, a, env, role)).map((x) => x.slug));
  const factory = new Set(role ? defaultSkills(role, env) : []);

  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const runs: RunRow[] = (
    await r.find("agentRuns", { agentId: a.id, projectId: p.id, queuedAt: gte(since), status: ["ok", "fail", "stopped", "starting", "running"] }, { orderBy: [{ column: "queuedAt", desc: true }], limit: 500 })
  ).map((x) => ({ task_key: x.taskKey, status: x.status, skills: x.skills, skills_used: x.skillsUsed, at: (x.endedAt ?? x.startedAt ?? x.queuedAt).toISOString(), started_at: x.startedAt ? x.startedAt.toISOString() : null }));

  // One delivery per task key, in the order its newest run came.
  const byKey = new Map<string, RunRow[]>();
  for (const r of runs) {
    if (!r.task_key) continue;
    const list = byKey.get(r.task_key);
    if (list) list.push(r);
    else if (byKey.size < DELIVERIES) byKey.set(r.task_key, [r]);
  }
  const keys = [...byKey.keys()];
  const tasks: TaskRow[] = keys.length ? (await r.find("tasks", { projectId: p.id, key: keys })).map((t) => ({ key: t.key, title: t.title, kind: t.kind, status: t.status })) : [];
  const taskOf = new Map(tasks.map((t) => [t.key, t]));
  // The owner's requests for changes: the note thread-actions writes with owner_changes (older ones by their prefix).
  const legacy = likeOf(LEGACY_CHANGES_LIKE);
  const changes: ChangeRow[] = keys.length
    ? (await r.find("events", { projectId: p.id, type: "note", taskKey: keys }, { orderBy: [{ column: "id" }] }))
        .map((e) => ({ task_key: e.taskKey!, text: jsonText(e.payload.text), changes: jsonText(e.payload.owner_changes), has: "owner_changes" in e.payload }))
        .filter((c) => c.has || (c.text !== null && legacy.test(c.text)))
        .map(({ has: _has, ...c }) => c)
    : [];
  const sentBack = new Map<string, { n: number; words: string | null }>();
  for (const c of changes) {
    const prev = sentBack.get(c.task_key) ?? { n: 0, words: null };
    const words = c.changes ?? (c.text ? c.text.replace(LEGACY_CHANGES_PREFIX, "") : null);
    sentBack.set(c.task_key, { n: prev.n + 1, words: scrub(words, 600) ?? prev.words });
  }

  const deliveries: OficioDelivery[] = keys.map((key) => {
    const rs = byKey.get(key)!;
    const t = taskOf.get(key);
    const back = sentBack.get(key) ?? { n: 0, words: null };
    const { outcome, closed } = outcomeOf(t, back.n, rs.some((r) => LIVE.has(r.status)));
    return {
      key,
      title: t?.title ?? key,
      kind: t?.kind ?? "ticket",
      status: t?.status ?? "",
      outcome,
      closed,
      sent_back: back.n,
      words: back.words,
      at: new Date(rs[0]!.at).toISOString(),
      runs: rs.length,
      carried: [...new Set(rs.flatMap((r) => r.skills.map(slugOf)))].sort(),
      used: [...new Set(rs.flatMap((r) => r.skills_used))].sort(),
    };
  });

  const finished = runs.filter((r) => !LIVE.has(r.status));
  const skills: OficioSkill[] = shelf.map((x) => ({
    slug: x.slug,
    name: x.name,
    when: x.when,
    source: x.source,
    version: `${x.slug}@${x.sha}`,
    on: on.has(x.slug),
    factory: factory.has(x.slug),
    owner: x.owner,
    runs_carried: finished.filter((r) => r.skills.some((v) => slugOf(v) === x.slug)).length,
    runs_used: finished.filter((r) => r.skills_used.includes(x.slug)).length,
    deliveries_carried: deliveries.filter((d) => d.carried.includes(x.slug)).length,
    deliveries_used: deliveries.filter((d) => d.used.includes(x.slug)).length,
  }));
  // The ones it carries first (in the order it carries them), then the rest of the shelf by name.
  const order = [...on];
  skills.sort((x, y) => (x.on === y.on ? (x.on ? order.indexOf(x.slug) - order.indexOf(y.slug) : x.name.localeCompare(y.name)) : x.on ? -1 : 1));

  const closedOnes = deliveries.filter((d) => d.closed);
  const lastFive = closedOnes.slice(0, 5);
  const live = runs.find((r) => LIVE.has(r.status));
  return {
    project: slug,
    agent: a.slug,
    role: role ?? a.role,
    own: (a.skillPacks ?? []).length > 0,
    skills,
    deliveries,
    counts: { closed: closedOnes.length, first_time: closedOnes.filter((d) => d.outcome === "primera").length, last_five: lastFive.length, last_five_first: lastFive.filter((d) => d.outcome === "primera").length },
    runs: { total: finished.length, with_kit: finished.filter((r) => r.skills.length > 0).length, used_any: finished.filter((r) => r.skills_used.length > 0).length },
    live: live ? { key: live.task_key, since: new Date(live.started_at ?? live.at).toISOString() } : null,
    window_days: WINDOW_DAYS,
    too_many: on.size > SKILLS_WARN,
  };
}
