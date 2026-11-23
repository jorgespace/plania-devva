// PLA-I67-1: «Oficio», the agent's page, read from what Plania already stores. The seat's skills (its default kit
// or its own list) with their use counted from agent_runs, its last deliveries and how each went, and La
// estantería's switches writing agents.skill_packs, which is what the next run's kit is made from (packsOf, as the
// runner calls it). A kit folder in a temp dir and the throwaway test database; no run is started.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { resetTestStore, useTestEnv, type TestStore } from "./helpers.js";

const scratch = mkdtempSync(path.join(tmpdir(), "plania-oficio-test-"));
const kitDir = path.join(scratch, "kit");
process.env.PLANIA_KIT_DIR = kitDir;
useTestEnv();
process.env.PLANIA_PROMPTS_PROJECT = "micasa";
const { makeDb } = await import("../src/db/client.js");
const { app } = await import("../src/app.js");
const { createSession, SESSION_COOKIE } = await import("../src/auth/session.js");
const { seedLegacyOrg: seedOrg } = await import("./fixtures/legacy-org.js");
const writes = await import("../src/mcp/writes.js");
const { webCtx } = await import("../src/mcp/tx.js");
const packs = await import("../src/runner/packs.js");
const { oficioRead, outcomeOf } = await import("../src/api/company-oficio.js");

type Db = ReturnType<typeof makeDb>["db"];
let store: TestStore;
let db: Db;
let closeDb: () => Promise<void>;
const ctx = { actor: { agent: "test-agent", session_id: "s-i67-1" } };
const jorge = { "Content-Type": "application/json", Cookie: `${SESSION_COOKIE}=${createSession()}` };

const skill = (slug: string, description: string) => {
  mkdirSync(path.join(kitDir, "skills", slug), { recursive: true });
  writeFileSync(path.join(kitDir, "skills", slug, "SKILL.md"), `---\nname: ${slug}\ndescription: ${description}\n---\n\n# ${slug}\n`);
};

const projectId = (slug: string) => store.projectId(slug);
const agentId = async (slug: string) => (await store.get("agents", { slug }))!.id;
// Statuses are set in place (the moves' own rules are tested elsewhere); the owner's request for changes is the
// screen's note with owner_changes, as thread-actions writes it.
const setStatus = (key: string, status: string) => store.fix((uow) => uow.update("tasks", { key }, { status }));
const sendBack = (key: string, text: string) => writes.setTask(db, { project: "micasa", key, note: `Changes the owner asks for: ${text}`, owner_changes: text } as never, { ...webCtx, tool: "test" });

// One finished run of Taller on MiCasa. skills: what it carried ("slug@sha"); used: what the stream showed it using.
async function run(key: string | null, skills: string[], used: string[], status = "ok", minutesAgo = 10) {
  const [agent, project] = [await agentId("taller"), await projectId("micasa")];
  await store.fix((uow) => {
    const ago = (m: number) => new Date(uow.now.getTime() - m * 60_000);
    return uow.insert("agentRuns", { agentId: agent, projectId: project, taskKey: key, role: "taller", status, skills, skillsUsed: used, queuedAt: ago(minutesAgo), startedAt: ago(minutesAgo), endedAt: status === "running" || status === "starting" ? null : ago(minutesAgo - 1) });
  });
}

before(async () => {
  skill("tdd", "Builds behaviour test first.");
  skill("pr", "Opens the pull request.");
  skill("design-it-twice", "Two or three ways before choosing.");
  writeFileSync(path.join(kitDir, "kits.json"), JSON.stringify({ taller: ["tdd", "pr"], research: [] }));
  store = await resetTestStore();
  ({ db, close: closeDb } = makeDb());
  await seedOrg(db);
  const micasa = await projectId("micasa");
  await store.fix(async (uow) => {
    await uow.update("agents", {}, { heartbeatMinutes: null, adapter: "none", adapterConfig: {} });
    await uow.update("agents", { slug: ["taller", "research"] }, { projectId: micasa });
    await uow.insert("docs", { projectId: micasa, title: "Pack: Español claro", markdown: "# Español claro\n\nCuándo: al escribir texto que lee el dueño.\n", actor: { agent: "test", session_id: "s" } });
  });
  for (const key of ["OFI-1", "OFI-2", "OFI-3", "OFI-4"]) await writes.createTask(db, { project: "micasa", key, title: `Entrega ${key}`, scope: "s", checks: ["Done"], status: "Ready" } as never, ctx);
  // OFI-1 lands first time; OFI-2 is sent back once, then lands; OFI-3 waits in review; OFI-4 is being worked on.
  await setStatus("OFI-1", "Done");
  await sendBack("OFI-2", "El botón es muy chico, /Users/someone/x");
  await setStatus("OFI-2", "Done");
  await setStatus("OFI-3", "In review");
});

beforeEach(async () => {
  await store.fix(async (uow) => {
    await uow.delete("runLocks", {});
    await uow.delete("agentRuns", {});
    await uow.update("agents", {}, { skillPacks: [] });
  });
});

after(async () => {
  await closeDb?.();
  await store?.end();
  rmSync(scratch, { recursive: true, force: true });
});

test("I67-1 #2: the page lists the seat's skills and last deliveries; each use count matches agent_runs", async () => {
  await run("OFI-1", ["tdd@aaaa1111", "pr@bbbb2222"], ["tdd"], "ok", 300);
  await run("OFI-1", ["tdd@aaaa1111", "pr@bbbb2222"], ["tdd", "pr"], "ok", 290);
  await run("OFI-2", ["tdd@aaaa1111", "pr@bbbb2222"], [], "fail", 200);
  await run("OFI-2", ["tdd@aaaa1111", "pr@bbbb2222"], ["idea-package"], "ok", 190);
  await run("OFI-3", ["tdd@aaaa1111"], ["tdd"], "ok", 100);
  await run(null, ["tdd@aaaa1111", "pr@bbbb2222"], [], "ok", 50);
  await run("OFI-4", ["tdd@aaaa1111", "pr@bbbb2222"], [], "running", 5);

  const res = await app.request("/api/company/projects/micasa/team/taller/oficio", { headers: jorge });
  assert.equal(res.status, 200);
  const o = (await res.json()) as Awaited<ReturnType<typeof oficioRead>> & { skills: { slug: string; on: boolean; factory: boolean; runs_carried: number; runs_used: number; deliveries_carried: number; deliveries_used: number; source: string }[] };
  assert.ok(!("error" in o));
  // The default kit, in its order, then the rest of the shelf by name; the doc pack is on the shelf too.
  assert.deepEqual(
    o.skills.map((s) => [s.slug, s.on, s.factory, s.source]),
    [
      ["tdd", true, true, "kit"],
      ["pr", true, true, "kit"],
      ["design-it-twice", false, false, "kit"],
      ["espanol-claro", false, false, "doc"],
    ],
  );
  assert.equal(o.own, false);

  // Each count is the one SQL gives over the same runs (the live run is not finished, so it is not counted).
  const finished = await store.find("agentRuns", { status: ["ok", "fail", "stopped"] });
  for (const s of o.skills) {
    const carried = finished.filter((r) => r.skills.some((v) => v.split("@")[0] === s.slug)).length;
    const used = finished.filter((r) => r.skillsUsed.includes(s.slug)).length;
    assert.equal(s.runs_carried, carried, `${s.slug} carried`);
    assert.equal(s.runs_used, used, `${s.slug} used`);
  }
  assert.deepEqual(o.skills.slice(0, 2).map((s) => [s.runs_carried, s.runs_used, s.deliveries_carried, s.deliveries_used]), [
    [6, 3, 4, 2],
    [5, 1, 3, 1],
  ]);
  assert.deepEqual(o.runs, { total: 6, with_kit: 6, used_any: 4 });

  // Newest work first; how each went, with the owner's words scrubbed.
  assert.deepEqual(
    o.deliveries.map((d) => [d.key, d.outcome, d.closed, d.sent_back, d.runs]),
    [
      ["OFI-4", "trabajando", false, 0, 1],
      ["OFI-3", "espera", false, 0, 1],
      ["OFI-2", "devuelta", true, 1, 2],
      ["OFI-1", "primera", true, 0, 2],
    ],
  );
  const two = o.deliveries.find((d) => d.key === "OFI-2")!;
  assert.equal(two.words, "El botón es muy chico, [ruta]");
  assert.deepEqual(two.used, ["idea-package"]);
  assert.deepEqual(o.deliveries.find((d) => d.key === "OFI-1")!.used, ["pr", "tdd"]);
  assert.deepEqual(o.counts, { closed: 2, first_time: 1, last_five: 2, last_five_first: 1 });
  assert.equal(o.live?.key, "OFI-4");
});

test("I67-1 #3: La estantería's switches write skill_packs and the next run's kit follows; all off carries none", async () => {
  const put = (list: string[], own = true) => app.request("/api/company/projects/micasa/team/taller/packs", { method: "PUT", headers: jorge, body: JSON.stringify({ packs: list, own }) });
  const kitNow = async () => (await packs.packsOf(db, (await store.get("agents", { slug: "taller" }))!, process.env, "taller")).map((p) => p.slug);
  const stored = async () => (await store.get("agents", { slug: "taller" }))!.skillPacks;

  // A seat with no list of its own reads its default kit, and so does its next run.
  const get = (await (await app.request("/api/company/projects/micasa/team/taller/packs", { headers: jorge })).json()) as { packs: { slug: string }[]; own: boolean };
  assert.deepEqual([get.packs.map((p) => p.slug), get.own], [["tdd", "pr"], false]);
  assert.deepEqual(await kitNow(), ["tdd", "pr"]);

  // Off: tdd. The seat now has its own list.
  let res = await put(["pr"]);
  assert.equal(res.status, 200);
  assert.deepEqual(await stored(), ["pr"]);
  assert.deepEqual(await kitNow(), ["pr"]);
  // Off: the last one. It carries none (not the default kit back).
  res = await put([]);
  assert.deepEqual(((await res.json()) as { packs: unknown[]; own: boolean }).own, true);
  assert.deepEqual(await stored(), [packs.NO_SKILLS]);
  assert.deepEqual(await kitNow(), []);
  const read = await oficioRead(db, "micasa", "taller");
  assert.ok(!("error" in read));
  assert.deepEqual(read.skills.filter((s) => s.on), []);
  assert.equal(read.own, true);
  // The team read never shows the marker.
  const team = (await (await app.request("/api/company/projects/micasa", { headers: jorge })).json()) as { team: { agent: string; packs: string[] }[] };
  assert.deepEqual(team.team.find((m) => m.agent === "taller")?.packs, []);
  // On: one that is not in the default kit, a doc pack.
  await put(["design-it-twice", "espanol-claro"]);
  assert.deepEqual(await kitNow(), ["design-it-twice", "espanol-claro"]);
  // The client cannot send the marker itself.
  assert.equal((await put([packs.NO_SKILLS])).status, 400);
  // Without own, an empty list puts the seat back on its default kit (the older behaviour).
  await put([], false);
  assert.deepEqual(await stored(), []);
  assert.deepEqual(await kitNow(), ["tdd", "pr"]);
});

test("I67-1 #5: a seat with no deliveries and no skills reads empty; a seat elsewhere is not found", async () => {
  const o = await oficioRead(db, "micasa", "research");
  assert.ok(!("error" in o));
  assert.deepEqual(o.deliveries, []);
  assert.deepEqual(o.skills.filter((s) => s.on), []);
  assert.deepEqual(o.counts, { closed: 0, first_time: 0, last_five: 0, last_five_first: 0 });
  assert.equal(o.live, null);
  assert.equal((await app.request("/api/company/projects/micasa/team/nadie/oficio", { headers: jorge })).status, 404);
  assert.equal((await app.request("/api/company/projects/nope/team/taller/oficio", { headers: jorge })).status, 404);
  assert.equal((await app.request("/api/company/projects/micasa/team/taller/oficio", { headers: { ...jorge, Authorization: "Bearer test-token" } })).status, 403);
});

test("I67-1: how a delivery went, from its status and the owner's send-backs", () => {
  assert.equal(outcomeOf({ status: "Released", kind: "ticket" }, 0, false).outcome, "primera");
  assert.equal(outcomeOf({ status: "Merged", kind: "ticket" }, 2, false).outcome, "devuelta");
  assert.equal(outcomeOf({ status: "In progress", kind: "ticket" }, 1, false).outcome, "devuelta");
  assert.equal(outcomeOf({ status: "Open", kind: "idea" }, 0, false).outcome, "espera");
  assert.equal(outcomeOf({ status: "Won't do", kind: "ticket" }, 0, false).outcome, "descartada");
  assert.equal(outcomeOf({ status: "Done", kind: "ticket" }, 0, true).outcome, "trabajando");
  assert.equal(outcomeOf(undefined, 0, false).outcome, "en_curso");
});
