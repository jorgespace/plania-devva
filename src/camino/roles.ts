// PLA-I68-3: the branch roles agents read from Plania (get_project and start), instead of assuming names: how the
// project publishes, the published branch, the integration branch (where accepted work collects) and the pattern of
// work branches, with where each came from. Only the camino row and the project's settings: no key, no GitHub call.
import type { Db } from "../db/client.js";
import type { Project } from "../db/schema.js";
import { readerOf } from "../store/port.js";
import { effectiveConfig } from "./config.js";

export type BranchRoles = { model: "trunk" | "integ" | "tags"; published: string; integration: string | null; work_pattern: string; source: "camino" | "settings" | "github" | "default" };

export async function branchRoles(db: Db, p: Project): Promise<BranchRoles> {
  const row = await readerOf(db).get("camino", { projectId: p.id });
  const gh = row?.discovery?.github.ok ? { default_branch: row.discovery.github.repo.default_branch, merge: null } : null;
  const c = effectiveConfig(p.settings, row?.config ?? {}, gh);
  return { model: c.model, ...c.branches, source: c.source.branches };
}
