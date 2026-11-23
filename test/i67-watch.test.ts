// PLA-I67-5: watch and clean what an agent learned. A correction judged the same as an active lesson raises its repeat
// count (a reflector suggestion counts once the owner confirms it) and two flag it; merging a lesson into a skill makes
// a new skill version and retires the lesson; the always-on budget caps what a run carries and the page proposes
// consolidating above it; a lesson unused for 90 days is proposed for retirement (injected clock); approving a lesson
// that clashes with an active one asks which stays; the agent's change history. Fake child and fake git, no real claude.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, before, beforeEach, test } from "node:test";
import { resetTestStore, useTestEnv, type TestStore } from "./helpers.js";

const scratch = mkdtempSync(path.join(tmpdir(), "plania-watch-test-"));
const kitDir = path.join(scratch, "kit");
process.env.PLANIA_KIT_DIR = kitDir;
useTestEnv();
process.env.PLANIA_PROMPTS_PROJECT = "micasa";
const { makeDb } = await import("../src/db/client.js");
const { app } = await import("../src/app.js");
const { createSession, SESSION_COOKIE } = await import("../src/auth/session.js");
const { seedLegacyOrg: seedOrg } = await import("./fixtures/legacy-org.js");
const writes = await import("../src/mcp/writes.js");
const { wakeAgent } = await import("../src/jobs/heartbeat.js");
const runner = await import("../src/runner/runner.js");
const lessonsMod = await import("../src/runner/lessons.js");
const watch = await import("../src/runner/lesson-watch.js");
const { claudeReflect, lessonsTick, reflectorArgs } = await import("../src/runner/reflector.js");
const { webCtx } = await import("../src/mcp/tx.js");

type Db = ReturnType<typeof makeDb>["db"];
let store: TestStore;
let db: Db;
let closeDb: () => Promise<void>;
const scriptsRoot = path.join(scratch, "worktrees");
const repo = path.join(scratch, "repos", "micasa");
const ctx = { actor: { agent: "test-agent", session_id: "s-i67-5" } };
const jorge = { "Content-Type": "application/json", Cookie: `${SESSION_COOKIE}=${createSession()}` };
const TDD = "---\nname: tdd\ndescription: Builds behaviour test first.\n---\n\n# TDD\n\nSee one test fail.\n";

function writeKit(): void {
  rmSync(kitDir, { recursive: true, force: true });
  mkdirSync(path.join(kitDir, "skills", "tdd"), { recursive: true });
  writeFileSync(path.join(kitDir, "skills", "tdd", "SKILL.md"), TDD);
  writeFileSync(path.join(kitDir, "skills", "tdd", "mocking.md"), "Mock only at the edge.\n");
  writeFileSync(path.join(kitDir, "kits.json"), JSON.stringify({ taller: ["tdd"], research: [] }));
}

class FakeChild extends EventEmitter {
  pid: number;
  stdout = new PassThrough();
  stderr = new PassThrough();
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  exit(code: number): void {
    this.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: `sess-${this.pid}`, result: "OK", modelUsage: { m: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } })}\n`);
    this.stdout.end();
    setImmediate(() => this.emit("exit", code, null));
  }
}

type Seen = { args: string[]; child: FakeChild; rolePrompt: string | null; plugin: Record<string, string> };
// The reflector's process: answers with structured output, like claude -p --json-schema.
function reflectorSpawn(answer: unknown, seen: string[][] = []) {
  let pid = 90_000;
  return {
    seen,
    spawn: (_c: string, args: string[]) => {
      seen.push(args);
      pid += 1;
      const child = new FakeChild(pid);
      setImmediate(() => {
        child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "r", result: JSON.stringify(answer), structured_output: answer })}\n`);
        child.stdout.end();
        setImmediate(() => child.emit("exit", 0, null));
      });
      return child;
    },
  };
}
const argAfter = (args: string[], flag: string): string | null => (args.includes(flag) ? (args[args.indexOf(flag) + 1] ?? null) : null);

// Every file of the plugin, read at spawn time (the folder leaves with the run).
function readTree(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(out, readTree(full, base));
    else out[path.relative(base, full)] = readFileSync(full, "utf8");
  }
  return out;
}

function fakes() {
  const spawned: Seen[] = [];
  let pid = 70_000;
  const deps = {
    env: { HOME: scratch, PATH: "/usr/bin:/bin", PLANIA_RUNNER_TOKEN: "runner-token", PLANIA_PROMPTS_PROJECT: "micasa", CLAUDE_CODE_BIN: "/fake/bin/claude", PLANIA_KIT_DIR: kitDir } as NodeJS.ProcessEnv,
    logDir: path.join(scratch, "logs"),
    tmpDir: path.join(scratch, "tmp"),
    worktreeRoot: scriptsRoot,
    graceMs: 10,
    liveFlushMs: 0,
    footprints: false,
    git: async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "add") {
        const target = args.find((a) => a.startsWith(scriptsRoot))!;
        mkdirSync(target, { recursive: true });
        writeFileSync(path.join(target, ".git"), "gitdir: fake\n");
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "jl/feature\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    spawn: (_command: string, args: string[]) => {
      pid += 1;
      const child = new FakeChild(pid);
      const plugin = argAfter(args, "--plugin-dir");
      const sys = argAfter(args, "--append-system-prompt-file");
      spawned.push({ args, child, rolePrompt: sys ? readFileSync(sys, "utf8") : null, plugin: plugin ? readTree(path.join(plugin, "skills")) : {} });
      return child;
    },
    kill: () => undefined,
    reportTokens: async (_db: unknown, input: unknown) => input,
    probeUsage: async () => null,
  };
  return { deps, spawned };
}

const projectId = (slug: string) => store.projectId(slug);
const agentOf = async (slug: string) => (await store.get("agents", { slug }))! as never;
let n = 0;
const ready = async () => {
  n += 1;
  const key = `WAT-${n}`;
  await writes.createTask(db, { project: "micasa", key, title: "Skill ticket", scope: "Scope", checks: ["Done"], status: "Ready" } as never, ctx);
  return key;
};
const runOnce = async (slug: string) => {
  const f = fakes();
  const key = await ready();
  assert.equal((await wakeAgent(db, { agent: slug, taskKey: key, now: new Date() }, { runner: f.deps as never })).reason, "ok");
  const seen = f.spawned[0]!;
  seen.child.exit(0);
  await runner.waitForAllRuns();
  const agent = (await store.get("agents", { slug }))!;
  const [last] = await store.find("agentRuns", { agentId: agent.id }, { orderBy: [{ column: "queuedAt", desc: true }], limit: 1 });
  const row = { id: last!.id, skills: last!.skills, manner_version: last!.mannerVersion };
  const knowledge = (await store.find("runKnowledge", { runId: row.id }, { orderBy: [{ column: "kind" }, { column: "item" }] })).map((k) => ({ kind: k.kind, item: k.item, version: k.version }));
  return { seen, row, prompt: seen.args[seen.args.indexOf("-p") + 1]!, knowledge };
};
const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = jorge) =>
  app.request(`/api/company/projects/micasa/team/${url}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const micasaRun = async (slug: string, key: string) => {
  const a = (await store.get("agents", { slug }))!;
  return store.fix((uow) => {
    const ago = (m: number) => new Date(uow.now.getTime() - m * 60_000);
    return uow.insert("agentRuns", { agentId: a.id, projectId: a.projectId!, taskKey: key, role: "taller", status: "ok", queuedAt: ago(60), startedAt: ago(60), endedAt: ago(50) });
  });
};
const sendBack = (key: string, text: string) => writes.setTask(db, { project: "micasa", key, note: `Changes the owner asks for: ${text}`, owner_changes: text } as never, { ...webCtx, tool: "test" });
const lessonRows = async () =>
  (await store.find("lessons", {}, { orderBy: [{ column: "createdAt" }] })).map((l) => ({ id: l.id, state: l.state, text: l.text, owner_words: l.ownerWords, task_key: l.taskKey, proposed_by: l.proposedBy, version: l.version })) as { id: string; state: string; text: string; owner_words: string; task_key: string; proposed_by: string; version: number }[];
// Lessons with what their foreign keys took with them (versions, repeats).
const deleteLessons = () =>
  store.fix(async (uow) => {
    for (const t of ["lessonVersions", "lessonRepeats", "lessons"] as const) await uow.delete(t, {});
  });
const NEW_LESSON = { verdict: "new", lesson: "Un solo botón principal por pantalla, abajo a la derecha.", applies_when: "pantallas", why: "pide lo mismo para todas" };

before(async () => {
  writeKit();
  store = await resetTestStore();
  ({ db, close: closeDb } = makeDb());
  await seedOrg(db);
  mkdirSync(repo, { recursive: true });
  const micasa = await projectId("micasa");
  const workia = await projectId("workia");
  await store.fix(async (uow) => {
    await uow.update("agents", {}, { heartbeatMinutes: null, adapter: "none", adapterConfig: {} });
    await uow.update("agents", { slug: ["taller", "research"] }, { adapter: "claude_code", projectId: micasa });
    await uow.insert("agents", { slug: "taller-workia", name: "Taller", role: "taller", kind: "bot", capabilities: ["engineering"], projectId: workia, roleTemplate: "taller", adapter: "claude_code" });
    for (const title of ["Prompt: Taller", "Prompt: Research"]) await uow.insert("docs", { projectId: micasa, title, markdown: `# ${title}\nNever main.`, actor: { agent: "test", session_id: "s" } });
    await uow.update("projects", { slug: ["micasa", "workia"] }, { settings: { local: { repo_path: repo } } as never });
  });
});

beforeEach(async () => {
  await runner.waitForAllRuns();
  runner.resetRunnerForTests();
  writeKit();
  await deleteLessons();
  await store.fix(async (uow) => {
    // Skills, corrections and runs with what their foreign keys took with them.
    for (const t of ["skillTrials", "skillVersions", "skills"] as const) await uow.delete(t, {});
    await uow.update("agents", {}, { manner: null });
    await uow.update("docs", { title: "Prompt: Taller" }, { markdown: "# Prompt: Taller\nNever main." });
    for (const t of ["feedbackEvents", "runLocks", "runKnowledge", "agentReferenceUses", "agentRuns", "agentSessions"] as const) await uow.delete(t, {});
    await uow.update("runnerSettings", { id: 1 }, { companyPaused: false, maxConcurrent: 4, cooldownMinutes: 0, planGuardPct: 70, guardOverride: false, reserveTokens: 1000 });
    await uow.update("projects", {}, { runsPaused: false });
    await uow.delete("planReadings", {});
    await uow.insert("planReadings", { at: uow.now, source: "stream", status: "allowed", fiveHourPct: 10, sevenDayPct: 19, fiveHourResetsAt: new Date(uow.now.getTime() + 3 * 3_600_000) });
  });
});

after(async () => {
  await runner.waitForAllRuns();
  await closeDb?.();
  await store?.end();
  rmSync(scratch, { recursive: true, force: true });
});

const teach = async (text: string) => ((await (await call("POST", "taller/lessons", { text })).json()) as { id: string }).id;
const read = async (q = "") => (await (await call("GET", `taller/lessons${q}`)).json()) as { lessons: { id: string; state: string; repeats: { confirmed: number; flagged: boolean; suggested: { id: string }[] }; retire_due: boolean }[]; budget: { used: number; budget: number; over: boolean; room_for_lessons: number }; history: { kind: string; what: string }[]; repeat_counter: string };

test("PLA-I67-5: a correction judged the same as an active lesson raises its repeat count once confirmed, and two flag it", async () => {
  const id = await teach("Los textos van en español sencillo, sin palabras técnicas.");
  const key = await ready();
  await micasaRun("taller", key);
  await sendBack(key, "Otra vez «Dashboard» y «Settings»: las vendedoras no hablan así.");
  await lessonsTick(db, new Date(), async () => ({ verdict: "repeats", lesson_id: id, why: "lo mismo" }));
  let l = (await read()).lessons.find((x) => x.id === id)!;
  assert.equal(l.repeats.confirmed, 0, "a reflector judgement is only a suggestion");
  assert.equal(l.repeats.suggested.length, 1);
  assert.equal((await lessonRows()).length, 1, "a repeat is not a new proposal");
  assert.equal((await call("POST", `taller/lessons/repeats/${l.repeats.suggested[0]!.id}`, { confirm: true })).status, 200);
  l = (await read()).lessons.find((x) => x.id === id)!;
  assert.deepEqual([l.repeats.confirmed, l.repeats.flagged], [1, false]);
  assert.equal((await call("POST", `taller/lessons/${id}/repeat`, { task_key: key, words: "Y otra vez en inglés." })).status, 200);
  l = (await read()).lessons.find((x) => x.id === id)!;
  assert.deepEqual([l.repeats.confirmed, l.repeats.flagged], [2, true]);
  assert.equal((await read()).repeat_counter, "owner");
  await assert.rejects(watch.markRepeat(db, id, { owner: false }), (e: { code?: string }) => e.code === "LESSON_OWNER_ONLY");
});

test("PLA-I67-5: merging a lesson into a skill writes a new skill version and retires the lesson", async () => {
  const made = (await (await call("POST", "taller/skills", { name: "Textos para la clienta", description: "Cuando escribe texto que lee la clienta.", body: "# Textos\n\nFrases cortas." })).json()) as { slug: string };
  const id = await teach("Los textos van en español sencillo.");
  const res = await call("POST", `taller/lessons/${id}/merge`, { skill: made.slug });
  assert.equal(res.status, 200);
  const card = (await (await call("GET", `taller/skills/${made.slug}`)).json()) as { n: number; body: string };
  assert.equal(card.n, 2);
  assert.match(card.body, /## Lessons from the owner\n\n- Los textos van en español sencillo\.$/);
  const l = (await store.get("lessons", { id }))!;
  assert.deepEqual({ state: l.state, merged_into: l.mergedInto }, { state: "retired", merged_into: made.slug });
  assert.doesNotMatch((await runOnce("taller")).prompt, /Los textos van en español sencillo/, "no longer a lesson in the prompt");
  // Into a factory skill: the owner's copy gets it; and a lesson of its own becomes a new skill.
  const id2 = await teach("Nombra cada prueba por su comportamiento.");
  await call("POST", `taller/lessons/${id2}/merge`, { skill: "tdd" });
  const tdd = (await (await call("GET", "taller/skills/tdd")).json()) as { origin: string; body: string };
  assert.equal(tdd.origin, "factory-copy");
  assert.match(tdd.body, /- Nombra cada prueba por su comportamiento\./);
  const id3 = await teach("Muestra siempre el estado vacío de una lista.");
  const own = (await (await call("POST", `taller/lessons/${id3}/merge`, { skill: null })).json()) as { skill: string };
  assert.match(own.skill, /^muestra-siempre-el-estado-vacio/);
});

test("PLA-I67-5: no run carries more always-on text than the budget, and above it the page proposes consolidating", async () => {
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  const role = `# Prompt: Taller\n${Array.from({ length: 1250 }, (_, i) => `palabra${i}`).join(" ")}`;
  await store.fix((uow) => uow.update("docs", { title: "Prompt: Taller" }, { markdown: role }));
  await call("PUT", "taller/manner", { text: Array.from({ length: 120 }, () => "cuida").join(" ") });
  for (let i = 0; i < 10; i += 1) await teach(`Regla ${i}: revisa que la pantalla quepa entera y que el botón principal se vea primero`);
  const r = await read();
  assert.equal(r.budget.over, true, "the active lessons want more than the budget leaves");
  await store.fix((uow) => uow.delete("agentSessions", {}));
  const run = await runOnce("taller");
  const kitWords = run.prompt.split("\n").filter((l) => l.startsWith("- plania:")).reduce((n, l) => n + 2 + words(l.replace(/^- plania:\S+ \([^)]*\): /, "")), 0);
  const lessonWords = run.prompt.split("\n").filter((l) => l.startsWith("- Regla")).reduce((n, l) => n + words(l), 0);
  const carried = run.knowledge.filter((k) => k.kind === "lesson").length;
  assert.ok(carried > 0 && carried < 10, `carried ${carried} of 10`);
  assert.ok(words(run.seen.rolePrompt!) + kitWords + lessonWords <= watch.ALWAYS_ON_WORDS + 40, "role, manner, skills and lessons stay within the budget");
  assert.ok(r.budget.used <= r.budget.budget);
});

test("PLA-I67-5: a lesson unused for 90 days appears as a retirement proposal, and «mantener» starts the clock again", async () => {
  const id = await teach("Usa los colores de la marca.");
  const at = (days: number) => new Date(Date.now() + days * 86_400_000);
  const due = async (now: Date) => (await lessonsMod.lessonsRead(db, "micasa", "taller", now)).lessons.find((l) => l.id === id)!.retire_due;
  assert.equal(await due(at(89)), false);
  assert.equal(await due(at(91)), true);
  assert.equal((await store.get("lessons", { id }))!.state, "active", "never removed by itself");
  await watch.keepLesson(db, id, { owner: true }, at(91));
  assert.equal(await due(at(120)), false);
  assert.equal(await due(at(182)), true);
  // A run that carries it counts as use.
  await store.fix((uow) => uow.delete("agentSessions", {}));
  await runOnce("taller");
  await store.fix((uow) => uow.update("runKnowledge", { item: id }, { createdAt: at(170) }));
  assert.equal(await due(at(182)), false);
});

test("PLA-I67-5: approving a lesson that clashes with an active one asks which stays", async () => {
  const old = await teach("Los botones van arriba a la izquierda.");
  const key = await ready();
  await micasaRun("taller", key);
  await sendBack(key, "El botón principal va abajo a la derecha.");
  await lessonsTick(db, new Date(), async () => ({ verdict: "conflicts", lesson_id: old, lesson: "El botón principal va abajo a la derecha.", why: "contradice" }));
  const fresh = (await lessonRows()).find((l) => l.state === "proposed")!;
  const res = await call("POST", `taller/lessons/${fresh.id}/decide`, { action: "approve" });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string; other: { id: string; text: string } };
  assert.equal(body.error, "LESSON_CONFLICT");
  assert.deepEqual(body.other, { id: old, text: "Los botones van arriba a la izquierda." });
  assert.equal((await call("POST", `taller/lessons/${fresh.id}/decide`, { action: "approve", keep: "new" })).status, 200);
  const states = Object.fromEntries((await lessonRows()).map((l) => [l.id, l.state]));
  assert.deepEqual([states[fresh.id], states[old]], ["active", "retired"]);
  const history = (await read()).history.map((h) => h.kind);
  assert.ok(history.includes("lesson_approved") && history.includes("lesson_taught"));
});

test("PLA-I67-2/5: an unknown lesson or skill, and a lesson that is no longer active, are refused with their codes", async () => {
  const skills = await import("../src/runner/skills.js");
  const owner = { owner: true };
  await assert.rejects(watch.markRepeat(db, "00000000-0000-4000-8000-000000000000", owner), { code: "LESSON_NOT_FOUND" });
  await assert.rejects(watch.confirmRepeat(db, "00000000-0000-4000-8000-000000000000", true, owner), { code: "LESSON_NOT_FOUND" });
  const id = await teach("Nombra cada pantalla igual que en el menú.");
  await store.fix((uow) => uow.update("lessons", { id }, { state: "retired" }));
  await assert.rejects(watch.markRepeat(db, id, owner), { code: "LESSON_STATE" });
  await assert.rejects(skills.rollbackSkill(db, "no-existe", 1), { code: "SKILL_NOT_FOUND" });
});

test("PLA-I69-5, PLA-130: how the app addresses people (Estilo → Trato) rides in its runs; with none set, nothing is added", async () => {
  const before = process.env.PLANIA_CAPTURES_DIR;
  const store = mkdtempSync(path.join(tmpdir(), "plania-i69v-run-"));
  process.env.PLANIA_CAPTURES_DIR = store;
  try {
    assert.doesNotMatch((await runOnce("taller")).prompt, /Cómo trata la app a la gente/);
    const voz = await import("../src/brand/voz.js");
    await voz.saveVoice(db, "micasa", { trato: "usted" });
    const p = (await runOnce("taller")).prompt;
    assert.match(p, /Cómo trata la app a la gente/);
    assert.match(p, /tratándola de usted\./);
  } finally {
    if (before === undefined) delete process.env.PLANIA_CAPTURES_DIR;
    else process.env.PLANIA_CAPTURES_DIR = before;
    rmSync(store, { recursive: true, force: true });
  }
});
