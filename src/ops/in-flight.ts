// PLA-53: what a restart of the Plania server would kill. Runs, QA checks, El Probador's passes and Máquinas test
// runs live in the server process: a restart (every release) cuts them. `pnpm server:restart` reads this first and refuses
// while anything is listed (scripts/restart.ts).
import type { Db } from "../db/client.js";
import { readerOf } from "../store/port.js";
import { notNull } from "../store/types.js";
import { defineWords, say } from "../words.js";

// PLA-I2-10: what a restart would cut, in the install's language; the Spanish is unchanged.
export const IN_FLIGHT_WORDS = defineWords({
  es: {
    run: (slug: string, key: string | null, since: string | null) => `${slug} trabaja${key ? ` en ${key}` : ""}${since ? ` desde ${since}Z` : ""}`,
    qa: (key: string) => `QA corre las pruebas de ${key}`,
    fotos: (key: string) => `El Probador toma las fotos de ${key}`,
    entrega: (key: string) => `${key} se acaba de entregar: sus fotos están por empezar`,
    pruebas: (slug: string) => `Máquinas corre las pruebas de ${slug}`,
  },
  en: {
    run: (slug: string, key: string | null, since: string | null) => `${slug} is working${key ? ` on ${key}` : ""}${since ? ` since ${since}Z` : ""}`,
    qa: (key: string) => `QA is running the tests of ${key}`,
    fotos: (key: string) => `El Probador is taking the stills of ${key}`,
    entrega: (key: string) => `${key} was just delivered: its stills are about to start`,
    pruebas: (slug: string) => `Máquinas is running the tests of ${slug}`,
  },
});

export type InFlight = { kind: "run" | "qa" | "fotos" | "entrega" | "pruebas"; text: string };

// A «tomando» older than this has nobody behind it; a delivery this fresh may be about to get its pass.
// PLA-102 (guided test PLA-86, F-21): this was 6 minutes, the same as the sweep's orphan age, but a pass with three
// views at two widths, two copies and the muestra's rows runs longer. A restart at 6.6 minutes read «Nada en curso»
// and cut MIA-I10-3's pass. The sweep can retake early (it checks the pass in memory); a restart must not, so it waits
// longer before calling a pass abandoned.
export const PASS_MS = 20 * 60_000;
const FRESH_MS = 2 * 60_000;

// machine_state keys like 'maquinas:pruebas:%:corriendo'.
const MARK_START = "maquinas:pruebas:";
const MARK_END = ":corriendo";

export async function inFlight(db: Db, now = new Date()): Promise<InFlight[]> {
  const out: InFlight[] = [];
  const w = say(IN_FLIGHT_WORDS);
  const r = readerOf(db);
  for (const run of await r.find("agentRuns", { status: "running" })) {
    const agent = await r.get("agents", { id: run.agentId });
    if (!agent) continue;
    out.push({ kind: "run", text: w.run(agent.slug, run.taskKey, run.startedAt ? run.startedAt.toISOString().slice(11, 16) : null) });
  }

  for (const lane of await r.find("qaLanes", { status: "checking" })) {
    const t = await r.get("tasks", { id: lane.taskId });
    if (t) out.push({ kind: "qa", text: w.qa(t.key) });
  }

  for (const t of await r.find("tasks", { status: "In review", muestra: notNull() })) {
    const p = await r.get("projects", { id: t.projectId });
    if (!p || !p.settings.capture) continue;
    const s = t.probador;
    if (s?.state === "tomando" && now.getTime() - Date.parse(s.at) < PASS_MS) out.push({ kind: "fotos", text: w.fotos(t.key) });
    else if (!s && now.getTime() - (t.statusChangedAt ?? t.createdAt).getTime() < FRESH_MS) out.push({ kind: "entrega", text: w.entrega(t.key) });
  }

  const marks = (await r.find("machineState")).filter((m) => m.key.length >= MARK_START.length + MARK_END.length && m.key.startsWith(MARK_START) && m.key.endsWith(MARK_END));
  for (const m of marks) {
    const pid = Number((m.value as { server_pid?: number }).server_pid);
    if (Number.isInteger(pid) && pid > 1 && alive(pid)) out.push({ kind: "pruebas", text: w.pruebas(m.key.split(":")[2] ?? "") });
  }
  return out;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
