// NEWPROJ-7: deleting a project from the screen (DELETE /api/company/projects/:slug, after the owner's code).
// In order:
//   1. Its switch goes off, so nothing new starts while it is being deleted.
//   2. Its live runs are stopped through the runner's own stop path, and waited for (stopProjectRuns).
//   3. Its folders under the worktrees root go: each runner worktree is removed through git in the product repo
//      (`git worktree remove --force`, then `prune`), and <root>/<slug> (scratch folders, the read copy) is deleted.
//      The product repo's own checkout and its branches are never touched.
//   4. In one transaction: its team's agent tokens are revoked, its team (agents.project_id) is deleted, and the
//      project row goes. Run history (agent_runs) cascades with the project, so nothing readable is lost by deleting
//      the agents rather than retiring them, and their slugs (po-<slug>, research-<slug>, ...) are free again. Before
//      this, agents.project_id was set to null on delete and the team stayed as company-level rows that
//      serviceAgent (src/runner/events.ts) could pick as the fallback for another project's work.
//      The store has no foreign keys: the write follows the ON DELETE actions src/db/schema.ts declares itself
//      (deleteCascading), so every row Postgres would have removed or nulled is removed or nulled in that one write.
// Git, the filesystem, the stop and the worktrees root are injected in tests (deleteProjectDeps).
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import type { Db } from "../db/client.js";
import type { Project } from "../db/schema.js";
import { columnsOf, tableNames, tableOf } from "../store/meta.js";
import { storeOf } from "../store/port.js";
import type { TableName, UnitOfWork } from "../store/types.js";
import { stopProjectRuns } from "./runner.js";
import { carefulGit, defaultGit, isInside, repoPathOf, worktreeRoot, type GitFn } from "./worktree.js";

export type DeleteProjectDeps = {
  stop?: (projectId: string, reason: string) => Promise<number>;
  git?: GitFn;
  env?: NodeJS.ProcessEnv;
  worktreeRoot?: string;
  rm?: (dir: string) => void;
};

// The route's deps; tests assign git, the root and the stop here.
export const deleteProjectDeps: DeleteProjectDeps = {};

export type DeletedProject = { deleted: string; stopped: number; worktrees: number; agents: string[] };

const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export async function removeProjectFolders(project: Pick<Project, "slug" | "settings">, deps: DeleteProjectDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const root = path.resolve(deps.worktreeRoot ?? worktreeRoot(env));
  if (!SAFE_SLUG.test(project.slug)) return 0;
  const dir = path.join(root, project.slug);
  const repo = repoPathOf(project.slug, project.settings, env);
  // Never a folder that is the repo or inside it, never the root itself.
  if (!existsSync(dir) || !isInside(dir, root) || path.resolve(dir) === root || isInside(dir, repo) || isInside(repo, dir)) return 0;
  const git = carefulGit(deps.git ?? defaultGit);
  const hasRepo = existsSync(repo);
  let n = 0;
  for (const name of readdirSync(dir)) {
    const wt = path.join(dir, name);
    if (!existsSync(path.join(wt, ".git"))) continue;
    if (hasRepo && (await git(["worktree", "remove", "--force", wt], repo)).code === 0) n += 1;
  }
  (deps.rm ?? ((d: string) => rmSync(d, { recursive: true, force: true })))(dir);
  if (hasRepo) await git(["worktree", "prune"], repo);
  return n;
}

export async function deleteProject(db: Db, project: Project, deps: DeleteProjectDeps = deleteProjectDeps): Promise<DeletedProject> {
  await storeOf(db).write(project.id, {}, (uow) => uow.update("projects", { id: project.id }, { runsPaused: true, runsPausedAt: uow.now, updatedAt: uow.now }));
  const stopped = await (deps.stop ?? stopProjectRuns)(project.id, `project ${project.slug} deleted`);
  const worktrees = await removeProjectFolders(project, deps);
  const team = await storeOf(db).write(project.id, {}, async (uow) => {
    const rows = await uow.find("agents", { projectId: project.id });
    const slugs = rows.map((r) => r.slug);
    if (slugs.length) await uow.update("agentTokens", { agent: slugs, revokedAt: null }, { revokedAt: uow.now, revokedReason: `project ${project.slug} deleted` });
    // The team and the project, with everything their foreign keys would have taken or cleared.
    await deleteCascading(uow, { agents: rows.map((r) => r.id), projects: [project.id] });
    return slugs;
  });
  return { deleted: project.slug, stopped, worktrees, agents: team };
}

// ---- What Postgres's ON DELETE actions did, done by the write

type ForeignKey = { table: TableName; column: string; references: TableName; onDelete: "cascade" | "set null" };

// Every single-column foreign key with an ON DELETE action, read from src/db/schema.ts once. Each points at its
// table's id.
let foreignKeys: ForeignKey[] | null = null;
function foreignKeysOf(): ForeignKey[] {
  if (foreignKeys) return foreignKeys;
  const names = tableNames();
  const nameOf = new Map<PgTable, TableName>(names.map((n) => [tableOf(n), n]));
  const out: ForeignKey[] = [];
  for (const table of names) {
    const prop = new Map(Object.entries(columnsOf(table)).map(([p, c]) => [c.name, p]));
    for (const fk of getTableConfig(tableOf(table)).foreignKeys) {
      if (fk.onDelete !== "cascade" && fk.onDelete !== "set null") continue;
      const ref = fk.reference();
      const references = nameOf.get(ref.foreignTable);
      const column = ref.columns.length === 1 ? prop.get(ref.columns[0]!.name) : undefined;
      if (!references || !column) continue;
      out.push({ table, column, references, onDelete: fk.onDelete });
    }
  }
  return (foreignKeys = out);
}

// Loose calls for a column chosen at run time; the foreign key list ties each column to its table.
type Loose = {
  find(table: TableName, where: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  update(table: TableName, where: Record<string, unknown>, patch: Record<string, unknown>): Promise<unknown[]>;
  delete(table: TableName, where: Record<string, unknown>): Promise<unknown[]>;
};

/** Deletes the root rows (by id) and, through the unit of work, every row a cascade reaches from them, down the
 *  chain (a task's children, a question's delegated answer, an agent's runs); then clears each set-null pointer
 *  left on a row that stays (an event keeps its task_key once its task is gone). */
export async function deleteCascading(uow: UnitOfWork, roots: Partial<Record<TableName, string[]>>): Promise<void> {
  const store = uow as unknown as Loose;
  const keys = foreignKeysOf();
  const gone = new Map<TableName, Set<string>>(keys.map((k) => [k.references, new Set<string>()]));
  for (const [t, ids] of Object.entries(roots) as [TableName, string[]][]) {
    if (!gone.has(t)) gone.set(t, new Set());
    for (const id of ids) gone.get(t)!.add(id);
  }
  // 1. The ids a cascade reaches in every table others point at, until a pass finds nothing new.
  for (let grew = true; grew; ) {
    grew = false;
    for (const k of keys) {
      const ids = gone.get(k.table);
      const parents = gone.get(k.references)!;
      if (!ids || k.onDelete !== "cascade" || !parents.size) continue;
      for (const row of await store.find(k.table, { [k.column]: [...parents] })) {
        const id = row.id as string;
        if (!ids.has(id)) {
          ids.add(id);
          grew = true;
        }
      }
    }
  }
  // 2. Every row a cascade takes (tables nobody points at, by their pointer), then the rows by id, roots included.
  for (const k of keys) {
    const parents = gone.get(k.references)!;
    if (k.onDelete === "cascade" && parents.size && !gone.has(k.table)) await store.delete(k.table, { [k.column]: [...parents] });
  }
  for (const [t, ids] of gone) if (ids.size) await store.delete(t, { id: [...ids] });
  // 3. The set-null pointers on the rows that stay.
  for (const k of keys) {
    const parents = gone.get(k.references)!;
    if (k.onDelete === "set null" && parents.size) await store.update(k.table, { [k.column]: [...parents] }, { [k.column]: null });
  }
}
