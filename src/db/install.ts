// PLA-I2-1: the install command's core. On a new machine: machine check, check that the devva engine answers, write
// the settings file with generated secrets, leave the built screen in place. No hand edit of .env.
//
// Plania's data lives in a devva engine (deploy/devva/README.md) under a lobe prefix (PLANIA_DEVVA_PREFIX, default
// plania). The install starts no engine and makes no database: an engine that does not answer stops it with one
// sentence on how to start one. There are no migrations: the store takes its shape from src/db/schema.ts, and the
// server adds the fixed rows when it opens it (src/store/seed.ts).
//
// Never on the owner's data: a store that already holds commits is used only when the settings file already names
// its prefix (this command made it, and this is a re-run) or when its prefix was given on the command line.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import type { Db } from "./client.js";
import { devvaAddress, readDevva, type DevvaProbe } from "../install/connect.js";
import { newInstallSettings } from "../runner/isolation.js";
import { writeVia } from "../runner/limits.js";
import { DevvaStore } from "../store/devva.js";
import { hashSetupCode, newSetupCode } from "../install-state.js";
import { defineWords, say } from "../words.js";

// PLA-I2-10: what the install command says, in the install's language (PLANIA_LANGUAGE or Spanish before the
// store is reachable).
export const INSTALL_WORDS = defineWords({
  es: {
    machineCheck: "La revisión de la máquina encontró algo que arreglar antes de instalar.",
    noEngine: (where: string, why: string) => `No se pudo conectar con el motor devva en ${where} (${why}): enciéndelo como dice deploy/devva/README.md (docker compose -f deploy/devva/compose.yml up -d) y vuelve a correr la instalación.`,
    noToken: (file: string) => `No encuentro la clave del motor devva en ${file}: créala y enciende el motor con ella como dice deploy/devva/README.md (o escribe su ruta en DEVVA_TOKEN_FILE), y vuelve a correr la instalación.`,
    badToken: (where: string, file: string) => `El motor devva en ${where} no aceptó la clave de ${file}: usa el archivo con el que lo encendiste (DEVVA_TOKEN_FILE) y vuelve a correr la instalación.`,
    noClient: "Falta el cliente de devva que trae Plania: vuelve a bajar Plania, o escribe en DEVVA_CLIENT la ruta de otro.",
    badName: (name: string) => `${name} no sirve como nombre del almacén: usa minúsculas, números o guion bajo.`,
    created: (name: string) => `Almacén ${name} listo en el motor devva.`,
    exists: (name: string) => `El almacén ${name} ya tiene datos y no lo hizo la instalación: si es el que quieres usar, nómbralo con --prefix ${name}.`,
    settings: (file: string, keys: string[]) => `Ajustes escritos en ${file}: ${keys.join(", ")}.`,
    building: "Construyendo la pantalla…",
    buildFailed: "No se pudo construir la pantalla; arriba está lo que dijo la herramienta.",
  },
  en: {
    machineCheck: "The machine check found something to fix before installing.",
    noEngine: (where: string, why: string) => `Could not connect to the devva engine at ${where} (${why}): start it as deploy/devva/README.md says (docker compose -f deploy/devva/compose.yml up -d), then run the install again.`,
    noToken: (file: string) => `The devva engine's token is not in ${file}: create it and start the engine with it as deploy/devva/README.md says (or write its path in DEVVA_TOKEN_FILE), then run the install again.`,
    badToken: (where: string, file: string) => `The devva engine at ${where} refused the token in ${file}: use the file you started it with (DEVVA_TOKEN_FILE), then run the install again.`,
    noClient: "The devva client Plania ships is missing: download Plania again, or write another one's path in DEVVA_CLIENT.",
    badName: (name: string) => `${name} cannot name the store: use lowercase letters, numbers or underscores.`,
    created: (name: string) => `Store ${name} ready on the devva engine.`,
    exists: (name: string) => `The store ${name} already holds data and the install did not make it: if it is the one you want to use, name it with --prefix ${name}.`,
    settings: (file: string, keys: string[]) => `Settings written to ${file}: ${keys.join(", ")}.`,
    building: "Building the screen…",
    buildFailed: "The screen could not be built; what the tool said is above.",
  },
});

// The machine check (PLA-I2-12) is built in its own module; the install command passes it in. ok false stops the
// install before anything is created, and its lines are printed as they are.
export type MachineCheck = () => Promise<{ ok: boolean; lines: string[] }>;
export const noMachineCheck: MachineCheck = async () => ({ ok: true, lines: [] });

export const DEFAULT_PREFIX = "plania";

export class InstallError extends Error {}

/** The store the install opens: commits it holds, a handle for the setup code, and close. */
export type InstallStore = { readonly handle: Db; readonly commits: number; close(): void };

export type InstallOptions = {
  // The lobe prefix of the store to install into (PLANIA_DEVVA_PREFIX).
  prefix: string;
  // The prefix came from the command line (--prefix).
  named: boolean;
  envPath: string;
  examplePath?: string;
  // The engine's settings (DEVVA_HOST, DEVVA_PORT, DEVVA_TOKEN_FILE, DEVVA_CLIENT); process.env by default.
  env?: NodeJS.ProcessEnv;
  machineCheck?: MachineCheck;
  // Leaves dist/ui in place; the CLI builds it when missing, a pre-built package already has it.
  buildScreen?: () => Promise<void>;
  secret?: (bytes: number, encoding: "hex" | "base64") => string;
  // PLA-I2-2: the one-time code for the first-start screen (tests pass a fixed one).
  setupCode?: () => string;
  // F1: the tool paths found on this machine (PLANIA_PG_BIN for the projects' test copies, PLANIA_CHROME_PATH).
  // Written to the settings file only where no value is set.
  tools?: () => Record<string, string>;
  // Whether the engine answers (readDevva by default) and the store on the prefix (DevvaStore.open). Tests inject.
  probe?: DevvaProbe;
  open?: (prefix: string, env: NodeJS.ProcessEnv) => Promise<InstallStore>;
  log?: (line: string) => void;
};

// setupCode: the one-time code for the first-start screen, printed once; null when an owner already exists.
// created: the store held no commits before this install.
export type InstallResult = { store: string; created: boolean; envKeys: string[]; setupCode: string | null };

const defaultSecret = (bytes: number, encoding: "hex" | "base64") => randomBytes(bytes).toString(encoding);

/** A lobe prefix the install and the restore accept: lower case, digits, underscore. Anything else is refused. */
export const isStorePrefix = (name: string): boolean => /^[a-z_][a-z0-9_]{0,50}$/.test(name);

// The store on the prefix, on the engine the environment names. Opening it declares its lobes; the server adds the
// fixed rows when it opens it (src/store/open.ts), so the install writes only the setup code.
async function openInstallStore(prefix: string, env: NodeJS.ProcessEnv): Promise<InstallStore> {
  const a = devvaAddress(env);
  const store = await DevvaStore.open({ prefix, host: a.host, port: a.port, tokenFile: a.tokenFile, clientModule: a.client });
  return { handle: store.handle, commits: store.commits, close: () => store.close() };
}

export async function install(opts: InstallOptions): Promise<InstallResult> {
  const log = opts.log ?? (() => {});
  const w = say(INSTALL_WORDS);
  const env = opts.env ?? process.env;
  const check = await (opts.machineCheck ?? noMachineCheck)();
  for (const line of check.lines) log(line);
  if (!check.ok) throw new InstallError(w.machineCheck);

  const name = opts.prefix;
  if (!isStorePrefix(name)) throw new InstallError(w.badName(name));

  // The engine: reachable, and with the token this machine has.
  const reading = await (opts.probe ?? readDevva)(env);
  if (!reading.ok) {
    if (reading.reason === "no_token") throw new InstallError(w.noToken(reading.tokenFile));
    if (reading.reason === "bad_token") throw new InstallError(w.badToken(reading.where, reading.tokenFile));
    if (reading.reason === "absent") throw new InstallError(w.noClient);
    throw new InstallError(w.noEngine(reading.where, (reading.message ?? "").split("\n")[0]!.replace(/^\[[A-Z_]+\]\s*/, "").slice(0, 200) || "?"));
  }

  // A re-run: the settings file already names this store.
  const fileEnv = existsSync(opts.envPath) ? parseEnv(readFileSync(opts.envPath, "utf8")) : {};
  const rerun = (fileEnv.PLANIA_DEVVA_PREFIX?.trim() || "") === name;

  let store: InstallStore;
  try {
    store = await (opts.open ?? openInstallStore)(name, env);
  } catch (e) {
    throw new InstallError(w.noEngine(reading.where, (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200)));
  }
  let envKeys: string[];
  let setupCode: string | null = null;
  const created = store.commits === 0;
  try {
    if (!created && !opts.named && !rerun) throw new InstallError(w.exists(name));
    if (created) log(w.created(name));
    const a = devvaAddress(env);
    // The engine the install reached, so the server finds the same one; an empty line of .env.example is filled.
    const engine = { DEVVA_HOST: a.host, DEVVA_PORT: String(a.port), DEVVA_TOKEN_FILE: a.tokenFile };
    envKeys = writeSettings(opts.envPath, opts.examplePath, name, opts.secret ?? defaultSecret, { ...engine, ...(opts.tools?.() ?? {}) });
    if (envKeys.length > 0) log(w.settings(opts.envPath, envKeys));
    setupCode = await issueSetupCode(store.handle, opts.envPath, opts.setupCode ?? newSetupCode);
  } finally {
    store.close();
  }
  if (opts.buildScreen) await opts.buildScreen();
  return { store: name, created, envKeys, setupCode };
}

// PLA-I2-2: while no owner exists (no PLANIA_PASSWORD_HASH in the settings file, no password from first start), a
// new one-time code replaces any earlier one; only its sha256 is stored. Each run prints a fresh code, so a lost
// one is fixed by running the install again. Once the owner exists there is no code to give.
export async function issueSetupCode(db: Db, envPath: string, make: () => string): Promise<string | null> {
  const env = existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {};
  if (env.PLANIA_PASSWORD_HASH?.trim()) return null;
  const code = make();
  // install_state belongs to no project: a company write. Writes are serialized, so a first start that finished
  // meanwhile is seen here and keeps its password.
  const issued = await writeVia(db, async (uow) => {
    const row = await uow.get("installState", { id: 1 });
    if (!row) {
      await uow.insert("installState", { id: 1, setupCodeHash: hashSetupCode(code), setupCodeAt: uow.now });
      return true;
    }
    if (row.passwordHash) return false;
    await uow.update("installState", { id: 1 }, { setupCodeHash: hashSetupCode(code), setupCodeAt: uow.now, updatedAt: uow.now });
    return true;
  });
  return issued ? code : null;
}

// Writes the settings file: starts from .env.example when there is no .env, sets PLANIA_DEVVA_PREFIX to the
// installed store, and generates the secrets that are empty. A value already set is never replaced (except the
// prefix). F1: `found` adds what the install found (the engine it reached: DEVVA_HOST, DEVVA_PORT, DEVVA_TOKEN_FILE;
// and the tool paths PLANIA_PG_BIN, PLANIA_CHROME_PATH) under the same rule. Returns the keys it wrote.
export function writeSettings(
  envPath: string,
  examplePath: string | undefined,
  prefix: string,
  secret: (bytes: number, encoding: "hex" | "base64") => string,
  found: Record<string, string> = {},
): string[] {
  const text = existsSync(envPath)
    ? readFileSync(envPath, "utf8")
    : examplePath && existsSync(examplePath)
      ? readFileSync(examplePath, "utf8")
      : "";
  const lines = text.split(/\r?\n/);
  const isNew = !existsSync(envPath);
  const wanted: Array<[string, (current: string) => string | null]> = [
    ["PLANIA_DEVVA_PREFIX", (cur) => (cur === prefix ? null : prefix)],
    ["SESSION_SECRET", (cur) => (cur ? null : secret(48, "base64"))],
    ["MCP_BEARER_TOKEN", (cur) => (cur ? null : secret(32, "hex"))],
    // PLA-I2-7: a new install starts with run isolation on; an existing .env is left as it is.
    ...Object.entries(newInstallSettings()).map(([key, value]): [string, (current: string) => string | null] => [key, (cur) => (isNew && !cur ? value : null)]),
    ...Object.entries(found)
      .filter(([, value]) => value.trim())
      .map(([key, value]): [string, (current: string) => string | null] => [key, (cur) => (cur ? null : value)]),
  ];
  const written: string[] = [];
  for (const [key, next] of wanted) {
    const i = lines.findIndex((l) => l.startsWith(`${key}=`));
    const current = i >= 0 ? unquote(lines[i]!.slice(key.length + 1)) : "";
    const value = next(current);
    if (value === null) continue;
    const line = `${key}=${value}`;
    if (i >= 0) lines[i] = line;
    else lines.push(line);
    written.push(key);
  }
  if (written.length > 0 || !existsSync(envPath)) {
    const out = lines.join("\n").replace(/\n*$/, "\n");
    // The file holds secrets: readable by its owner only (ignored on Windows).
    writeFileSync(envPath, out, { mode: 0o600 });
  }
  return written;
}

function unquote(v: string): string {
  const t = v.trim();
  return /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t;
}
