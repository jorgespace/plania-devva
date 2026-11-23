// PLA-I2-9: Plania working on Plania. When a project's repo is the running server's own checkout, its runs and its
// test copies must never touch the live server's store (its lobes on the devva engine), and a copy must never run the
// live server's jobs.
// Everything that decides "this project is Plania itself" goes through isSelfProject(), which compares repos on
// disk, never a slug.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/** The running server's own checkout (or release folder). */
export const serverRoot = (): string => path.resolve(import.meta.dirname, "../..");

const real = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};
// Windows and macOS folders are case-insensitive; Linux is not.
const norm = (p: string, platform: NodeJS.Platform): string => {
  const r = real(p).replace(/[\\/]+$/, "");
  return platform === "linux" ? r : r.toLowerCase();
};

/** The git folder a checkout shares with its worktrees: <repo>/.git for the main checkout and every linked worktree. */
export function gitCommonDir(dir: string): string | null {
  const dotGit = path.join(dir, ".git");
  if (!existsSync(dotGit)) return null;
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    // A linked worktree: ".git" is a file "gitdir: <repo>/.git/worktrees/<name>".
    const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (!m) return null;
    const gitdir = path.resolve(dir, m[1]!.trim());
    const common = path.join(gitdir, "commondir");
    if (existsSync(common)) return path.resolve(gitdir, readFileSync(common, "utf8").trim());
    return gitdir;
  } catch {
    return null;
  }
}

/** True when the project's repo is the running server's own checkout, or another worktree of the same repo. */
export function isSelfProject(repo: string | null | undefined, root: string = serverRoot(), platform: NodeJS.Platform = process.platform): boolean {
  if (!repo || !existsSync(repo)) return false;
  if (norm(repo, platform) === norm(root, platform)) return true;
  const a = gitCommonDir(repo);
  const b = gitCommonDir(root);
  return !!a && !!b && norm(a, platform) === norm(b, platform);
}


// ---- the live store
// Plania's data is a store on the devva engine, named by its lobe prefix (PLANIA_DEVVA_PREFIX, default plania). Every
// store on the engine shares it and its token, so what keeps a copy or a run off the live data is its prefix.

/** The live server's store: its lobe prefix. */
export const liveStorePrefix = (liveEnv: NodeJS.ProcessEnv): string => liveEnv.PLANIA_DEVVA_PREFIX?.trim() || "plania";

// ---- a project's Postgres database (the Máquina pages read a product's database address with these)

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);
type Pg = { host: string; port: string; name: string };
function pgOf(url: string | null | undefined): Pg | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
    // A socket path in ?host= is the same server as localhost for this check.
    const host = (u.searchParams.get("host") ? "" : u.hostname).toLowerCase();
    return { host: LOCAL.has(host) ? "local" : host, port: u.port || "5432", name: decodeURIComponent(u.pathname.replace(/^\//, "")) };
  } catch {
    return null;
  }
}

/** True when url points at the same database as live (same server and name). */
export function sameDatabase(url: string | null | undefined, live: string | null | undefined): boolean {
  const a = pgOf(url);
  const b = pgOf(live);
  return !!a && !!b && a.host === b.host && a.port === b.port && a.name === b.name;
}

/** The database's name in a Postgres URL, or null when the URL is missing or not Postgres. */
export const liveDatabaseName = (live: string | null | undefined): string | null => pgOf(live)?.name || null;

// ---- a test copy of Plania

export type CopySuffix = "_prueba" | "_entrega" | `_ini_${string}`;

/** The copy's own store: the live prefix with the suffix, on the same engine. Null when the result is not a prefix. */
export function copyStorePrefix(live: string | null | undefined, suffix: CopySuffix): { name: string } | null {
  if (!live || !/^[a-z_][a-z0-9_]{0,50}$/.test(live)) return null;
  const name = `${live}${suffix}`;
  return /^[a-z_][a-z0-9_]{0,63}$/.test(name) ? { name } : null;
}

// The engine's address and token file, as the live server has them: the copy reaches the same engine.
const ENGINE_VARS = ["DEVVA_HOST", "DEVVA_PORT", "DEVVA_TOKEN_FILE", "DEVVA_CLIENT"] as const;

/** What a test copy of Plania runs with, on top of its env file: its own store on the live server's engine, no jobs,
 * no runs. PLANIA_DEVVA_PREFIX first. */
export function selfCopyEnv(copyPrefix: string, port: number, liveEnv: NodeJS.ProcessEnv = {}): Record<string, string> {
  const engine = Object.fromEntries(ENGINE_VARS.flatMap((k) => (liveEnv[k]?.trim() ? [[k, liveEnv[k]!.trim()]] : [])));
  return {
    PLANIA_DEVVA_PREFIX: copyPrefix,
    ...engine,
    PLANIA_JOBS: "0",
    PLANIA_EVENT_WAKES: "0",
    // Without its token the copy's runner starts nothing.
    PLANIA_RUNNER_TOKEN: "",
    PLANIA_BRIEF_TOKEN: "",
    PLANIA_PORT: String(port),
  };
}

/** The env file text with each override set (every line that sets it, or added at the end). Other lines stay. */
export function rewriteEnvText(text: string, overrides: Record<string, string>): string {
  const want = new Map(Object.entries(overrides));
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/).map((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m || !want.has(m[1]!)) return line;
    seen.add(m[1]!);
    return `${m[1]}=${want.get(m[1]!)}`;
  });
  while (lines.length && lines.at(-1) === "") lines.pop();
  const left = [...want].filter(([k]) => !seen.has(k));
  if (left.length) lines.push("# PLA-I2-9: a test copy of Plania: its own store, no jobs, no runs.", ...left.map(([k, v]) => `${k}=${v}`));
  return `${lines.join("\n")}\n`;
}

/** The value an env file's text gives a variable (its last line that sets it), unquoted; null when none does. */
export function envFileValue(text: string, name: string): string | null {
  let found: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = new RegExp(`^\s*(?:export\s+)?${name}\s*=\s*(.*)$`).exec(line);
    if (m) found = m[1]!.trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return found;
}

// ---- a run of the Plania project

/** One sentence when a run of the Plania project would reach the live store, else null: a variable of the run that
 * names the live store (PLANIA_DEVVA_PREFIX) or carries the engine's token (DEVVA_TOKEN), or an env file in the run's
 * folder that leaves a server started there on the live store (the prefix set to it, or, when the live store is the
 * default one, not set at all). liveEnv is the live server's environment. */
export function selfRunProblem(runEnv: NodeJS.ProcessEnv, cwd: string | null, liveEnv: NodeJS.ProcessEnv): string | null {
  const live = liveStorePrefix(liveEnv);
  for (const [k, v] of Object.entries(runEnv)) {
    if (k === "PLANIA_DEVVA_PREFIX" && (v?.trim() || "plania") === live) return `the run's ${k} points at the live store`;
    if (k === "DEVVA_TOKEN" && v?.trim()) return `the run's ${k} carries the devva engine's token`;
  }
  if (cwd) {
    for (const f of [".env", ".env.local", ".env.development"]) {
      const p = path.join(cwd, f);
      if (!existsSync(p)) continue;
      try {
        const prefix = envFileValue(readFileSync(p, "utf8"), "PLANIA_DEVVA_PREFIX");
        // Plania's scripts read .env (--env-file=.env): one that names no prefix leaves a server on the default store.
        if (prefix === null && f !== ".env") continue;
        if ((prefix || "plania") === live) return `${f} in the run's folder points at the live store`;
      } catch {
        // unreadable: nothing the run can read either
      }
    }
  }
  return null;
}
