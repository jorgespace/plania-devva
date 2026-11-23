// PLA-I2-9: a test copy of Plania itself (src/captures/prueba.ts calls these when isSelfProject). The copy gets a new
// store of its own on the live server's devva engine (its own lobe prefix, <live><suffix>), emptied before it starts,
// never a copy of the live one; the copy's server adds the fixed rows when it opens it. Its env file is rewritten so it
// points there with jobs and runs off, and it is refused if anything would still point it at the live store or the
// live server's port.
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { DevvaStore } from "../store/devva.js";
import { copyStorePrefix, envFileValue, liveStorePrefix, rewriteEnvText, selfCopyEnv, type CopySuffix } from "./plania-self.js";
import { defineWords, say } from "../words.js";

// PLA-I2-10: why a test copy of Plania is not started, in the install's language.
export const SELF_COPY_WORDS = defineWords({
  es: {
    noLive: "No sé cuál es el almacén del Plania que estás usando, así que no enciendo la copia.",
    noOwnDb: "La copia de Plania no tendría un almacén propio; no la enciendo.",
    buildFailed: (name: string, error: string) => `No se pudo preparar el almacén de la copia (${name}): ${error}`,
    livePort: "La copia de Plania usaría el puerto del Plania que estás usando; no la enciendo.",
    liveDb: "La copia de Plania apuntaría a los datos del Plania que estás usando; no la enciendo.",
    jobsOn: "La copia de Plania tendría sus trabajos de fondo encendidos; no la enciendo.",
  },
  en: {
    noLive: "I do not know which store the Plania you are using has, so I do not start the copy.",
    noOwnDb: "The Plania copy would not have a store of its own; I do not start it.",
    buildFailed: (name: string, error: string) => `The copy's store could not be prepared (${name}): ${error}`,
    livePort: "The Plania copy would use the port of the Plania you are using; I do not start it.",
    liveDb: "The Plania copy would point at the data of the Plania you are using; I do not start it.",
    jobsOn: "The Plania copy would have its background jobs on; I do not start it.",
  },
});

export type Built = { ok: true } | { ok: false; error: string };
/** Empties the copy's store (its lobes on the live server's engine), so the copy starts on a new one. Injected in tests. */
export type SelfDbBuild = (prefix: string) => Promise<Built>;

export const defaultSelfDbBuild: SelfDbBuild = async (prefix) => {
  try {
    // The copy's own lobes, never the live ones: the caller checked the prefix. The engine cannot drop a lobe, so an
    // earlier copy's lobes are emptied.
    const store = await DevvaStore.open({ prefix });
    try {
      await store.purge();
    } finally {
      store.close();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

export type SelfCopyDb = { ok: true; name: string; env: Record<string, string> } | { ok: false; error: string };

/** The copy's own store, emptied. liveEnv is the running server's environment; wt the copy's worktree (a store needs
 * nothing from it). */
export async function selfCopyDatabase(liveEnv: NodeJS.ProcessEnv, suffix: CopySuffix, wt: string, build: SelfDbBuild = defaultSelfDbBuild): Promise<SelfCopyDb> {
  const live = liveStorePrefix(liveEnv);
  const target = copyStorePrefix(live, suffix);
  if (!target) return { ok: false, error: say(SELF_COPY_WORDS).noLive };
  if (target.name === live) return { ok: false, error: say(SELF_COPY_WORDS).noOwnDb };
  const built = await build(target.name);
  if (!built.ok) return { ok: false, error: say(SELF_COPY_WORDS).buildFailed(target.name, built.error.slice(0, 160)) };
  return { ok: true, name: target.name, env: selfCopyEnv(target.name, 0, liveEnv) };
}

/** The live server's port: PLANIA_PORT, else the service's 3737. */
export const livePort = (liveEnv: NodeJS.ProcessEnv): number => Number(liveEnv.PLANIA_PORT) || 3737;

export type SelfCopyFile = { ok: true; file: string; env: Record<string, string> } | { ok: false; error: string };

/** Sets the copy's port, rewrites its env file (envFile, else .env) with the copy's values, reads it back and
 * refuses when the copy would still reach the live store, run jobs, or take the live server's port. */
export function selfCopyEnvFile(wt: string, envFile: string | null, copyEnv: Record<string, string>, port: number, liveEnv: NodeJS.ProcessEnv): SelfCopyFile {
  const live = liveStorePrefix(liveEnv);
  if (port === livePort(liveEnv)) return { ok: false, error: say(SELF_COPY_WORDS).livePort };
  const env: Record<string, string> = { ...copyEnv, PLANIA_PORT: String(port) };
  if (!env.PLANIA_DEVVA_PREFIX?.trim() || env.PLANIA_DEVVA_PREFIX.trim() === live) return { ok: false, error: say(SELF_COPY_WORDS).liveDb };
  const file = path.join(wt, envFile ?? ".env");
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(file, rewriteEnvText(before, env), { mode: 0o600 });
  chmodSync(file, 0o600);
  const back = readFileSync(file, "utf8");
  const prefix = envFileValue(back, "PLANIA_DEVVA_PREFIX");
  if (!prefix || prefix === live || prefix !== env.PLANIA_DEVVA_PREFIX) return { ok: false, error: say(SELF_COPY_WORDS).liveDb };
  if (envFileValue(back, "PLANIA_JOBS") !== "0") return { ok: false, error: say(SELF_COPY_WORDS).jobsOn };
  return { ok: true, file: path.relative(wt, file), env };
}
