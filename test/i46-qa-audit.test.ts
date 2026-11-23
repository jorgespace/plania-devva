// AUDIT-6 and AUDIT-10 in the QA lane: two verdicts (spec and code) stored apart, a report that parses fenced, bare
// or in the old shape, past misses in the brief, the browser walk-through when the project asks for it, and one retro
// per ticket and delivery commit. (Harness from i46-qa.test.ts: every process is fake, throwaway DB.)
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, before, beforeEach, test } from "node:test";
import { ne, resetTestStore, useTestEnv, type TestStore } from "./helpers.js";

useTestEnv();
process.env.PLANIA_EVENT_WAKES = "1";
process.env.PLANIA_PROMPTS_PROJECT = "micasa";
const { makeDb } = await import("../src/db/client.js");
const { app } = await import("../src/app.js");
const { createSession, SESSION_COOKIE } = await import("../src/auth/session.js");
const writes = await import("../src/mcp/writes.js");
const { setProject } = await import("../src/mcp/project.js");
const { findProject } = await import("../src/mcp/queries.js");
const runner = await import("../src/runner/runner.js");
const qa = await import("../src/runner/qa.js");
const retro = await import("../src/runner/retro.js");
const { threadAction } = await import("../src/api/thread-actions.js");
const { resolveThread } = await import("../src/runner/threads.js");
const { worktreePathFor } = await import("../src/runner/worktree.js");

type Db = ReturnType<typeof makeDb>["db"];
type Json = Record<string, any>;
let store: TestStore;
let db: Db;
let closeDb: () => Promise<void>;
const scratch = mkdtempSync(path.join(tmpdir(), "plania-i46-qa-audit-"));
const ROOT = path.join(scratch, "worktrees");
const REPO = path.join(scratch, "repo");
const A = { actor: { agent: "test-agent", session_id: "s-i46-qa-audit" } };
const jorge = () => ({ Cookie: `${SESSION_COOKIE}=${createSession()}`, "Content-Type": "application/json" });
const SHA1 = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SHA2 = "b2c3d4e5f60718293a4b5c6d7e8f901234567890";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  constructor(readonly pid: number) {
    super();
  }
  finish(text = "OK"): void {
    const result = { type: "result", subtype: "success", is_error: false, num_turns: 3, session_id: "sess-qa", result: text, modelUsage: { "claude-sonnet-5-5": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } };
    this.stdout.write(`${JSON.stringify(result)}\n`);
    this.stdout.end();
    setImmediate(() => this.emit("exit", 0, null));
  }
}

const repo = { head: SHA1, branch: "jl/zig-01" };
const git = async (args: string[], _cwd: string) => {
  if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: `${repo.branch}\n`, stderr: "" };
  if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${repo.head}\n`, stderr: "" };
  if (args[0] === "diff" && args[1] === "--shortstat") return { code: 0, stdout: " 2 files changed, 10 insertions(+), 3 deletions(-)\n", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};
let verifyOut: Record<string, { code: number; out: string }> = {};
const exec = async (command: string) => {
  const r = verifyOut[command] ?? { code: 0, out: "" };
  return { code: r.code, stdout: r.out, stderr: "" };
};
const startApp = async () => ({ ok: true, error: null, stop: async () => undefined });
const capture = async (_db: Db, input: { project: string; task_key?: string; commit?: string; base_url?: string }) => ({
  run_id: "11111111-1111-4111-8111-111111111111",
  project: input.project,
  task_key: input.task_key ?? null,
  commit: input.commit ?? null,
  branch: null,
  base_url: input.base_url ?? "",
  ok: 1,
  failed: 0,
  stills: [{ page: "inicio", viewport: "desktop" as const, status: "ok" as const, id: "22222222-2222-4222-8222-222222222222" }],
});

function runnerFakes() {
  const spawned: { args: string[]; cwd: string; child: FakeChild }[] = [];
  let pid = 80_000;
  const deps = {
    env: { HOME: scratch, PATH: "/usr/bin:/bin", PLANIA_RUNNER_TOKEN: "runner-token", PLANIA_PROMPTS_PROJECT: "micasa", CLAUDE_CODE_BIN: "/fake/bin/claude" } as NodeJS.ProcessEnv,
    logDir: path.join(scratch, "logs"),
    tmpDir: path.join(scratch, "tmp"),
    worktreeRoot: ROOT,
    graceMs: 10,
    liveFlushMs: 0,
    footprints: false,
    git,
    spawn: (_command: string, args: string[], options: { cwd: string }) => {
      const child = new FakeChild(++pid);
      spawned.push({ args, cwd: options.cwd, child });
      return child;
    },
    kill: () => undefined,
    reportTokens: async () => undefined,
    probeUsage: async () => null,
  };
  return { deps, spawned };
}
let rf = runnerFakes();
const qaDeps = () => ({ exec, git, env: rf.deps.env, worktreeRoot: ROOT, startApp, capture, freePort: async () => 4455, runner: rf.deps as never, publicUrl: "http://127.0.0.1:3737" }) as never;

const pid = (slug: string) => store.projectId(slug);
// The newest lane (two in the same millisecond: the one written last), with run_id as the database named it.
const lane = async (key: string): Promise<Json> => {
  const l = (await store.find("qaLanes", { taskKey: key }, { orderBy: [{ column: "createdAt" }] })).at(-1)!;
  return { ...l, run_id: l.runId };
};
const ticket = async (key: string) => {
  const t = (await store.get("tasks", { projectId: await pid("zigzag"), key }))!;
  return { id: t.id, status: t.status, version: t.version };
};
const runs = async () => {
  const slugs = new Map((await store.find("agents")).map((a) => [a.id, a.slug]));
  return (await store.find("agentRuns", {}, { orderBy: [{ column: "queuedAt" }] }))
    .filter((r) => slugs.has(r.agentId))
    .map((r) => ({ slug: slugs.get(r.agentId)!, id: r.id, status: r.status, task_key: r.taskKey, reason: r.reason })) as any[];
};
const promptOf = (s: { args: string[] }) => s.args[s.args.indexOf("-p") + 1]!;
// zigzag's settings, changed by fn (on a copy), written back whole.
const editSettings = (fn: (s: Json) => Json) =>
  store.fix(async (uow) => {
    const z = (await uow.get("projects", { slug: "zigzag" }))!;
    await uow.update("projects", { id: z.id }, { settings: fn(structuredClone(z.settings) as Json) as never });
  });
const setQa = (field: string, value: boolean) => editSettings((s) => ({ ...s, qa: { ...(s.qa ?? {}), [field]: value } }));
// Every run gone; run_locks went with them through the foreign key.
const deleteRuns = () =>
  store.fix(async (uow) => {
    await uow.delete("runLocks", {});
    await uow.delete("agentRuns", {});
  });
const lastNote = async (key: string) => (await store.find("events", { taskKey: key, type: "note" }, { orderBy: [{ column: "createdAt" }, { column: "id" }] })).at(-1)!.payload.text as string;
const lastVerifyCite = async (key: string) => (await store.find("results", { taskId: (await ticket(key)).id, kind: "verify" }, { orderBy: [{ column: "createdAt" }] })).at(-1)!.cite;
const retroMarks = () => store.count("events", { type: "retro.queued" });
const evidence = async (key: string) => (await (await app.request(`/api/projects/zigzag/qa/${key}`, { headers: jorge() })).json()) as Json;

type Verdict = "pass" | "fail";
const marksOf = (marks: Verdict[]) => marks.map((mark, i) => ({ n: i + 1, mark, note: `revisado ${i + 1}` }));
const fenced = (o: unknown) => `Revisé el cambio.\n\`\`\`qa-report\n${JSON.stringify(o)}\n\`\`\``;
const twoAxis = (spec: Verdict, code: Verdict, marks: Verdict[] = [], extra: Json = {}) => ({
  spec: { verdict: spec, notes: spec === "pass" ? "Cumple el alcance y el Done when." : "Falta el aviso cuando el correo está vacío (src/form.tsx:40)." },
  code: { verdict: code, notes: code === "pass" ? "Sin errores en los casos límite." : "src/form.ts:12 no valida el correo antes de guardar." },
  checklist: marksOf(marks),
  ...extra,
});

async function deliver(key: string, head: string, prNumber: number) {
  const url = `https://github.com/jorg3l3on/zigzag/pull/${prNumber}`;
  const t = await ticket(key);
  const projectId = await pid("zigzag");
  const { thread } = await resolveThread(db, "zigzag");
  await store.fix(async (uow) => {
    if (t.status !== "In review") await uow.update("tasks", { id: t.id }, { status: "In review", statusChangedAt: uow.now, prUrl: url, branch: `jl/${key.toLowerCase()}` });
    await uow.update("checks", { taskId: t.id }, { done: true, doneAt: uow.now });
    const pr = { projectId, repo: "jorg3l3on/zigzag", number: prNumber };
    if (await uow.get("pullRequests", pr)) await uow.update("pullRequests", pr, { headSha: head, updatedAt: uow.now });
    else await uow.insert("pullRequests", { ...pr, url, taskId: t.id, state: "open", headSha: head, headBranch: `jl/${key.toLowerCase()}`, baseBranch: "sandbox", ciState: "none" });
    await uow.insert("threadMessages", {
      threadId: thread.id,
      authorAgent: "taller-zz",
      authorRole: "taller",
      body: `Listo ${key}: PR #${prNumber}`,
      links: [
        { kind: "ticket", ref: key, title: `Paso ${key}` },
        { kind: "pr", ref: url, title: `PR #${prNumber}` },
      ],
    });
  });
  repo.head = head;
  repo.branch = `jl/${key.toLowerCase()}`;
  mkdirSync(worktreePathFor(ROOT, "zigzag", key), { recursive: true });
}

async function newTicket(title: string, workType = "code"): Promise<string> {
  const out = (await writes.createTask(db, { project: "zigzag", title, scope: "Formulario de registro con correo.", checks: ["El formulario guarda el correo"], work_type: workType, ...(workType === "bug" ? { severity: "S3" } : {}), status: "Ready" } as never, A)) as Json;
  return out.key;
}

async function tick() {
  const out = await qa.sweepQa(db, new Date(), qaDeps());
  await qa.waitForQa();
  return out;
}

// The checks, then the review run through the runner; returns the review's prompt. finish: what the fake QA answers.
async function review(finish: string): Promise<string> {
  await tick();
  await tick();
  const from = rf.spawned.length;
  // Only the QA run starts here: a wake of Taller or the Asistente queued by an earlier step stays out.
  const qaSeat = (await store.get("agents", { slug: "qa-zz" }))!.id;
  await store.fix((uow) => uow.delete("agentRuns", { status: "queued", agentId: ne(qaSeat) }));
  await runner.drainQueue(db, new Date(), rf.deps as never);
  const s = rf.spawned[from];
  assert.ok(s, "the QA run started");
  const prompt = promptOf(s);
  s.child.finish(finish);
  await runner.waitForAllRuns();
  await tick();
  return prompt;
}

before(async () => {
  store = await resetTestStore();
  ({ db, close: closeDb } = makeDb());
  mkdirSync(REPO, { recursive: true });
  const actor = { agent: "test", session_id: "s" };
  const micasa = await pid("micasa");
  const z = await pid("zigzag");
  await store.fix(async (uow) => {
    for (const title of ["Prompt: Taller", "Prompt: QA"]) await uow.insert("docs", { projectId: micasa, title, markdown: `# ${title}\nNever main.`, actor });
    await uow.insert("agents", { slug: "taller-zz", name: "Taller", role: "engineer", kind: "coder", adapter: "claude_code", projectId: z, roleTemplate: "taller" });
    await uow.insert("agents", { slug: "qa-zz", name: "QA Zigzag", role: "qa", kind: "bot", adapter: "claude_code", projectId: z, roleTemplate: "qa" });
    await uow.delete("agents", { slug: "asistente-retro" });
    await uow.insert("agents", { slug: "asistente-retro", name: "Asistente", role: "chief-of-staff", kind: "bot", adapter: "claude_code", roleTemplate: "asistente" });
  });
  const p = await findProject(db, "zigzag");
  await setProject(
    db,
    {
      project: "zigzag",
      version: p.version,
      settings: {
        qa: { verify: [{ name: "test", command: "pnpm test" }] },
        capture: { start_command: "pnpm dev --port {port}", port: 3000, ready_path: "/salud", pages: [{ key: "inicio", path: "/", label: "Inicio" }] },
      },
    } as never,
    A,
  );
  await editSettings((s) => ({ ...s, local: { repo_path: REPO } }));
});

beforeEach(async () => {
  await qa.waitForQa();
  await runner.waitForAllRuns();
  runner.resetRunnerForTests();
  rf = runnerFakes();
  await store.fix(async (uow) => {
    await uow.update("runnerSettings", { id: 1 }, { companyPaused: false, maxConcurrent: 2, cooldownMinutes: 0, planGuardPct: 70 });
    await uow.update("projects", { slug: "zigzag" }, { runsPaused: false });
    await uow.delete("planReadings", {});
    await uow.insert("planReadings", { at: uow.now, source: "stream", status: "allowed", fiveHourPct: 10, fiveHourResetsAt: new Date(uow.now.getTime() + 3 * 3_600_000) });
  });
  await deleteRuns();
  verifyOut = { "pnpm test": { code: 0, out: "ℹ tests 14\nℹ pass 14\nℹ fail 0\n" } };
});

after(async () => {
  await qa.waitForQa();
  await runner.waitForAllRuns();
  await closeDb?.();
  await store?.end();
  rmSync(scratch, { recursive: true, force: true });
});

test("AUDIT-6 report: two axes fenced or bare, the old one-verdict shape, and the schema", () => {
  // Two axes in the fenced block: stored apart, the overall verdict fails when either fails.
  const both = qa.parseReport(fenced(twoAxis("pass", "fail", ["pass"])), [1])!;
  assert.deepEqual([both.review.verdict, both.review.spec!.verdict, both.review.code!.verdict], ["fail", "pass", "fail"]);
  assert.equal(both.review.code!.notes, "src/form.ts:12 no valida el correo antes de guardar.");
  assert.equal(both.review.notes, "Lo que se pidió (pasa): Cumple el alcance y el Done when.\nEl código (falla): src/form.ts:12 no valida el correo antes de guardar.");
  assert.equal(both.walked, undefined);
  assert.equal(qa.parseReport(fenced(twoAxis("pass", "pass")), [])!.review.verdict, "pass");
  assert.equal(qa.parseReport(fenced(twoAxis("fail", "pass")), [])!.review.verdict, "fail");
  // A bare JSON object (a run with --json-schema), alone or after a sentence, with walked.
  const bare = qa.parseReport(JSON.stringify(twoAxis("pass", "pass", ["pass", "fail"], { walked: true })), [1, 2])!;
  assert.deepEqual([bare.review.verdict, bare.walked, bare.marks.map((m: Json) => m.mark)], ["pass", true, ["pass", "fail"]]);
  assert.equal(qa.parseReport(`Listo, este es mi informe:\n${JSON.stringify(twoAxis("pass", "pass"))}`, [])!.review.verdict, "pass");
  assert.equal(qa.parseReport(`\`\`\`json\n${JSON.stringify(twoAxis("fail", "fail"))}\n\`\`\``, [])!.review.verdict, "fail");
  // The shape from before: one verdict, no axes.
  const old = qa.parseReport(fenced({ review: { verdict: "fail", notes: "src/x.ts:3 falla" }, checklist: [] }), [])!;
  assert.deepEqual(old, { review: { verdict: "fail", notes: "src/x.ts:3 falla" }, marks: [] });
  assert.deepEqual(qa.parseReport(JSON.stringify({ review: { verdict: "pass", notes: "ok" }, checklist: [] }), [])!.review, { verdict: "pass", notes: "ok" });
  // Not a report: one axis alone, no verdict at all, prose, an unmarked check-list item.
  assert.equal(qa.parseReport(fenced({ spec: { verdict: "pass", notes: "" }, checklist: [] }), []), null);
  assert.equal(qa.parseReport(fenced({ checklist: [] }), []), null);
  assert.equal(qa.parseReport("Todo bien, pasa.", []), null);
  assert.equal(qa.parseReport(JSON.stringify(twoAxis("pass", "pass", ["pass"])), [1, 2]), null);
  // A --json-schema run carries the report as structured_output on its result event.
  const log = `${JSON.stringify({ type: "assistant" })}\n${JSON.stringify({ type: "result", result: "", structured_output: twoAxis("pass", "fail") })}\n`;
  assert.equal(qa.parseReport(qa.resultTextOf(log), [])!.review.code!.verdict, "fail");

  const schema = qa.QA_REPORT_SCHEMA as Json;
  assert.deepEqual(schema.required, ["spec", "code", "checklist"]);
  assert.deepEqual(schema.properties.spec.properties.verdict.enum, ["pass", "fail"]);
  assert.equal(schema.properties.walked.type, "boolean");
  assert.equal(schema.properties.review, undefined, "one merged verdict is not in the schema");
});

test("AUDIT-6 two verdicts: the brief asks for both, a failing axis goes back to Taller by name, the card reads both", async () => {
  const key = await newTicket("Formulario de registro");
  await qa.setPoChecks(db, { project: "zigzag", key, items: ["El correo se guarda"] }, A.actor);
  await deliver(key, SHA1, 21);
  const prompt = await review(fenced(twoAxis("pass", "fail", ["pass"])));
  // The brief: two axes with their own notes, the two-axis template, nothing of the optional parts.
  assert.match(prompt, /two verdicts, and they are never merged/);
  assert.match(prompt, /- spec: does the change do what the ticket asked\?.*scope creep/);
  assert.match(prompt, /- code: is the change sound\?.*Style alone never fails\./);
  assert.match(prompt, /\{"spec": \{"verdict": "pass", "notes": "\.\.\."\}, "code": \{"verdict": "pass", "notes": "\.\.\."\}, "checklist": \[\{"n": 1, "mark": "pass", "note": "\.\.\."\}\]\}/);
  assert.doesNotMatch(prompt, /"review":/);
  assert.doesNotMatch(prompt, /what must not change/, "not a bug ticket");
  assert.doesNotMatch(prompt, /Past misses/, "no misses yet: no heading");
  assert.doesNotMatch(prompt, /browser|walked/, "the project does not ask for the walk-through");

  const l = await lane(key);
  assert.deepEqual([l.status, l.returned, l.review.verdict, l.review.spec.verdict, l.review.code.verdict], ["fail", true, "fail", "pass", "fail"]);
  assert.equal("walked" in l.review, false);
  assert.match(l.notes, /^- Revisión aparte · el código \(errores, casos límite, manejo inseguro\): src\/form\.ts:12 no valida/);
  assert.doesNotMatch(l.notes, /lo que se pidió/, "only the axis that failed");
  const note = await lastNote(key);
  assert.match(note, /QA devolvió la entrega \(a1b2c3d\), intento 1:\n- Revisión aparte · el código/);
  const ev = (await store.find("events", { taskKey: key, type: "qa.failed" }))[0]!.payload;
  assert.deepEqual([ev.review, ev.spec, ev.code], ["fail", "pass", "fail"]);
  const cite = await lastVerifyCite(key);
  assert.match(cite, /QA falla \(intento 1\) · pruebas 14 de 14 · lo pedido pasa · el código falla · check list 1 de 1/);
  // No retro unless the project asks for one.
  assert.equal((await runs()).some((r) => (r.reason ?? "").startsWith("retro:")), false);
  assert.equal((await retroMarks()), 0);

  const read = await evidence(key);
  assert.equal(read.state, "returned");
  assert.deepEqual(read.review.spec, { verdict: "pass", notes: "Cumple el alcance y el Done when." });
  assert.deepEqual(read.review.code, { verdict: "fail", notes: "src/form.ts:12 no valida el correo antes de guardar." });
  assert.equal(read.review.verdict, "fail");
  assert.equal(read.review.walked, undefined);

  // The brief itself, as the runner gets it: the schema for --json-schema, no browser.
  const brief = (await qa.qaBriefFor(db, l.run_id, "/work/zigzag"))!;
  assert.deepEqual([brief.browser, brief.appUrl, brief.appCommand], [false, null, null]);
  assert.equal(brief.jsonSchema, qa.QA_REPORT_SCHEMA);
});

test("AUDIT-6 old shape and bug tickets: a one-verdict report still concludes the lane; a bug's brief asks what must not change", async () => {
  const key = await newTicket("Arreglar el guardado", "bug");
  await deliver(key, SHA1, 22);
  const prompt = await review(fenced({ review: { verdict: "pass", notes: "Hace lo que pide el ticket." }, checklist: [] }));
  assert.match(prompt, /This ticket fixes a bug: also confirm what must not change\./);
  const l = await lane(key);
  assert.equal(l.status, "pass");
  assert.deepEqual(l.review, { verdict: "pass", notes: "Hace lo que pide el ticket.", model: "sonnet" });
  assert.deepEqual((await evidence(key)).review, { verdict: "pass", notes: "Hace lo que pide el ticket.", model: "sonnet" });
  // An old failing review reads to Taller as before.
  assert.equal(qa.notesOf({ verify: [], capture: null, review: { verdict: "fail", notes: "src/x.ts:3 falla", model: null }, marks: [], commit: SHA1 }, []), "- Revisión aparte: src/x.ts:3 falla");
  assert.equal(
    qa.notesOf({ verify: [], capture: null, review: { verdict: "fail", notes: "", model: null, spec: { verdict: "fail", notes: "Falta la pantalla de gracias." }, code: { verdict: "fail", notes: "" } }, marks: [], commit: SHA1 }, []),
    "- Revisión aparte · lo que se pidió (alcance, Done when, check list): Falta la pantalla de gracias.\n- Revisión aparte · el código (errores, casos límite, manejo inseguro): falla sin detalle",
  );
});

test("AUDIT-6 calibration: where the owner decided against QA shows in the next brief, short and clean", async () => {
  assert.deepEqual(await qa.qaMisses(db, await pid("zigzag")), [], "QA's own return of the first test is not the owner's word");
  // A: QA passes, then the owner asks for changes on that delivery.
  const a = await newTicket("Botón de guardar");
  await deliver(a, SHA1, 31);
  await review(fenced(twoAxis("pass", "pass")));
  assert.equal((await lane(a)).status, "pass");
  const ref = await resolveThread(db, "zigzag");
  // The newest message linking the ticket with no action taken on it yet.
  const msgOf = async (key: string) =>
    (await store.find("threadMessages", { actionState: null }, { orderBy: [{ column: "at", desc: true }] })).find((m) => m.links.some((l) => l.kind === "ticket" && l.ref === key))!.id;
  const words = "El botón no guarda en el celular.\nMira C:\\Users\\jorge\\notas.txt y /Users/jorge/notas.txt, token=ghp_abcdefghijklmnopqrstuvwxyz012345";
  const out = await threadAction(db, ref, { message_id: await msgOf(a), action: "cambios", text: words });
  assert.equal("ok" in out && out.ok, true, JSON.stringify(out));

  // B: QA fails twice (the second stays for the owner), and the owner accepts it.
  const b = await newTicket("Lista de invitados");
  await deliver(b, SHA1, 32);
  await review(fenced(twoAxis("fail", "pass")));
  assert.equal((await lane(b)).returned, true);
  await deleteRuns();
  await deliver(b, SHA2, 32);
  await review(fenced(twoAxis("fail", "pass")));
  assert.deepEqual([(await lane(b)).attempt, (await lane(b)).status, (await lane(b)).returned], [2, "fail", false]);
  const accepted = await msgOf(b);
  await store.fix((uow) => uow.update("threadMessages", { id: accepted }, { actionState: { action: "aceptar", at: new Date().toISOString(), result: { merged: true, ticket: b } } as never }));

  const misses = await qa.qaMisses(db, await pid("zigzag"));
  assert.deepEqual(misses.map((m: Json) => [m.key, m.kind, m.title]), [[b, "failed_then_accepted", "Lista de invitados"], [a, "passed_then_changes", "Botón de guardar"]]);
  assert.match(misses[1]!.owner, /^El botón no guarda en el celular\. Mira \[ruta\] y \[ruta\], token=\[oculto\]$/);
  assert.match(misses[0]!.qa, /lo que se pidió \(alcance, Done when, check list\): Falta el aviso/);
  assert.ok(misses.every((m: Json) => !/\n/.test(m.qa + m.owner) && m.qa.length <= 222 && m.owner.length <= 220));

  // The next delivery's brief carries them under their heading, with nothing that must not travel.
  await deleteRuns();
  const c = await newTicket("Pantalla de gracias");
  await deliver(c, SHA1, 33);
  const prompt = await review(fenced(twoAxis("pass", "pass")));
  assert.match(prompt, /Past misses of QA on this project, to learn from \(the owner decided against QA's verdict/);
  assert.match(prompt, new RegExp(`1\\. ${b} «Lista de invitados»: QA failed it twice \\(".*"\\)\\. The owner accepted it as it was\\.`));
  assert.match(prompt, new RegExp(`2\\. ${a} «Botón de guardar»: QA passed it \\(".*"\\)\\. The owner then asked for changes: "El botón no guarda en el celular\\.`));
  const section = prompt.slice(prompt.indexOf("Past misses"), prompt.indexOf("End your run"));
  assert.doesNotMatch(section, /ghp_|notas\.txt|Users/);
  assert.equal(section.split("\n").filter(Boolean).length, 3, "the heading and one line per miss");
  // At most three, and the heading only with examples.
  assert.equal((await qa.qaMisses(db, await pid("zigzag"), 10)).length <= 3, true);
  assert.deepEqual(qa.missLines([]), []);
  assert.deepEqual(await qa.qaMisses(db, await pid("micasa")), [], "another project's misses are its own");
});

test("AUDIT-6 browser: with settings.qa.browser the brief says how to start, walk and stop the app, and walked is kept", async () => {
  await setQa("browser", true);
  try {
    const key = await newTicket("Pantalla de inicio");
    await deliver(key, SHA1, 41);
    const prompt = await review(fenced(twoAxis("pass", "pass", [], { walked: true })));
    assert.match(prompt, /walk through the change in the running app, with the browser tools/);
    assert.match(prompt, /in the background: `PORT=(\d+) pnpm dev --port \1`\. It answers at http:\/\/localhost:\1\/salud once it is up/);
    assert.match(prompt, /Stop the app before you end .* and report "walked": true\./);
    assert.match(prompt, /"checklist": \[\], "walked": true\}/);
    assert.doesNotMatch(prompt, /test user/, "no login configured");
    const l = await lane(key);
    assert.deepEqual([l.status, l.review?.walked], ["pass", true], JSON.stringify([l.status, l.hold, await runs()]));
    assert.equal((await evidence(key)).review.walked, true);
    const cite = await lastVerifyCite(key);
    assert.match(cite, /lo pedido pasa · el código pasa · recorrió la app/);
    // What the runner gets to add a browser tool server: the port is a free one, the command and the URL agree.
    const brief = (await qa.qaBriefFor(db, l.run_id, "/work/zigzag", { freePort: async () => 4466 }))!;
    assert.deepEqual([brief.browser, brief.appUrl, brief.appCommand], [true, "http://localhost:4466", "pnpm dev --port 4466"]);

    // A report that does not say it walked reads as not walked.
    await deleteRuns();
    const other = await newTicket("Pie de página");
    await deliver(other, SHA1, 42);
    await review(fenced(twoAxis("pass", "pass")));
    assert.equal((await lane(other)).review.walked, false);
    // A login: the brief names the test user and how its password is set, never a password.
    await editSettings((s) => ({
      ...s,
      capture: { ...s.capture, session: { login_path: "/entrar", user: "prueba@example.com", user_field: "email", password_field: "password", password_command: "pnpm run set-password {user}" } },
    }));
    const withLogin = (await qa.qaBriefFor(db, l.run_id, "/work/zigzag", { freePort: async () => 4466 }))!;
    assert.match(withLogin.prompt, /test user prueba@example\.com \(login at \/entrar\).*`pnpm run set-password prueba@example\.com`.*Never write that password/);
  } finally {
    await editSettings((s) => ({ ...s, qa: (({ browser: _b, ...q }) => q)(s.qa ?? {}), capture: (({ session: _s, ...c }) => c)(s.capture ?? {}) }));
  }
  // Off again: no walk-through in the brief, and a stray walked in a report is not stored.
  await deleteRuns();
  const key = await newTicket("Sin recorrido");
  await deliver(key, SHA1, 43);
  const prompt = await review(fenced(twoAxis("pass", "pass", [], { walked: true })));
  assert.doesNotMatch(prompt, /browser tools|walked/);
  assert.equal("walked" in (await lane(key)).review, false);
});

test("AUDIT-10 retro: a delivery QA sends back queues one Asistente wake per ticket and delivery commit", async () => {
  await setQa("retro", true);
  try {
    const key = await newTicket("Correo de bienvenida");
    verifyOut["pnpm test"] = { code: 1, out: "ℹ tests 14\nℹ pass 12\nℹ fail 2\n" };
    await deliver(key, SHA1, 51);
    await tick();
    assert.deepEqual([(await lane(key)).status, (await lane(key)).returned], ["fail", true]);
    const queued = (await runs()).filter((r) => r.slug === "asistente-retro");
    assert.equal(queued.length, 1);
    assert.deepEqual([queued[0].status, queued[0].task_key], ["queued", key]);
    assert.equal(queued[0].reason.split("\n")[0], `retro: QA sent back the delivery of ${key} (a1b2c3d): test falló: 2 de 14 fallan. \`pnpm test\``);
    const marks = async () => (await store.find("events", { type: "retro.queued", taskKey: key }, { orderBy: [{ column: "createdAt" }, { column: "id" }] })).map((r) => r.payload);
    assert.deepEqual((await marks()).map((m: Json) => [m.delivery, m.cause, m.run_id]), [["a1b2c3d", "qa_returned", queued[0].id]]);

    // The owner asking for changes on the same commit is the same miss: nothing new.
    const p = await findProject(db, "zigzag");
    const t = await ticket(key);
    const task = { id: t.id as string, key };
    const again = await retro.queueRetro(db, { project: p as never, task, cause: "owner_changes", why: "No se ve bien" });
    assert.deepEqual(again, { kind: "none", reason: "already queued for this delivery" });
    assert.equal((await retro.queueRetro(db, { project: p as never, task, cause: "owner_changes", commit: SHA1.slice(0, 12), why: "x" })).kind, "none", "the short and the long form of a commit are one delivery");
    assert.equal((await runs()).filter((r) => r.slug === "asistente-retro").length, 1);
    // A new commit is a new delivery. The Asistente still has its run on this ticket: the reason joins it.
    const next = await retro.queueRetro(db, { project: p as never, task, cause: "owner_changes", commit: SHA2, why: "El texto:\nsigue   diciendo «Hola»  y C:\\Users\\jorge\\x.txt" });
    assert.equal(next.kind, "queued");
    assert.equal(next.kind === "queued" && next.reason, `retro: the owner asked for changes on the delivery of ${key} (b2c3d4e): El texto: sigue diciendo «Hola» y [ruta]`);
    const after = (await runs()).filter((r) => r.slug === "asistente-retro");
    assert.equal(after.length, 1);
    assert.match(after[0].reason, /retro: QA sent back[^\n]*\nretro: the owner asked for changes/);
    assert.deepEqual((await marks()).map((m: Json) => m.delivery), ["a1b2c3d", "b2c3d4e"]);

    // A delivery with no commit (a doc) is named by its message.
    const doc = await newTicket("Guía de tono", "research");
    const d = { id: (await ticket(doc)).id as string, key: doc };
    assert.equal((await retro.queueRetro(db, { project: p as never, task: d, cause: "owner_changes", why: "Falta algo", delivery: "m-1" })).kind, "queued");
    assert.equal((await retro.queueRetro(db, { project: p as never, task: d, cause: "owner_changes", why: "Falta algo", delivery: "m-1" })).kind, "none");
    assert.equal((await retro.queueRetro(db, { project: p as never, task: d, cause: "owner_changes", why: "Otra cosa", delivery: "m-2" })).kind, "queued");

    // A wake that cannot be queued leaves no mark, so a later miss on the same delivery may try again.
    await store.fix((uow) => uow.update("runnerSettings", { id: 1 }, { companyPaused: true }));
    const held = await retro.queueRetro(db, { project: p as never, task: d, cause: "owner_changes", why: "x", delivery: "m-3" });
    assert.deepEqual(held, { kind: "none", reason: "company paused" });
    await store.fix((uow) => uow.update("runnerSettings", { id: 1 }, { companyPaused: false }));
    assert.equal((await retro.queueRetro(db, { project: p as never, task: d, cause: "owner_changes", why: "x", delivery: "m-3" })).kind, "queued");
  } finally {
    await editSettings((s) => ({ ...s, qa: (({ retro: _r, ...q }) => q)(s.qa ?? {}) }));
  }
  // Off: nothing is queued and nothing is marked.
  const p = await findProject(db, "zigzag");
  const before = (await retroMarks());
  assert.deepEqual(await retro.queueRetro(db, { project: p as never, task: { id: (await ticket((await newTicket("Otro")))).id, key: "ZIG-0" }, cause: "qa_returned", commit: SHA1 }), { kind: "none", reason: "off" });
  assert.equal((await retroMarks()), before);
});

test("AUDIT-6/10 scrub: tokens, passwords and paths outside the repo never travel; repo paths and commits do", () => {
  assert.equal(retro.scrub("src/form.ts:12 falla en a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"), "src/form.ts:12 falla en a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
  assert.equal(retro.scrub("ui/src/components/corriente/entrega-detalle-de-la-vista.tsx:40"), "ui/src/components/corriente/entrega-detalle-de-la-vista.tsx:40");
  assert.equal(retro.scrub("mira http://localhost:3000/home/inicio"), "mira http://localhost:3000/home/inicio");
  assert.equal(retro.scrub("en /Users/jorge/lab/x.ts y ~/.config/plania/github-token"), "en [ruta] y [ruta]");
  assert.equal(retro.scrub("C:\\Users\\Jorge\\x.txt y /home/ci/app"), "[ruta] y [ruta]");
  assert.equal(retro.scrub("usa sk-ant-abcdefghijklmnop1234 o Bearer abc.def-123456"), "usa [oculto] o Bearer [oculto]");
  assert.equal(retro.scrub("password: hunter22 y API_KEY=abcd1234"), "password: [oculto] y API_KEY=[oculto]");
  assert.equal(retro.scrub(`cookie ${"a1B2".repeat(12)}`), "cookie [oculto]");
  assert.equal(retro.oneLine("  uno\n dos  ", 20), "uno dos");
  assert.equal(retro.oneLine("x".repeat(30), 10).length, 10);
  assert.equal(retro.retroReason({ key: "ZIG-1", cause: "qa_returned", commit: null, why: null }), "retro: QA sent back the delivery of ZIG-1");
});
