// PLA-I72-1: the copies of a project in Máquinas. One start copy (the start branch, src/captures/prueba.ts «sandbox»)
// and one per open initiative, built from its integration branch with its own port, worktree and base
// (<db>_ini_<key>). The processes live in memory; maquina_copias keeps the names, «No apagarla sola» and what the owner
// last asked, so a Plania restart lists them again (reconcileCopias). Borrar la copia stops the server, drops the
// base and removes the worktree; the start copy and the app's own base are never deleted from here.
import type { Db } from "../db/client.js";
import type { MaquinaCopia } from "../db/schema.js";
import { writeTx } from "../mcp/tx.js";
import { writeVia } from "../runner/limits.js";
import { readerOf, uowOf } from "../store/port.js";
import {
  apagar,
  apagarIni,
  appBaseUrl,
  borrarIni,
  dropIniBase,
  encender,
  encenderIni,
  entregaUrl,
  iniDatabaseName,
  iniRead,
  iniSuffix,
  iniWorktree,
  keepOf,
  ownBases,
  pruebaInfo,
  pruebaRead,
  reiniciar,
  setKeep,
  type BorrarResult,
  type PruebaPhase,
} from "../captures/prueba.js";
import { liveDatabaseName } from "../self/plania-self.js";
import { existsSync } from "node:fs";
import { defineWords, say } from "../words.js";
import { MaquinaError } from "./errors.js";
import { ctx, menv, projectOf, type ProjectRow } from "./machines.js";
import { appDirs } from "./env.js";

export const COPIAS_WORDS = defineWords({
  es: {
    notFound: "No encuentro esa copia",
    closed: "La iniciativa ya está cerrada; su copia no se enciende",
    noBranch: "La iniciativa no tiene rama todavía",
    startCopy: "La copia de inicio no se borra; solo se apaga",
    protectedBase: "Esa base es de la app o de la copia de inicio; no la borro",
    inicio: "Inicio",
  },
  en: {
    notFound: "I can't find that copy",
    closed: "The initiative is closed; its copy does not start",
    noBranch: "The initiative has no branch yet",
    startCopy: "The start copy is not deleted; it is only turned off",
    protectedBase: "That database is the app's or the start copy's; I do not delete it",
    inicio: "Start",
  },
});

export const START_ID = "inicio";
const CLOSED = ["Done", "Won't do"];

export type CopiaRead = {
  id: string; // "inicio" or the initiative's key
  kind: "inicio" | "iniciativa";
  key: string | null;
  title: string;
  status: string | null; // the initiative's status
  branch: string | null;
  phase: PruebaPhase;
  managed: boolean;
  port: number | null;
  url: string | null;
  started_at: string | null;
  error: string | null;
  detail: string | null;
  keep: boolean;
  database: string | null;
  worktree: string | null;
  made: boolean; // its worktree exists on this machine
};
// own_bases: each copy has a base of its own (else the start copy runs on the app's). no_code: the project said it has
// no code yet. unavailable: this system cannot run a copy.
export type CopiasRead = { project: string; configured: boolean; own_bases: boolean; no_code: boolean; copias: CopiaRead[] };

type Ini = { id: string; key: string; title: string; status: string; branch: string | null; baseBranch: string | null };

const iniOf = (t: { id: string; key: string; title: string; status: string; branch: string | null; baseBranch: string | null }): Ini => ({
  id: t.id,
  key: t.key,
  title: t.title,
  status: t.status,
  branch: t.branch,
  baseBranch: t.baseBranch,
});

async function openInitiatives(db: Db, p: ProjectRow): Promise<Ini[]> {
  const rows = await readerOf(db).find("tasks", { projectId: p.id, kind: "initiative" }, { orderBy: [{ column: "createdAt" }] });
  return rows.filter((t) => !CLOSED.includes(t.status)).map(iniOf);
}

async function liveRows(db: Db, projectId: string): Promise<MaquinaCopia[]> {
  return readerOf(db).find("maquinaCopias", { projectId, deletedAt: null });
}

/** The names Plania never deletes for a project: the app's own base and the start copy's. */
export function protectedBases(p: ProjectRow): Set<string> {
  const out = new Set<string>();
  const base = appBaseUrl(p);
  const app = base ? (liveDatabaseName(base) ?? null) : null;
  if (app) {
    out.add(app);
    out.add(`${app}_prueba`);
    out.add(`${app}_entrega`);
  }
  const start = base ? entregaUrl(base, "_prueba")?.name : null;
  if (start) out.add(start);
  return out;
}

function startCopy(p: ProjectRow, r: Awaited<ReturnType<typeof pruebaRead>>): CopiaRead {
  const info = pruebaInfo(p.slug);
  const base = appBaseUrl(p);
  return {
    id: START_ID,
    kind: "inicio",
    key: null,
    title: say(COPIAS_WORDS).inicio,
    status: null,
    branch: info?.branch ?? (p.settings.capture ? (p.settings.local as { start_branch?: string } | undefined)?.start_branch ?? "sandbox" : null),
    phase: r.phase,
    managed: r.managed,
    port: r.port,
    url: r.url,
    started_at: r.started_at,
    error: r.error,
    detail: r.detail,
    keep: keepOf(p.slug),
    // Its own base (<db>_prueba) when copies get one; else it runs on the app's own.
    database: base ? (ownBases(p) ? (entregaUrl(base, "_prueba")?.name ?? null) : liveDatabaseName(base)) : null,
    worktree: info?.worktree ?? appDirs(p.slug, p.settings, menv()).prueba,
    made: !!(info?.worktree ?? appDirs(p.slug, p.settings, menv()).prueba),
  };
}

function iniCopy(p: ProjectRow, i: Ini, row: MaquinaCopia | undefined, look: boolean): CopiaRead {
  const live = iniRead(p.slug, i.key, look);
  const worktree = row?.worktree ?? iniWorktree(p.slug, i.key);
  return {
    id: i.key,
    kind: "iniciativa",
    key: i.key,
    title: i.title,
    status: i.status,
    branch: live?.branch ?? row?.branch ?? i.branch ?? i.baseBranch,
    phase: live?.phase ?? "off",
    managed: live?.managed ?? false,
    port: live?.port ?? null,
    url: live?.url ?? null,
    started_at: live?.started_at ?? null,
    error: live?.error ?? null,
    detail: live?.detail ?? null,
    keep: live?.keep ?? row?.keep ?? false,
    database: live?.database ?? row?.database ?? null,
    worktree: row || live ? worktree : null,
    made: existsSync(worktree),
  };
}

/** Every copy of a project: the start copy first, then one per open initiative (the ones with a copy first). */
export async function copiasRead(db: Db, slug: string, look = true): Promise<CopiasRead> {
  const p = await projectOf(db, slug);
  const s = p.settings.capture;
  const rows = await liveRows(db, p.id);
  const byKey = new Map(rows.map((r) => [r.initiativeKey, r]));
  const inis = await openInitiatives(db, p);
  const list = inis.map((i) => iniCopy(p, i, byKey.get(i.key), look));
  list.sort((a, b) => Number(!!b.worktree) - Number(!!a.worktree));
  return { project: slug, configured: !!s, own_bases: ownBases(p), no_code: !s && p.settings.local?.no_code === true, copias: [startCopy(p, await pruebaRead(slug, s)), ...list] };
}

async function initiativeOf(db: Db, p: ProjectRow, key: string): Promise<Ini & { closed: boolean }> {
  const t = await readerOf(db).get("tasks", { projectId: p.id, kind: "initiative", key });
  if (!t) throw new MaquinaError("COPY_NOT_FOUND", say(COPIAS_WORDS).notFound);
  return { ...iniOf(t), closed: CLOSED.includes(t.status) };
}

async function rowOf(db: Db, projectId: string, key: string): Promise<MaquinaCopia | undefined> {
  return readerOf(db).get("maquinaCopias", { projectId, initiativeKey: key, deletedAt: null });
}

export type CopiaAction = "encender" | "apagar" | "reiniciar" | "borrar" | "quedarse" | "rehacer";

/** One action on one copy. id is "inicio" or an initiative key. The answer is the copies again (and, for borrar,
 * what was dropped and removed). */
export async function copiaAction(db: Db, slug: string, id: string, action: CopiaAction, body: { keep?: unknown } = {}): Promise<CopiasRead & { borrada?: BorrarResult }> {
  const W = say(COPIAS_WORDS);
  const p = await projectOf(db, slug);
  if (!p.settings.capture) throw new MaquinaError("NOT_CONFIGURED", "settings.capture");
  if (id === START_ID) {
    if (action === "borrar") throw new MaquinaError("COPY_NOT_DELETABLE", W.startCopy);
    if (action === "encender") await encender(db, slug, { stills: false });
    else if (action === "apagar") await apagar(db, slug);
    else if (action === "reiniciar") await reiniciar(db, slug, { stills: false });
    else if (action === "quedarse") {
      if (!setKeep(slug, "sandbox", null, body.keep === true)) throw new MaquinaError("COPY_NOT_FOUND", W.notFound);
    }
    return copiasRead(db, slug);
  }
  const ini = await initiativeOf(db, p, id);
  const row = await rowOf(db, p.id, ini.key);
  if (action === "encender" || action === "reiniciar") {
    if (ini.closed) throw new MaquinaError("INITIATIVE_CLOSED", W.closed);
    const branch = ini.branch ?? ini.baseBranch;
    if (!branch) throw new MaquinaError("NO_BRANCH", W.noBranch);
    if (action === "reiniciar") await apagarIni(db, slug, ini.key);
    const database = iniDatabaseName(p, ini.key);
    const worktree = iniWorktree(slug, ini.key);
    if (row) {
      await writeVia(db, (uow) => uow.update("maquinaCopias", { id: row.id }, { state: "on", startedAt: uow.now, branch, worktree, database, updatedAt: uow.now }), p.id);
    } else {
      await writeTx(db, p, ctx(), async (tx, emit) => {
        const uow = uowOf(tx);
        // maquina_copias_live_idx: one live row per initiative (a partial unique index the store does not enforce).
        const live = await uow.get("maquinaCopias", { projectId: p.id, initiativeKey: ini.key, deletedAt: null });
        if (live) {
          await uow.update("maquinaCopias", { id: live.id }, { state: "on", startedAt: uow.now, branch, worktree, database, updatedAt: uow.now });
          return;
        }
        await uow.insert("maquinaCopias", { projectId: p.id, initiativeId: ini.id, initiativeKey: ini.key, branch, worktree, database, state: "on", startedAt: uow.now });
        await emit("machine.copy_created", { id: ini.id, key: ini.key }, { branch, worktree, database });
      });
    }
    await encenderIni(db, slug, { key: ini.key, branch, keep: row?.keep ?? iniRead(slug, ini.key, false)?.keep ?? false });
  } else if (action === "apagar") {
    await apagarIni(db, slug, ini.key);
    if (row) await writeVia(db, (uow) => uow.update("maquinaCopias", { id: row.id }, { state: "off", updatedAt: uow.now }), p.id);
  } else if (action === "quedarse") {
    const keep = body.keep === true;
    if (!row && !iniRead(slug, ini.key, false)) throw new MaquinaError("COPY_NOT_FOUND", W.notFound);
    setKeep(slug, "iniciativa", ini.key, keep);
    if (row) await writeVia(db, (uow) => uow.update("maquinaCopias", { id: row.id }, { keep, updatedAt: uow.now }), p.id);
  } else if (action === "rehacer") {
    // PLA-I72-5: Rehacer desde inicio: the initiative's base is dropped and made again from the start copy's.
    const database = row?.database ?? iniDatabaseName(p, ini.key);
    if (!database || protectedBases(p).has(database) || !database.endsWith(iniSuffix(ini.key))) throw new MaquinaError("BASE_PROTECTED", W.protectedBase, { database });
    const wasOn = !!iniRead(slug, ini.key, false);
    await apagarIni(db, slug, ini.key);
    await dropIniBase(db, slug, database);
    if (wasOn && !ini.closed && (ini.branch ?? ini.baseBranch)) await encenderIni(db, slug, { key: ini.key, branch: (ini.branch ?? ini.baseBranch)!, keep: row?.keep ?? false });
    else if (row) await writeVia(db, (uow) => uow.update("maquinaCopias", { id: row.id }, { state: "off", updatedAt: uow.now }), p.id);
  } else if (action === "borrar") {
    const borrada = await deleteCopy(db, p, ini.key, ini.id, row, "owner");
    return { ...(await copiasRead(db, slug)), borrada };
  }
  return copiasRead(db, slug);
}

/** Stops, drops and removes an initiative's copy (Borrar la copia, and step 3's clean-up on close). Refuses a
 * protected base name before touching anything. */
export async function deleteCopy(db: Db, p: ProjectRow, key: string, initiativeId: string | null, row: MaquinaCopia | undefined, why: "owner" | "closed" | "sweep"): Promise<BorrarResult> {
  const database = row?.database ?? iniDatabaseName(p, key);
  const worktree = row?.worktree ?? iniWorktree(p.slug, key);
  if (database && (protectedBases(p).has(database) || !database.endsWith(iniSuffix(key)))) throw new MaquinaError("BASE_PROTECTED", say(COPIAS_WORDS).protectedBase, { database });
  const r = await borrarIni(db, p.slug, key, { database, worktree });
  await writeTx(db, p, ctx(), async (tx, emit) => {
    const uow = uowOf(tx);
    if (row) await uow.update("maquinaCopias", { id: row.id }, { deletedAt: uow.now, state: "off", updatedAt: uow.now });
    await emit("machine.copy_deleted", initiativeId ? { id: initiativeId, key } : null, { key, database: r.database, dropped: r.dropped, worktree: r.worktree, removed: r.removed, why });
  });
  return r;
}

/** At Plania's start: nothing it started survives a stop, so every copy row still marked on is set off. The rows
 * stay (names, keep), so the copies are listed again and Encender brings them back with their base as it was. */
export async function reconcileCopias(db: Db): Promise<number> {
  const rd = readerOf(db);
  const rows = (await rd.find("maquinaCopias", { deletedAt: null, state: "on" })).map((c) => ({ id: c.id, projectId: c.projectId, key: c.initiativeKey }));
  let n = 0;
  for (const r of rows) {
    const p = await rd.get("projects", { id: r.projectId });
    if (p && iniRead(p.slug, r.key, false)) continue;
    await writeVia(db, (uow) => uow.update("maquinaCopias", { id: r.id }, { state: "off", updatedAt: uow.now }), r.projectId);
    n += 1;
  }
  return n;
}

/** PLA-I72-4: after a key changed, every running copy is restarted so it reads its env file again. */
export async function reiniciarEncendidas(db: Db, slug: string): Promise<CopiasRead & { reiniciadas: string[] }> {
  const before = await copiasRead(db, slug, false);
  const on = before.copias.filter((c) => c.managed && ["live", "capturing", "starting"].includes(c.phase));
  for (const c of on) await copiaAction(db, slug, c.id, "reiniciar");
  return { ...(await copiasRead(db, slug)), reiniciadas: on.map((c) => c.id) };
}
