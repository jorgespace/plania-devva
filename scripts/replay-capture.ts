// AUDIT-10: write a replay case from a past ticket. Reads the store only; writes one file under replay/cases.
//
// Usage: tsx --env-file=.env scripts/replay-capture.ts <project> <ticket key> [--role taller] [--base-sha <sha>] [--id <id>] [--force]
//
// The case holds what the agent was given and what graded it: the ticket's title, scope and checks, the commit its
// pull request started from, and the project's verify list (settings.qa.verify) as it is today.
// The base commit is where the PR's branch left its base: for a merged PR, the merge-base of its head and the base
// just before the merge; for an open one, the merge-base of its head and the base branch. It is worked out with
// git in the project's local repo, so that repo must have the commits (fetch first). --base-sha skips the lookup.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { closeStore, withDb, type Db } from "../src/db/client.js";
import { findProject, findTask } from "../src/mcp/queries.js";
import { readerOf } from "../src/store/port.js";
import { defaultGit, repoPathOf, type GitFn } from "../src/runner/worktree.js";
import { parseCase, type ReplayCase } from "./replay.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type CaptureOptions = { project: string; key: string; role?: string; baseSha?: string; id?: string };
export type CaptureDeps = { git?: GitFn; env?: NodeJS.ProcessEnv };

// "/Users/owner/Developer/app" → "~/Developer/app": the case file names no user folder.
const tilde = (p: string, home: string): string => (p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length).split(path.sep).join("/")}` : p);

async function baseOf(git: GitFn, repo: string, pr: { headSha: string | null; mergeSha: string | null; baseBranch: string | null }): Promise<string> {
  const sha = async (args: string[]): Promise<string | null> => {
    const r = await git(args, repo);
    const out = r.stdout.trim().split("\n")[0] ?? "";
    return r.code === 0 && /^[0-9a-f]{40}$/.test(out) ? out : null;
  };
  if (pr.mergeSha) {
    // The first parent of the merge is the base as it was when the PR landed.
    const before = await sha(["rev-parse", "--verify", `${pr.mergeSha}^1`]);
    if (before && pr.headSha) return (await sha(["merge-base", pr.headSha, before])) ?? before;
    if (before) return before;
  }
  if (pr.headSha && pr.baseBranch) {
    for (const ref of [`origin/${pr.baseBranch}`, pr.baseBranch]) {
      const base = await sha(["merge-base", pr.headSha, ref]);
      if (base) return base;
    }
  }
  throw new Error("the base commit could not be worked out from the local repo (fetch it, or pass --base-sha)");
}

export async function captureCase(db: Db, input: CaptureOptions, deps: CaptureDeps = {}): Promise<ReplayCase> {
  const git = deps.git ?? defaultGit;
  const env = deps.env ?? process.env;
  const p = await findProject(db, input.project);
  const t = await findTask(db, p.id, input.key);
  if (!t || t.kind !== "ticket") throw new Error(`${input.key} is not a ticket of ${p.slug}`);
  if (!t.scope.trim()) throw new Error(`${t.key} has no scope: there is nothing to ask the run`);
  const verify = (p.settings.qa?.verify ?? []).map((v) => ({ name: v.name, command: v.command, ...(v.timeout_minutes ? { timeout_minutes: v.timeout_minutes } : {}) }));
  if (verify.length === 0) throw new Error(`${p.slug} has no verify list (settings.qa.verify): there is nothing to grade the run with`);

  const repo = repoPathOf(p.slug, p.settings, env);
  let base = input.baseSha?.trim().toLowerCase() ?? null;
  if (!base) {
    // The ticket's PR: the merged one when there is one, else the newest.
    // merged_at desc (no merge first, as Postgres orders nulls in a descending sort), then updated_at desc.
    const time = (d: Date | null) => (d ? d.getTime() : Infinity);
    const prs = (await readerOf(db).find("pullRequests", { taskId: t.id })).sort((a, b) => time(b.mergedAt) - time(a.mergedAt) || b.updatedAt.getTime() - a.updatedAt.getTime());
    const pr = prs.find((x) => x.state === "merged") ?? prs[0];
    if (!pr) throw new Error(`${t.key} has no pull request on record: pass --base-sha`);
    if (!existsSync(repo)) throw new Error(`the project's repo is not on this machine (${tilde(repo, env.HOME || homedir())}): pass --base-sha`);
    base = await baseOf(git, repo, pr);
  }
  const list = await readerOf(db).find("checks", { taskId: t.id }, { orderBy: [{ column: "position" }] });
  return parseCase(
    {
      id: input.id ?? `${p.slug}-${t.key}`.toLowerCase(),
      project: p.slug,
      repo: tilde(repo, env.HOME || homedir()),
      base_sha: base,
      role: input.role ?? "taller",
      title: t.title,
      scope: t.scope,
      // A waived check was never asked of the delivery.
      checks: list.filter((c) => !c.waivedAt).map((c) => c.text),
      verify,
    },
    "captured case",
  );
}

export function writeCase(c: ReplayCase, dir = path.join(ROOT, "replay", "cases"), force = false): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${c.id}.json`);
  if (existsSync(file) && !force) throw new Error(`${file} exists: pass --force to replace it`);
  writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`);
  return file;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { role: { type: "string" }, "base-sha": { type: "string" }, id: { type: "string" }, force: { type: "boolean" } },
  });
  const [project, key] = positionals;
  if (!project || !key || positionals.length !== 2) {
    console.error("Usage: tsx --env-file=.env scripts/replay-capture.ts <project> <ticket key> [--role taller] [--base-sha <sha>] [--id <id>] [--force]");
    process.exit(2);
  }
  try {
    const c = await withDb((db) => captureCase(db, { project, key, role: values.role, baseSha: values["base-sha"], id: values.id }));
    const file = writeCase(c, undefined, values.force);
    console.log(`written: ${file}`);
    console.log(`  ${c.title}`);
    console.log(`  base ${c.base_sha.slice(0, 12)}, ${c.checks.length} checks, verify: ${c.verify.map((v) => v.name).join(", ")}`);
    console.log("Read the scope before you commit the case: it is the ticket's text as written, and it stays in the repo.");
  } finally {
    await closeStore();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
