// B3: where the install command, the machine check and the server's start-up check reach Plania's data. Plania keeps
// it in a devva engine (deploy/devva/README.md), found at DEVVA_HOST and DEVVA_PORT and opened with the token in
// DEVVA_TOKEN_FILE. One reading says whether it answers, or why not: no token file, nothing listening, or an engine
// that refused the token; each has its own fix (ui/src/lib/falta.ts). On Postgres this module also tried the usual
// user and asked for a password in the terminal; the engine has neither, so nothing is asked.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { loadClient, type DevvaClient } from "../store/devva.js";
import { defineWords, say } from "../words.js";

/** Why the engine did not answer. absent: the devva client Plania ships (or DEVVA_CLIENT's) is not there. */
export type DevvaFailure = "no_token" | "unreachable" | "bad_token" | "absent";

export type DevvaReading = { ok: true; where: string; lobes: number } | { ok: false; reason: DevvaFailure; where: string; tokenFile: string; message?: string };

/** Reads the engine at an address; never throws. The machine check and the install inject their own in tests. */
export type DevvaProbe = (env: NodeJS.ProcessEnv) => Promise<DevvaReading>;

export type DevvaAddress = { host: string; port: number; tokenFile: string; client: string };

const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const DEFAULT_DEVVA_HOST = "127.0.0.1";
export const DEFAULT_DEVVA_PORT = 2505;
export const defaultTokenFile = (): string => path.join(homedir(), ".config", "plania", "devva-token");

/**
 * The engine an environment names, with the defaults src/store/devva.ts uses. An empty value (a line of .env.example
 * left blank) counts as unset here.
 */
export function devvaAddress(env: NodeJS.ProcessEnv = process.env): DevvaAddress {
  const port = Number(env.DEVVA_PORT?.trim() || DEFAULT_DEVVA_PORT);
  return {
    host: env.DEVVA_HOST?.trim() || DEFAULT_DEVVA_HOST,
    port: Number.isInteger(port) && port > 0 ? port : DEFAULT_DEVVA_PORT,
    tokenFile: env.DEVVA_TOKEN_FILE?.trim() || defaultTokenFile(),
    client: env.DEVVA_CLIENT?.trim() || path.join(ROOT, "vendor", "devva-client", "lib", "index.js"),
  };
}

/** The failure a client error stands for. */
export function devvaFailureOf(e: unknown): DevvaFailure {
  const code = (e as { code?: unknown } | null)?.code;
  const message = e instanceof Error ? e.message : String(e);
  if (code === "ENOENT" || code === "EACCES" || code === "EISDIR") return "no_token";
  if (code === "AUTH_FAILED") return "bad_token";
  if (code === "TIMEOUT") return "unreachable";
  if (code === "CONNECTION_ERROR" && /failed to connect|timed out|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(message)) return "unreachable";
  // Connected, then dropped before answering: the engine closes on a token it refuses (the client's own hint says so).
  if (code === "CONNECTION_ERROR" || code === "PROTOCOL_ERROR") return "bad_token";
  return "unreachable";
}

/** Connects with the token, lists the lobes and closes. Never throws. */
export async function readDevva(env: NodeJS.ProcessEnv = process.env): Promise<DevvaReading> {
  const a = devvaAddress(env);
  const where = `${a.host}:${a.port}`;
  const fail = (reason: DevvaFailure, message?: string): DevvaReading => ({ ok: false, reason, where, tokenFile: a.tokenFile, ...(message ? { message } : {}) });
  if (!existsSync(a.tokenFile)) return fail("no_token");
  if (!existsSync(a.client)) return fail("absent");
  // loadClient puts the token in process.env.DEVVA_TOKEN, which every later connection of this process sends: it is
  // put back once this connection has sent its own, so a probe of another engine never changes the server's.
  const before = process.env.DEVVA_TOKEN;
  let db: DevvaClient | null = null;
  try {
    const connect = await loadClient({ prefix: "", host: a.host, port: a.port, tokenFile: a.tokenFile, clientModule: a.client, timeoutMs: 5_000 });
    db = await connect();
    if (before === undefined) delete process.env.DEVVA_TOKEN;
    else process.env.DEVVA_TOKEN = before;
    return { ok: true, where, lobes: (await db.listLobes()).length };
  } catch (e) {
    return fail(devvaFailureOf(e), e instanceof Error ? e.message : String(e));
  } finally {
    if (before === undefined) delete process.env.DEVVA_TOKEN;
    else process.env.DEVVA_TOKEN = before;
    db?.close();
  }
}

// PLA-I2-1: the start-up check's sentence in the install's language (PLANIA_LANGUAGE or Spanish before the store is
// reachable). On Postgres it also named missing migrations; the store has none.
export const STARTUP_WORDS = defineWords({
  es: {
    noToken: (file: string) => `Falta la clave del motor devva (${file}): créala y enciende el motor como dice deploy/devva/README.md, o escribe su ruta en DEVVA_TOKEN_FILE en .env.`,
    noEngine: (where: string, why: string) => `El motor devva no responde en ${where} (${why}): enciéndelo como dice deploy/devva/README.md y revisa DEVVA_HOST y DEVVA_PORT en .env.`,
    badToken: (where: string, file: string) => `El motor devva en ${where} no aceptó la clave de ${file}: escribe en DEVVA_TOKEN_FILE, en .env, el archivo con el que lo encendiste.`,
    noClient: "Falta el cliente de devva que trae Plania: vuelve a instalar Plania, o escribe en DEVVA_CLIENT la ruta de otro.",
  },
  en: {
    noToken: (file: string) => `The devva engine's token is missing (${file}): create it and start the engine as deploy/devva/README.md says, or write its path in DEVVA_TOKEN_FILE in .env.`,
    noEngine: (where: string, why: string) => `The devva engine is not answering at ${where} (${why}): start it as deploy/devva/README.md says and check DEVVA_HOST and DEVVA_PORT in .env.`,
    badToken: (where: string, file: string) => `The devva engine at ${where} refused the token in ${file}: write in DEVVA_TOKEN_FILE, in .env, the file you started it with.`,
    noClient: "The devva client Plania ships is missing: install Plania again, or write another one's path in DEVVA_CLIENT.",
  },
});

/** One sentence for a reading that is not ok, in the install's language. */
export function devvaProblem(r: DevvaReading): string | null {
  if (r.ok) return null;
  const w = say(STARTUP_WORDS);
  if (r.reason === "no_token") return w.noToken(r.tokenFile);
  if (r.reason === "bad_token") return w.badToken(r.where, r.tokenFile);
  if (r.reason === "absent") return w.noClient;
  return w.noEngine(r.where, (r.message ?? "").split("\n")[0]!.replace(/^\[[A-Z_]+\]\s*/, "").slice(0, 200) || "?");
}

// PLA-I2-1: the start-up check. Null when the server may start; otherwise one sentence for the person running it.
export async function startupProblem(env: NodeJS.ProcessEnv = process.env, probe: DevvaProbe = readDevva): Promise<string | null> {
  return devvaProblem(await probe(env));
}
