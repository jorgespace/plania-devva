// PLA-I2-12: the machine check's words. One list, read by the install command (`pnpm machine:check`, the
// installer's hook) and by the screen page (/machine/falta) through GET /api/machine-check, so both say the same
// thing. Pure: no "@/" imports, because the server imports this file (src/machine-check/).
// PLA-I2-10: in both languages; the server passes the install's language (src/language.ts).
// Plania keeps its data in a devva engine (deploy/devva/README.md): the item that was Postgres is the engine now, and
// pg_dump is optional, for the test copies of a project's own Postgres database (Plania's backup is devva's).
import { defineWords, getLanguage, words, type Language } from "./i18n.js";

/** Every item the check reports, in the order it is shown. */
export const MACHINE_ITEMS = ["node", "devva", "git", "gh", "claude", "claude_session", "pg_dump", "disk", "memory", "chrome"] as const;
export type MachineItemId = (typeof MACHINE_ITEMS)[number];

/** ready: there and working. missing: required and not ready (the install stops). optional: not there, not needed. */
export type MachineState = "ready" | "missing" | "optional";

export type MachineReason =
  | "ok"
  | "absent" // the program is not installed
  | "old" // installed, older than Plania needs
  | "unreachable" // the devva engine did not answer: not running, or another address (connection refused or timed out)
  | "no_token" // B3: the file with the engine's token (DEVVA_TOKEN_FILE) is not there
  | "bad_token" // B3: the engine answered and refused the token
  | "signed_out" // gh or Claude without a session
  | "no_write" // gh signed in, but its token cannot write to repositories
  | "low" // too little disk or memory
  | "not_checked" // Claude's session cannot be checked without Claude
  | "failed"; // the short Claude run ended with another error

export type MachineDetail = {
  version?: string | null;
  need?: string;
  server?: string | null;
  gb?: number;
  needGb?: number;
  subtype?: string;
};

export const MIN_NODE_MAJOR = 22;
export const MIN_FREE_DISK_GB = 10;
export const MIN_MEMORY_GB = 8;

const v = (d: MachineDetail) => (d.version ? ` ${d.version}` : "");
const gbOf = (d: MachineDetail) => d.gb ?? "?";
const at = (d: MachineDetail) => (d.server ? ` en ${d.server}` : "");
const atEn = (d: MachineDetail) => (d.server ? ` at ${d.server}` : "");

type Said = { sentence: string; fix: string | null };

// PLA-I2-10: the check's words in both languages. The install command and the server pass the install's language;
// the screen reads its own (lib/i18n.ts).
export const FALTA = defineWords({
  es: {
    names: {
      node: "Node",
      devva: "Motor devva, donde Plania guarda sus datos",
      git: "git",
      gh: "GitHub (gh)",
      claude: "Claude Code",
      claude_session: "Sesión de Claude",
      pg_dump: "pg_dump, para las copias de prueba con base Postgres",
      disk: "Espacio en disco",
      memory: "Memoria",
      chrome: "Chrome, para las fotos de pantalla",
    } as Record<MachineItemId, string>,
    states: { ready: "Lista", missing: "Falta", optional: "Opcional" } as Record<MachineState, string>,
    ok: {
      node: (d: MachineDetail) => `Node${v(d)} está instalado.`,
      devva: (d: MachineDetail) => `El motor devva responde${at(d)}.`,
      git: (d: MachineDetail) => `git${v(d)} está instalado.`,
      gh: (d: MachineDetail) => `gh${v(d)} tiene la sesión iniciada y puede escribir en tus repositorios.`,
      claude: (d: MachineDetail) => `Claude Code${v(d)} está instalado.`,
      claude_session: () => "Claude tiene la sesión iniciada: una prueba corta respondió.",
      pg_dump: (d: MachineDetail) => `pg_dump${v(d)} está instalado.`,
      disk: (d: MachineDetail) => `Hay ${gbOf(d)} GB libres.`,
      memory: (d: MachineDetail) => `La máquina tiene ${gbOf(d)} GB de memoria.`,
      chrome: () => "Chrome está instalado.",
    } as Record<MachineItemId, (d: MachineDetail) => string>,
    nodeOld: (d: MachineDetail): Said => ({ sentence: `Node${v(d)} es muy viejo: Plania necesita Node ${MIN_NODE_MAJOR} o más nuevo.`, fix: "Instala Node 22 o más nuevo: https://nodejs.org/en/download" }),
    nodeAbsent: { sentence: "Node no está instalado.", fix: "Instala Node 22 o más nuevo: https://nodejs.org/en/download" } as Said,
    devvaDown: (d: MachineDetail): Said => ({
      sentence: `El motor devva no responde${at(d)}: no está encendido.`,
      fix: "Enciéndelo como dice deploy/devva/README.md (docker compose -f deploy/devva/compose.yml up -d), o corrige DEVVA_HOST y DEVVA_PORT en .env.",
    }),
    // B3: the token is missing, or the engine answered and said no; each has its own fix.
    devvaNoToken: {
      sentence: "Falta el archivo con la clave del motor devva.",
      fix: "Créalo y enciende el motor con él como dice deploy/devva/README.md, o escribe su ruta en DEVVA_TOKEN_FILE en .env.",
    } as Said,
    devvaBadToken: (d: MachineDetail): Said => ({
      sentence: `El motor devva responde${at(d)}, pero no aceptó la clave.`,
      fix: "Escribe en DEVVA_TOKEN_FILE, en .env, el archivo con el que encendiste el motor.",
    }),
    devvaNoClient: { sentence: "Falta el cliente de devva que trae Plania.", fix: "Vuelve a bajar Plania, o escribe en DEVVA_CLIENT la ruta de otro cliente." } as Said,
    gitAbsent: { sentence: "git no está instalado.", fix: "Instala git: https://git-scm.com/downloads" } as Said,
    // F2: gh is not needed to install, only before the first project with code.
    ghSignedOut: { sentence: "gh está instalado pero no tiene la sesión iniciada; hace falta antes del primer proyecto con código.", fix: "En una terminal corre: gh auth login" } as Said,
    ghNoWrite: { sentence: "gh tiene la sesión iniciada, pero sin permiso para escribir en tus repositorios; hace falta antes del primer proyecto con código.", fix: "En una terminal corre: gh auth refresh -s repo" } as Said,
    ghAbsent: { sentence: "gh, la herramienta de GitHub, no está instalada; hace falta antes del primer proyecto con código.", fix: "Instálala: https://cli.github.com" } as Said,
    claudeAbsent: { sentence: "Claude Code no está instalado.", fix: "Instálalo: https://docs.claude.com/en/docs/claude-code/setup (o escribe su ruta en CLAUDE_CODE_BIN)" } as Said,
    sessionNotChecked: { sentence: "No se pudo revisar la sesión de Claude porque Claude Code no está instalado.", fix: "Instala Claude Code primero." } as Said,
    sessionFailed: (d: MachineDetail): Said => ({ sentence: `La prueba corta de Claude terminó con un error${d.subtype ? ` (${d.subtype})` : ""}.`, fix: "En una terminal corre claude y revisa que responda." }),
    sessionSignedOut: { sentence: "Claude no tiene la sesión iniciada en esta máquina.", fix: "En una terminal corre claude y entra con tu cuenta (/login)." } as Said,
    dumpAbsent: {
      sentence: "pg_dump no está instalado: no habrá copias de prueba de las bases Postgres de tus proyectos; todo lo demás funciona.",
      fix: "Instala las herramientas de Postgres de la versión de tus bases: https://www.postgresql.org/download/ (o escribe su carpeta en PLANIA_PG_BIN)",
    } as Said,
    diskLow: (d: MachineDetail): Said => ({ sentence: `Quedan ${gbOf(d)} GB libres; Plania necesita al menos ${MIN_FREE_DISK_GB} GB para copias de trabajo y respaldos.`, fix: "Libera espacio en el disco." }),
    memoryLow: (d: MachineDetail): Said => ({ sentence: `La máquina tiene ${gbOf(d)} GB de memoria; Plania necesita al menos ${MIN_MEMORY_GB} GB.`, fix: "Usa una máquina con más memoria." }),
    chromeAbsent: { sentence: "Chrome no está instalado: no habrá fotos de pantalla, todo lo demás funciona.", fix: "Instálalo: https://www.google.com/chrome/ (o escribe su ruta en PLANIA_CHROME_PATH)" } as Said,
    headline: (missing: number) =>
      missing === 0 ? "Esta máquina tiene todo lo que Plania necesita." : missing === 1 ? "A esta máquina le falta una cosa." : `A esta máquina le faltan ${missing} cosas.`,
    /** The install command's mark after an optional item. */
    optionalMark: " (opcional)",
    // The page (/machine/falta).
    kicker: "Esta máquina",
    title: "Qué le falta",
    lead: "Lo que Plania necesita para trabajar aquí, y cómo arreglar lo que falta.",
    failed: "No se pudo revisar la máquina.",
    again: "Revisar otra vez",
    optional: "opcional",
    checkedAt: (time: string) => `Revisada: ${time}`,
  },
  en: {
    names: {
      node: "Node",
      devva: "devva engine, where Plania keeps its data",
      git: "git",
      gh: "GitHub (gh)",
      claude: "Claude Code",
      claude_session: "Claude session",
      pg_dump: "pg_dump, for test copies with a Postgres database",
      disk: "Disk space",
      memory: "Memory",
      chrome: "Chrome, for screenshots",
    },
    states: { ready: "Ready", missing: "Missing", optional: "Optional" },
    ok: {
      node: (d: MachineDetail) => `Node${v(d)} is installed.`,
      devva: (d: MachineDetail) => `The devva engine is answering${atEn(d)}.`,
      git: (d: MachineDetail) => `git${v(d)} is installed.`,
      gh: (d: MachineDetail) => `gh${v(d)} is signed in and can write to your repositories.`,
      claude: (d: MachineDetail) => `Claude Code${v(d)} is installed.`,
      claude_session: () => "Claude is signed in: a short test answered.",
      pg_dump: (d: MachineDetail) => `pg_dump${v(d)} is installed.`,
      disk: (d: MachineDetail) => `${gbOf(d)} GB free.`,
      memory: (d: MachineDetail) => `The machine has ${gbOf(d)} GB of memory.`,
      chrome: () => "Chrome is installed.",
    },
    nodeOld: (d: MachineDetail): Said => ({ sentence: `Node${v(d)} is too old: Plania needs Node ${MIN_NODE_MAJOR} or newer.`, fix: "Install Node 22 or newer: https://nodejs.org/en/download" }),
    nodeAbsent: { sentence: "Node is not installed.", fix: "Install Node 22 or newer: https://nodejs.org/en/download" },
    devvaDown: (d: MachineDetail): Said => ({
      sentence: `The devva engine is not answering${atEn(d)}: it is not running.`,
      fix: "Start it as deploy/devva/README.md says (docker compose -f deploy/devva/compose.yml up -d), or fix DEVVA_HOST and DEVVA_PORT in .env.",
    }),
    devvaNoToken: {
      sentence: "The file with the devva engine's token is missing.",
      fix: "Create it and start the engine with it as deploy/devva/README.md says, or write its path in DEVVA_TOKEN_FILE in .env.",
    },
    devvaBadToken: (d: MachineDetail): Said => ({
      sentence: `The devva engine is answering${atEn(d)}, but did not accept the token.`,
      fix: "Write in DEVVA_TOKEN_FILE, in .env, the file you started the engine with.",
    }),
    devvaNoClient: { sentence: "The devva client Plania ships is missing.", fix: "Download Plania again, or write another client's path in DEVVA_CLIENT." },
    gitAbsent: { sentence: "git is not installed.", fix: "Install git: https://git-scm.com/downloads" },
    ghSignedOut: { sentence: "gh is installed but not signed in; it is needed before the first project with code.", fix: "In a terminal run: gh auth login" },
    ghNoWrite: { sentence: "gh is signed in, but cannot write to your repositories; it is needed before the first project with code.", fix: "In a terminal run: gh auth refresh -s repo" },
    ghAbsent: { sentence: "gh, the GitHub tool, is not installed; it is needed before the first project with code.", fix: "Install it: https://cli.github.com" },
    claudeAbsent: { sentence: "Claude Code is not installed.", fix: "Install it: https://docs.claude.com/en/docs/claude-code/setup (or write its path in CLAUDE_CODE_BIN)" },
    sessionNotChecked: { sentence: "Claude's session could not be checked because Claude Code is not installed.", fix: "Install Claude Code first." },
    sessionFailed: (d: MachineDetail): Said => ({ sentence: `Claude's short test ended with an error${d.subtype ? ` (${d.subtype})` : ""}.`, fix: "In a terminal run claude and check that it answers." }),
    sessionSignedOut: { sentence: "Claude is not signed in on this machine.", fix: "In a terminal run claude and sign in with your account (/login)." },
    dumpAbsent: {
      sentence: "pg_dump is not installed: there will be no test copies of your projects' Postgres databases; everything else works.",
      fix: "Install the Postgres tools of your databases' version: https://www.postgresql.org/download/ (or write their folder in PLANIA_PG_BIN)",
    },
    diskLow: (d: MachineDetail): Said => ({ sentence: `${gbOf(d)} GB free; Plania needs at least ${MIN_FREE_DISK_GB} GB for working copies and backups.`, fix: "Free up disk space." }),
    memoryLow: (d: MachineDetail): Said => ({ sentence: `The machine has ${gbOf(d)} GB of memory; Plania needs at least ${MIN_MEMORY_GB} GB.`, fix: "Use a machine with more memory." }),
    chromeAbsent: { sentence: "Chrome is not installed: there will be no screenshots, everything else works.", fix: "Install it: https://www.google.com/chrome/ (or write its path in PLANIA_CHROME_PATH)" },
    headline: (missing: number) =>
      missing === 0 ? "This machine has everything Plania needs." : missing === 1 ? "This machine is missing one thing." : `This machine is missing ${missing} things.`,
    optionalMark: " (optional)",
    kicker: "This machine",
    title: "What it is missing",
    lead: "What Plania needs to work here, and how to fix what is missing.",
    failed: "The machine could not be checked.",
    again: "Check again",
    optional: "optional",
    checkedAt: (time: string) => `Checked: ${time}`,
  },
});

/** The item names in Spanish (kept for older readers; words(FALTA).names is the screen's language). */
export const ITEM_NAME: Record<MachineItemId, string> = FALTA.es.names;

/** Chrome, gh (F2: needed only before the first project with code) and pg_dump (only for the test copies of a project's
 * Postgres database) can be missing without stopping the install. */
export const REQUIRED: Record<MachineItemId, boolean> = {
  node: true,
  devva: true,
  git: true,
  gh: false,
  claude: true,
  claude_session: true,
  pg_dump: false,
  disk: true,
  memory: true,
  chrome: false,
};

/** The state words in Spanish (kept for older readers; words(FALTA).states is the screen's language). */
export const STATE_WORD: Record<MachineState, string> = FALTA.es.states;

/** One plain sentence and the fix (a link or the exact step; null when there is nothing to do). */
export function machineWords(id: MachineItemId, reason: MachineReason, d: MachineDetail = {}, language: Language = getLanguage()): Said {
  const w = words(FALTA, language);
  if (reason === "ok") return { sentence: w.ok[id](d), fix: null };
  switch (id) {
    case "node":
      return reason === "old" ? w.nodeOld(d) : w.nodeAbsent;
    case "devva":
      if (reason === "no_token") return w.devvaNoToken;
      if (reason === "bad_token") return w.devvaBadToken(d);
      if (reason === "absent") return w.devvaNoClient;
      return w.devvaDown(d);
    case "git":
      return w.gitAbsent;
    case "gh":
      if (reason === "signed_out") return w.ghSignedOut;
      if (reason === "no_write") return w.ghNoWrite;
      return w.ghAbsent;
    case "claude":
      return w.claudeAbsent;
    case "claude_session":
      if (reason === "not_checked") return w.sessionNotChecked;
      if (reason === "failed") return w.sessionFailed(d);
      return w.sessionSignedOut;
    case "pg_dump":
      return w.dumpAbsent;
    case "disk":
      return w.diskLow(d);
    case "memory":
      return w.memoryLow(d);
    case "chrome":
      return w.chromeAbsent;
  }
}

export type MachineItem = {
  id: MachineItemId;
  state: MachineState;
  required: boolean;
  reason: MachineReason;
  name: string;
  sentence: string;
  fix: string | null;
};

/** GET /api/machine-check. ready: nothing required is missing. */
export type MachineCheckReading = { items: MachineItem[]; ready: boolean; checked_at: string };

/** The item as both outputs show it: state from ready-or-not and REQUIRED, words from machineWords. */
export function machineItem(id: MachineItemId, reason: MachineReason, d: MachineDetail = {}, language: Language = getLanguage()): MachineItem {
  const required = REQUIRED[id];
  const state: MachineState = reason === "ok" ? "ready" : required ? "missing" : "optional";
  return { id, state, required, reason, name: words(FALTA, language).names[id], ...machineWords(id, reason, d, language) };
}

/** The page's headline: how many required items are missing. */
export function machineHeadline(items: Pick<MachineItem, "state">[], language: Language = getLanguage()): string {
  return words(FALTA, language).headline(items.filter((i) => i.state === "missing").length);
}

/** Splits a fix into text and one link, so the page can make the link clickable. */
export function fixParts(fix: string): { before: string; url: string | null; after: string } {
  const m = /https?:\/\/[^\s)]+/.exec(fix);
  if (!m) return { before: fix, url: null, after: "" };
  return { before: fix.slice(0, m.index), url: m[0], after: fix.slice(m.index + m[0].length) };
}
