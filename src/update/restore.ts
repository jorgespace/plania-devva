// PLA-I2-8: bring Plania's data back from a backup file (the nightly plania-<day>.devva.jsonl.gz or an update's
// plania-pre-update-*.devva.jsonl.gz, src/jobs/backup.ts) into a store on the devva engine: the one the settings name
// (PLANIA_DEVVA_PREFIX), or another prefix named on the command line. Replaces the README's hand-typed steps. A store
// that already holds commits is never replaced unless the person asks twice: --overwrite and the store's name again
// (--confirm <name>); its lobes are then emptied before the restore (the engine cannot drop a lobe, only empty it).
// The file is read and checked whole before anything is emptied. The restore itself is DevvaStore.restore
// (src/store/devva.ts): every commit back into the log, in order, then the projection rebuilt. The store is injected,
// so tests choose it.
import { existsSync, readFileSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { isStorePrefix } from "../db/install.js";
import { devvaAddress } from "../install/connect.js";
import { DevvaStore } from "../store/devva.js";
import { defineWords, say } from "../words.js";

// PLA-I2-10: what the restore command says, in the install's language.
export const RESTORE_WORDS = defineWords({
  es: {
    noFile: (file: string) => `No encuentro el respaldo ${file}, o está vacío.`,
    notDump: (file: string) => `${file} no es un respaldo completo de Plania (plania-<día>.devva.jsonl.gz), así que no se restaura nada.`,
    badName: "El nombre del almacén debe ir en minúsculas, con números o guion bajo.",
    noServer: (why: string) => `No se pudo conectar con el motor devva (${why}): revisa que esté encendido (deploy/devva/README.md).`,
    hasData: (name: string) => `El almacén ${name} ya tiene datos, así que no se restaura encima. Si de verdad quieres reemplazarlo, pídelo dos veces: --overwrite --confirm ${name}.`,
    dropping: (name: string) => `Vacío el almacén ${name} para traerlo del respaldo.`,
    created: (name: string) => `Almacén ${name} listo y vacío.`,
    restoring: (file: string, name: string) => `Traigo el respaldo ${file} al almacén ${name}.`,
    failed: (name: string, why: string) => `El respaldo no entró completo en el almacén ${name} (${why}). El almacén quedó a medias: vuelve a correr con --overwrite --confirm ${name}.`,
    done: (name: string, commits: number) => `Listo: el almacén ${name} volvió del respaldo con ${commits} ${commits === 1 ? "cambio guardado" : "cambios guardados"}.`,
  },
  en: {
    noFile: (file: string) => `I cannot find the backup ${file}, or it is empty.`,
    notDump: (file: string) => `${file} is not a complete Plania backup (plania-<day>.devva.jsonl.gz), so nothing is restored.`,
    badName: "The store's name must be lowercase letters, numbers or underscores.",
    noServer: (why: string) => `Could not connect to the devva engine (${why}): check that it is running (deploy/devva/README.md).`,
    hasData: (name: string) => `The store ${name} already holds data, so the backup is not restored over it. If you really want to replace it, ask twice: --overwrite --confirm ${name}.`,
    dropping: (name: string) => `Emptying the store ${name} to bring it back from the backup.`,
    created: (name: string) => `Store ${name} ready and empty.`,
    restoring: (file: string, name: string) => `Restoring the backup ${file} into the store ${name}.`,
    failed: (name: string, why: string) => `The backup did not load completely into the store ${name} (${why}). The store is half done: run again with --overwrite --confirm ${name}.`,
    done: (name: string, commits: number) => `Done: the store ${name} is back from the backup with ${commits} saved ${commits === 1 ? "change" : "changes"}.`,
  },
});

export type RestoreErrorCode = "NO_FILE" | "NOT_DUMP" | "BAD_NAME" | "NO_SERVER" | "HAS_DATA" | "RESTORE_FAILED";
export class RestoreError extends Error {
  constructor(
    readonly code: RestoreErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The store a backup goes into: how many commits it holds, emptying it, loading a dump into it (empty), closing. */
export type RestoreTarget = { readonly commits: number; purge(): Promise<void>; restore(text: string): Promise<number>; close(): void };

export type RestoreOptions = {
  file: string;
  // The lobe prefix of the store to restore into.
  prefix: string;
  overwrite?: boolean;
  // Must repeat the store's name when overwrite is asked.
  confirm?: string;
  // Opens the store on the prefix; devvaTarget() is the engine the settings name.
  open: (prefix: string) => Promise<RestoreTarget>;
  log?: (line: string) => void;
};

// created: the store held no commits. replaced: it held some and was emptied first. commits: what the backup brought.
export type RestoreResult = { store: string; created: boolean; replaced: boolean; commits: number };

const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 300);

/**
 * The backup's text, gunzipped when the file ends in .gz, checked as DevvaStore.restore will: a header line naming the
 * number of commits, then exactly that many, numbered 1..n in order. Null when it is not that.
 */
export function readDump(file: string): { text: string; commits: number } | null {
  try {
    const raw = readFileSync(file);
    const text = (file.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    const header = JSON.parse(lines[0] ?? "{}") as { plania_devva_dump?: number; commits?: number };
    if (header.plania_devva_dump !== 1 || header.commits !== lines.length - 1) return null;
    for (let i = 1; i < lines.length; i++) if ((JSON.parse(lines[i]!) as { seq?: number }).seq !== i) return null;
    return { text, commits: lines.length - 1 };
  } catch {
    return null;
  }
}

export async function restore(opts: RestoreOptions): Promise<RestoreResult> {
  const log = opts.log ?? (() => {});
  const w = say(RESTORE_WORDS);
  if (!existsSync(opts.file) || statSync(opts.file).size === 0) throw new RestoreError("NO_FILE", w.noFile(opts.file));
  const name = opts.prefix;
  if (!isStorePrefix(name)) throw new RestoreError("BAD_NAME", w.badName);
  // Read and checked before the store is touched: a bad file never empties a store.
  const dump = readDump(opts.file);
  if (!dump) throw new RestoreError("NOT_DUMP", w.notDump(opts.file));

  let target: RestoreTarget;
  try {
    target = await opts.open(name);
  } catch (e) {
    throw new RestoreError("NO_SERVER", w.noServer(why(e)));
  }
  try {
    const created = target.commits === 0;
    let replaced = false;
    if (!created) {
      if (!opts.overwrite || opts.confirm !== name) throw new RestoreError("HAS_DATA", w.hasData(name));
      log(w.dropping(name));
      await target.purge();
      replaced = true;
    } else log(w.created(name));

    log(w.restoring(opts.file, name));
    let commits: number;
    try {
      commits = await target.restore(dump.text);
    } catch (e) {
      throw new RestoreError("RESTORE_FAILED", w.failed(name, why(e)));
    }
    log(w.done(name, commits));
    return { store: name, created, replaced, commits };
  } finally {
    target.close();
  }
}

/** The real store: DevvaStore on the engine the environment names (DEVVA_HOST, DEVVA_PORT, DEVVA_TOKEN_FILE). */
export function devvaTarget(env: NodeJS.ProcessEnv = process.env) {
  const a = devvaAddress(env);
  return async (prefix: string): Promise<RestoreTarget> => {
    const store = await DevvaStore.open({ prefix, host: a.host, port: a.port, tokenFile: a.tokenFile, clientModule: a.client, timeoutMs: 120_000 });
    return {
      get commits() {
        return store.commits;
      },
      purge: () => store.purge(),
      restore: (text) => store.restore(text),
      close: () => store.close(),
    };
  };
}
