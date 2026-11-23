// PLA-58: what a run really changes, and the files every step builds on.
//   changedFiles   a worktree's branch diff against origin/sandbox, its uncommitted changes and its new files
//   sweepTouched   each heartbeat tick, a live Taller run's changed files that its ticket's areas do not cover are
//                  added to those areas (event task.areas_touched), so the clash check and readiness see them
//   sharedAreasOf  paths no single ticket owns (shadcn's components/ui, package.json, lockfiles…): while a live code
//                  run touches one, every other code run in the project waits (runner.ts areasClash)
// Seen 2026-11-17: MIA-I7-2 declared src/app/registro/** but edited src/components/ui/native-select.tsx, which
// MIA-I7-3 (src/app/panel/**) needed too; nothing would have kept the two apart.
import { existsSync } from "node:fs";
import path from "node:path";
import type { Db } from "../db/client.js";
import type { ProjectRunnerSettings, ProjectSettings } from "../db/schema.js";
import { SYSTEM_ACTOR, writeTx } from "../mcp/tx.js";
import { readerOf, uowOf } from "../store/port.js";
import { notNull } from "../store/types.js";
import { areasOverlap } from "../mcp/writes.js";
import { startBranchOf } from "./start-branch.js";
import { ALLOWED_BASE, defaultGit, type GitFn } from "./worktree.js";

export const DEFAULT_SHARED_AREAS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "components.json",
  "src/components/ui/**",
  "src/lib/utils.ts",
  "src/app/globals.css",
] as const;

export const sharedAreasOf = (s: ProjectRunnerSettings | null | undefined): string[] => (Array.isArray(s?.shared_areas) ? s.shared_areas.filter((x) => typeof x === "string" && x.trim()) : [...DEFAULT_SHARED_AREAS]);

// A path is covered when an area is the path itself or a folder or glob above it.
export const covers = (area: string, file: string): boolean => {
  const prefix = area.split(/[*?[{]/)[0]!.replace(/\/+$/, "");
  return area === file || (prefix !== "" && (file === prefix || file.startsWith(`${prefix}/`)));
};
export const isShared = (p: string, shared: string[]): boolean => shared.some((s) => covers(s, p) || areasOverlap(s, p));

// Changed paths in a worktree, sorted. [] when it is not a git worktree or git cannot answer.
// PLA-I2-5: base is the project's start branch (startBranchOf).
export async function changedFiles(cwd: string, git: GitFn = defaultGit, base: string = ALLOWED_BASE): Promise<string[]> {
  if (!existsSync(path.join(cwd, ".git"))) return [];
  const found = new Set<string>();
  for (const args of [
    ["diff", "--name-only", `origin/${base}...HEAD`],
    ["diff", "--name-only", "HEAD"],
    ["ls-files", "--others", "--exclude-standard"],
  ]) {
    const out = await git(args, cwd).catch(() => null);
    if (!out || out.code !== 0) continue;
    for (const line of out.stdout.split("\n")) if (line.trim()) found.add(line.trim().replace(/^"|"$/g, ""));
  }
  return [...found].sort();
}

// Many new files in one folder read better as the folder.
const MAX_FILES = 12;
export function areasToAdd(current: string[], files: string[]): string[] {
  const fresh = files.filter((f) => !current.some((a) => covers(a, f)));
  if (fresh.length <= MAX_FILES) return fresh;
  return [...new Set(fresh.map((f) => (f.includes("/") ? `${path.posix.dirname(f)}/**` : f)))].sort();
}

export async function sweepTouched(db: Db, deps: { git?: GitFn } = {}): Promise<{ grown: number }> {
  const rd = readerOf(db);
  const live: { taskId: string; key: string; areas: string[]; cwd: string | null; projectId: string; slug: string; settings: ProjectSettings }[] = [];
  for (const run of await rd.find("agentRuns", { status: ["starting", "running"], role: "taller", lane: "work", worktreePath: notNull() })) {
    if (!run.taskKey) continue;
    const t = await rd.get("tasks", { projectId: run.projectId, key: run.taskKey, kind: "ticket" });
    const p = t ? await rd.get("projects", { id: run.projectId }) : undefined;
    if (t && p) live.push({ taskId: t.id, key: t.key, areas: t.areas, cwd: run.worktreePath, projectId: p.id, slug: p.slug, settings: p.settings });
  }
  let grown = 0;
  for (const r of live) {
    const files = await changedFiles(r.cwd!, deps.git, startBranchOf(r.settings));
    const add = areasToAdd(r.areas ?? [], files);
    if (!add.length) continue;
    await writeTx(db, { id: r.projectId, slug: r.slug }, { actor: SYSTEM_ACTOR, tool: "runner.touched" }, async (tx, emit) => {
      // Derived from the worktree, not an edit: the version stays, so the run's own writes are not refused.
      const uow = uowOf(tx);
      const cur = await uow.get("tasks", { id: r.taskId });
      const areas = [...new Set([...(cur?.areas ?? []), ...add])].sort();
      const [u] = cur ? await uow.update("tasks", { id: r.taskId }, { areas, updatedAt: uow.now }) : [];
      if (u) await emit("task.areas_touched", u, { files: add }, SYSTEM_ACTOR);
    });
    grown += 1;
  }
  return { grown };
}
