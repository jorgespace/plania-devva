// PLA-I68-2: the camino row and its history, and the one read the screen gets (GET /api/company/projects/:slug/camino).
// Discovery runs on «Volver a comprobar», on the first open, and in the background when the last one is older than
// STALE_MS; one at a time per project. Every outside call is injected (caminoDeps) so tests never reach GitHub.
import pg from "pg";
import type { Db } from "../db/client.js";
import type { CaminoDest, Project } from "../db/schema.js";
import { writeVia } from "../runner/limits.js";
import { readerOf } from "../store/port.js";
import { gte } from "../store/types.js";
import { githubToken } from "../jobs/github.js";
import { startBranchOf } from "../runner/start-branch.js";
import { projectsRoot, repoPathOf } from "../runner/worktree.js";
import { findProject } from "../mcp/queries.js";
import { effectiveConfig, RUNNER_WORK_PATTERN, type EffectiveConfig } from "./config.js";
import { discoverGithub, ghApi, type GhApi } from "./github.js";
import { caminoKeys } from "./keys.js";
import { discoverMac } from "./mac.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { envValue } from "../captures/prueba.js";
import { ENV_FILES } from "../maquinas/env.js";
import { caminoSay } from "./words.js";
import { runActionlint, type Actionlint } from "./actionlint.js";
import type { HttpFetch } from "./providers.js";
import type { CaminoConfig, Discovery, ProviderId } from "./types.js";

export const STALE_MS = 15 * 60_000;

export type CaminoDeps = {
  fetch: HttpFetch;
  /** PLA-I68-5: the workflow linter (actionlint on stdin). */
  actionlint: Actionlint;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  listDatabases: () => Promise<string[] | null>;
};

// The local Postgres server, on this machine only. Plania's own data is in the devva store, so there is no DATABASE_URL
// of Plania's to take the server's address from: connect on loopback the way the machine job does, as the OS user
// (PGUSER, PGPORT and PGPASSWORD apply when set), to a database by name.
export function localPgClient(database: string): pg.Client {
  const c = new pg.Client({ host: "127.0.0.1", database, connectionTimeoutMillis: 3_000 });
  c.on("error", () => undefined);
  return c;
}

async function localDatabases(): Promise<string[] | null> {
  const c = localPgClient("postgres");
  try {
    await c.connect();
    const r = await c.query<{ datname: string }>("select datname from pg_database where not datistemplate order by datname");
    return r.rows.map((x) => x.datname);
  } catch {
    return null;
  } finally {
    await c.end().catch(() => {});
  }
}

export const caminoDeps: CaminoDeps = {
  fetch: (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<HttpFetch>,
  actionlint: runActionlint,
  env: process.env,
  now: () => new Date(),
  listDatabases: localDatabases,
};

/** The GitHub client for a project: its saved key in Camino, else the poller's token. Null with no token at all. */
export async function githubFor(p: Project, deps: CaminoDeps = caminoDeps): Promise<GhApi | null> {
  const saved = await caminoKeys().get(p.slug, "github");
  if (saved) return ghApi(saved, "camino", deps.fetch);
  const t = await githubToken({ fetch: deps.fetch as never, env: deps.env }, { token_env: p.settings.github?.token_env });
  return t.token ? ghApi(t.token, t.source, deps.fetch) : null;
}

/** The project's stored config ({} until the owner saves something), its version and its last discovery. */
export async function caminoRow(db: Db, projectId: string) {
  const row = await readerOf(db).get("camino", { projectId });
  return row ?? { projectId, config: {} as CaminoConfig, version: 0, discovery: null, checkedAt: null, updatedAt: null };
}

/** Stores the config: a new row at version 1, else the row's version + 1 (bump false keeps it, PLA-I70-17). */
export async function saveCaminoConfig(db: Db, projectId: string, config: CaminoConfig, bump = true): Promise<void> {
  await writeVia(
    db,
    async (uow) => {
      const cur = await uow.get("camino", { projectId });
      if (!cur) await uow.insert("camino", { projectId, config, version: 1 });
      else await uow.update("camino", { projectId }, { config, version: bump ? cur.version + 1 : cur.version, updatedAt: uow.now });
    },
    projectId,
  );
}

/** PLA-I70-6: the work-branch pattern the runner names branches by: the owner's, else the neutral default. */
export async function workPatternOf(db: Db, projectId: string): Promise<string> {
  const row = await caminoRow(db, projectId);
  return row.config.branches?.work_pattern?.trim() || RUNNER_WORK_PATTERN;
}

/** PLA-158 (F-26): the name of the database the project's own env file (in its folder) points at, read as the copies
 * read it (appBaseUrl: the copies' variable, else the usual database variables), or null. Names only, never a value. */
export function ownDatabaseOf(p: Project, folder: string): string | null {
  const cfg = p.settings.capture?.database;
  const vars = cfg ? [cfg.env_var] : ["DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL", "PG_URL", "DB_URL"];
  for (const f of p.settings.maquinas?.env_file ? [p.settings.maquinas.env_file] : ENV_FILES) {
    let text: string;
    try {
      text = readFileSync(path.join(folder, f), "utf8");
    } catch {
      continue;
    }
    for (const v of vars) {
      const url = envValue(text, v);
      if (!url || !/^postgres(ql)?:/.test(url)) continue;
      try {
        const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
        if (/^[A-Za-z0-9_-]{1,63}$/.test(name)) return name;
      } catch {
        // not a URL: try the next one
      }
    }
  }
  return null;
}

/** Runs discovery and stores it. Errors become the discovery's own ok:false, never a throw. */
export async function discover(db: Db, p: Project, deps: CaminoDeps = caminoDeps): Promise<Discovery> {
  const t0 = Date.now();
  const row = await caminoRow(db, p.id);
  const repo = p.settings.github?.repo ?? null;
  const base = effectiveConfig(p.settings, row.config, null);
  const roles = [base.branches.published, base.branches.integration].filter((b): b is string => !!b);
  const api = await githubFor(p, deps);
  const now = deps.now();
  const github: Discovery["github"] = !repo
    ? { ok: false, error: "no_repo", repos: api ? await reposOnly(api) : [] }
    : !api
      ? { ok: false, error: "no_token" }
      : await discoverGithub(api, repo, roles, now).catch((e) => ({ ok: false as const, error: "network" as const, detail: e instanceof Error ? e.message.slice(0, 200) : "" }));
  const folder = p.settings.local?.no_code ? null : repoPathOf(p.slug, p.settings, deps.env);
  const mac = await discoverMac(folder, repo, { listDatabases: deps.listDatabases, projectsRoot: projectsRoot(deps.env), ownDatabase: folder ? ownDatabaseOf(p, folder) : null });
  // PLA-I70-3: a network failure never erases the last good read; it is kept, marked stale with its age.
  const prevGh = row.discovery?.github;
  const kept: Discovery["github"] =
    !github.ok && github.error === "network" && prevGh?.ok && prevGh.repo.full_name === repo
      ? { ...prevGh, stale: { since: prevGh.stale?.since ?? row.discovery!.checked_at, error: github.detail ?? "network" } }
      : github.ok
        ? github
        : { ...github, source: api?.source ?? null };
  const d: Discovery = { checked_at: now.toISOString(), took_ms: Date.now() - t0, github: kept, mac };
  // PLA-I68-3: what changed on GitHub since the last read and was not Plania's own doing goes to Historial.
  const prev = row.discovery;
  await writeVia(
    db,
    async (uow) => {
      if (prev) {
        // A merge-option change Plania itself applied since the last read is not someone else's.
        const mine = await uow.count("caminoHistory", { projectId: p.id, who: "owner", dest: "github", at: gte(new Date(prev.checked_at)) });
        const ours = mine > 0;
        for (const h of outsideChanges(prev, d)) if (!(ours && h === caminoSay().outsideMerge)) await addHistory(uow.sql, p.id, { who: "outside", label: h, dest: "github" });
      }
      if (await uow.get("camino", { projectId: p.id })) await uow.update("camino", { projectId: p.id }, { discovery: d, checkedAt: now });
      else await uow.insert("camino", { projectId: p.id, discovery: d, checkedAt: now });
    },
    p.id,
  );
  return d;
}

async function reposOnly(api: GhApi): Promise<string[]> {
  try {
    const r = await api.call("GET", "/user/repos?per_page=100&sort=pushed");
    return r.status === 200 ? ((await r.json()) as { full_name: string }[]).map((x) => x.full_name) : [];
  } catch {
    return [];
  }
}

const running = new Map<string, Promise<Discovery>>();
/** One discovery at a time per project; a second call waits for the first. */
export function discoverOnce(db: Db, p: Project, deps: CaminoDeps = caminoDeps): Promise<Discovery> {
  const live = running.get(p.id);
  if (live) return live;
  const job = discover(db, p, deps).finally(() => running.delete(p.id));
  running.set(p.id, job);
  return job;
}
export const discovering = (projectId: string) => running.has(projectId);

export async function addHistory(db: Db, projectId: string, h: { who: string; label: string; dest: CaminoDest; undo?: string | null; detail?: Record<string, unknown> }) {
  await writeVia(db, (uow) => uow.insert("caminoHistory", { projectId, who: h.who, label: h.label, dest: h.dest, undo: h.undo ?? null, detail: h.detail ?? {} }), projectId);
}

/** Writes the stored config with the version the screen read (STALE when someone wrote since). */
export async function writeConfig(db: Db, projectId: string, version: number, next: CaminoConfig): Promise<number> {
  const { ToolError } = await import("../mcp/errors.js");
  // The version is checked inside the write, so nothing lands between the check and the save.
  return writeVia(
    db,
    async (uow) => {
      const cur = await uow.get("camino", { projectId });
      const current = cur?.version ?? 0;
      if (current !== version) throw new ToolError("STALE_VERSION", { current_version: current });
      if (!cur) return (await uow.insert("camino", { projectId, config: next, version: version + 1, updatedAt: uow.now })).version;
      const [u] = await uow.update("camino", { projectId }, { config: next, version: cur.version + 1, updatedAt: uow.now });
      return u!.version;
    },
    projectId,
  );
}

export type Proposal = { number: number; title: string; url: string; state: string; base_branch: string | null; head_branch: string | null; ci_state: string | null; task_key: string | null; merged_at: string | null; updated_at: string };
export type ConnectionRead = { provider: ProviderId; saved: boolean; meta: NonNullable<CaminoConfig["connections"]>[ProviderId] | null };

export type CaminoRead = {
  slug: string;
  title: string;
  version: number;
  config: EffectiveConfig;
  settings: { repo: string | null; folder: string | null; no_code: boolean; release: { from: string; into: string; env: string; mode: "command" | "merge"; prod_migrations: string | null } | null; capture: boolean; capture_pages: string[]; vercel: boolean;
    // PLA-133: the four settings Camino edits since they left Ajustes › Avanzado, as stored (null: the default holds).
    start_branch: string | null; start_default: string; github_token_env: string | null; release_on: "env" | "branch" | null; release_target: string | null;
    vercel_config: { project_id: string; team_id: string | null; token_env: string | null; targets: Record<string, string> | null } | null };
  discovery: Discovery | null;
  checked_at: string | null;
  checking: boolean;
  plania: {
    envs: { env: string; commit: string | null; branch: string | null; migrations_applied: number | null; migrations: number; deployed_at: string | null }[];
    note_stale: boolean;
    keys_store: "keychain" | "file" | "memory";
  };
  proposals: Proposal[];
  history: { at: string; who: string; label: string; dest: CaminoDest; undo: string | null }[];
};

export async function caminoRead(db: Db, slug: string): Promise<CaminoRead> {
  const p = await findProject(db, slug);
  const row = await caminoRow(db, p.id);
  const d = row.discovery;
  const gh = d?.github.ok ? { default_branch: d.github.repo.default_branch, merge: d.github.repo.merge } : null;
  const r = readerOf(db);
  const [envRows, prs, hist, proj] = await Promise.all([
    r.find("envStates", { projectId: p.id }),
    r.find("pullRequests", { projectId: p.id }),
    r.find("caminoHistory", { projectId: p.id }, { orderBy: [{ column: "at", desc: true }], limit: 80 }),
    r.get("projects", { id: p.id }),
  ]);
  // Open, or merged (else last touched) in the last 30 days; the newest on GitHub first, with its ticket's key.
  const since = Date.now() - 30 * 24 * 3600_000;
  const recent = prs
    .filter((pr) => pr.state === "open" || (pr.mergedAt ?? pr.updatedAt).getTime() > since)
    .sort((a, b) => (b.ghUpdatedAt ?? b.updatedAt).getTime() - (a.ghUpdatedAt ?? a.updatedAt).getTime())
    .slice(0, 120);
  const taskIds = [...new Set(recent.flatMap((pr) => (pr.taskId ? [pr.taskId] : [])))];
  const keyOf = new Map((taskIds.length ? await r.find("tasks", { id: taskIds }) : []).map((t) => [t.id, t.key]));
  const prRows = recent.map((pr) => ({ pr, key: pr.taskId ? (keyOf.get(pr.taskId) ?? null) : null }));
  const s = p.settings;
  return {
    slug: p.slug,
    title: p.title,
    version: row.version,
    config: effectiveConfig(s, row.config, gh),
    settings: {
      repo: s.github?.repo ?? null,
      folder: s.local?.no_code ? null : repoPathOf(p.slug, s),
      no_code: s.local?.no_code === true,
      release: s.release ? { from: s.release.from, into: s.release.into, env: s.release.env, mode: s.release.mode ?? "command", prod_migrations: s.release.prod_migrations ?? null } : null,
      capture: !!s.capture,
      capture_pages: [...new Set((s.capture?.pages ?? []).map((x) => x.path))],
      vercel: !!s.vercel,
      start_branch: s.start_branch ?? null,
      start_default: startBranchOf({}),
      github_token_env: s.github?.token_env ?? null,
      release_on: s.release_on ?? null,
      release_target: s.release_target ?? null,
      vercel_config: s.vercel ? { project_id: s.vercel.project_id, team_id: s.vercel.team_id ?? null, token_env: s.vercel.token_env ?? null, targets: s.vercel.targets ?? null } : null,
    },
    discovery: d,
    checked_at: row.checkedAt?.toISOString() ?? null,
    checking: discovering(p.id),
    plania: {
      envs: envRows.map((e) => ({ env: e.env, commit: e.commit, branch: e.branch, migrations_applied: e.migrationsApplied, migrations: e.migrations.length, deployed_at: e.deployedAt?.toISOString() ?? null })),
      note_stale: !!proj?.headlineNoteStale,
      keys_store: caminoKeys().kind,
    },
    proposals: prRows.map(({ pr, key }) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      base_branch: pr.baseBranch,
      head_branch: pr.headBranch,
      ci_state: pr.ciState,
      task_key: key,
      merged_at: pr.mergedAt?.toISOString() ?? null,
      updated_at: (pr.ghUpdatedAt ?? pr.updatedAt).toISOString(),
    })),
    history: hist.map((h) => ({ at: h.at.toISOString(), who: h.who, label: h.label, dest: h.dest, undo: h.undo })),
  };
}

/** PLA-I68-3: the differences between two reads that someone made on GitHub outside Plania: rulesets that are not
 * Plania's (plania-*) created, deleted or changed, the default branch, and the merge options. */
export function outsideChanges(before: Discovery, after: Discovery): string[] {
  const a = before.github;
  const b = after.github;
  if (!a.ok || !b.ok || a.repo.full_name !== b.repo.full_name) return [];
  const w = caminoSay();
  const out: string[] = [];
  const key = (r: { enforcement: string; required_checks: string[]; branches: string[] }) => JSON.stringify([r.enforcement, [...r.required_checks].sort(), [...r.branches].sort()]);
  const was = new Map(a.rules.list.filter((r) => !r.plania).map((r) => [r.id, r]));
  const now = new Map(b.rules.list.filter((r) => !r.plania).map((r) => [r.id, r]));
  if (a.rules.available && b.rules.available) {
    for (const [id, r] of now) if (!was.has(id)) out.push(w.outsideRuleset(r.name, w.created));
    for (const [id, r] of was) if (!now.has(id)) out.push(w.outsideRuleset(r.name, w.removed));
    for (const [id, r] of now) if (was.has(id) && key(was.get(id)!) !== key(r)) out.push(w.outsideRuleset(r.name, w.changed));
  }
  if (b.repo.default_branch && a.repo.default_branch !== b.repo.default_branch) out.push(w.outsideDefault(b.repo.default_branch));
  // PLA-I70-2: field by field; a jsonb round trip reorders keys, so comparing the JSON text made every re-read «change».
  if (a.repo.merge && b.repo.merge && !b.stale && !a.stale) {
    const f = (m: NonNullable<typeof a.repo.merge>) => [m.squash, m.merge, m.rebase, m.delete_on_merge, m.suggest_update];
    const after = f(b.repo.merge);
    if (f(a.repo.merge).some((v, i) => v !== after[i])) out.push(w.outsideMerge);
  }
  return out;
}
