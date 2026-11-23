// PLA-I71-6: the team catalog and the whole company in a file. Save a project's team and adopt it in another project
// (same seats, managers, skills and motors; new seats paused); the adopt preview writes nothing; an exported company
// holds no secret value, task, usage figure or machine path; export then import into an emptied database reproduces
// teams, managers, owner skills and motors, and a name collision renames by default; a Paperclip-style team with
// adapter fields Plania does not know imports and lists what it ignored. Throwaway DB, no network.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ne, resetTestStore, useTestEnv, type TestStore } from "./helpers.js";

const kit = path.join(mkdtempSync(path.join(tmpdir(), "plania-i71-teams-")), "kit");
for (const s of ["tdd", "pr"]) {
  mkdirSync(path.join(kit, "skills", s), { recursive: true });
  writeFileSync(path.join(kit, "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: ${s} skill.\n---\n\n# ${s}\n`);
}
writeFileSync(path.join(kit, "kits.json"), JSON.stringify({}));
process.env.PLANIA_KIT_DIR = kit;
useTestEnv();
process.env.PLANIA_PROMPTS_PROJECT = "tienda";
const { makeDb } = await import("../src/db/client.js");
const { app } = await import("../src/app.js");
const { createSession, SESSION_COOKIE } = await import("../src/auth/session.js");
const { ensureTeam } = await import("../src/runner/team.js");
const pkg = await import("../src/runner/company-package.js");
const { deleteProject } = await import("../src/mcp/project.js");

type Json = Record<string, any>;
let store: TestStore;
let db: ReturnType<typeof makeDb>["db"];
let closeDb: () => Promise<void>;
const owner = () => ({ Cookie: `${SESSION_COOKIE}=${createSession()}`, "Content-Type": "application/json" });
const call = async (method: string, url: string, body?: unknown) => {
  const res = await app.request(url, { method, headers: owner(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
};
// A project's live seats by role template: its manager's template, its own list, motor and whether it is paused.
const seats = async (project: string) => {
  const p = await store.get("projects", { slug: project });
  if (!p) return [] as Json[];
  const all = await store.find("agents");
  const byId = new Map(all.map((a) => [a.id, a]));
  const key = (a: { roleTemplate: string | null }) => a.roleTemplate ?? "\uffff";
  return all
    .filter((a) => a.projectId === p.id && a.status !== "retired")
    .sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0))
    .map((a) => ({ t: a.roleTemplate, role: a.role, boss: a.reportsTo ? (byId.get(a.reportsTo)?.roleTemplate ?? null) : null, packs: a.skillPacks, model: a.motorModel, effort: a.motorEffort, paused: a.pausedAt !== null })) as Json[];
};
const project = async (slug: string, title: string) => (await store.fix((uow) => uow.insert("projects", { slug, title, keyPrefix: slug.slice(0, 3).toUpperCase() }))).id;

before(async () => {
  store = await resetTestStore();
  ({ db, close: closeDb } = makeDb());
  await store.fix((uow) => uow.insert("agents", { slug: "ceo", name: "CEO", role: "ceo", kind: "human" }));
  const pid = await project("tienda", "Tienda");
  await store.fix(async (uow) => {
    for (const t of ["Product owner", "Taller", "Research", "Artist", "QA", "Copy", "Seguridad", "Marketing", "Data"]) await uow.insert("docs", { projectId: pid, title: `Prompt: ${t}`, markdown: `# ${t}`, actor: { agent: "t", session_id: "s" } });
  });
  await ensureTeam(db, { id: pid, slug: "tienda", title: "Tienda" });
  // Tienda's team as the owner shaped it: QA under Taller, own lists, motors, a manner with a path and a secret.
  await call("POST", "/api/company/projects/tienda/team", { template: "qa" });
  await call("PUT", "/api/company/projects/tienda/team/qa-tienda/manager", { reports_to: "taller-tienda" });
  await store.fix(async (uow) => {
    await uow.update("agents", { slug: "taller-tienda" }, { skillPacks: ["tdd", "pr"], motorModel: "opus", motorEffort: "high", manner: "Commits cortos. Mira /Users/someone/secret/app y usa API_KEY=sk-live-abcdefghijklmnop123456" });
    await uow.update("agents", { slug: "research-tienda" }, { motorModel: "sonnet", motorEffort: "medium" });
    await uow.update("agents", { slug: "po-tienda" }, { adapterConfig: { command_env: "CLAUDE_CODE_BIN", token_env: "TIENDA_DEPLOY_TOKEN" } as never });
  });
  await call("POST", "/api/company/projects/tienda/team/po-tienda/skills", { name: "Tono de la marca", description: "Cómo habla este proyecto.", body: "# Tono\n\nCercano y claro.", scope: "project" });
  const taller = (await store.get("agents", { slug: "taller-tienda" }))!;
  await store.fix((uow) => uow.insert("tasks", { projectId: pid, key: "TND-1", title: "Arreglar el carrito secreto", kind: "ticket", status: "Ready", scope: "s" })).catch(() => undefined);
  await store.fix((uow) => uow.insert("lessons", { projectId: pid, agentId: taller.id, scope: "agent", text: "Nunca toques la rama principal.", state: "active", proposedBy: "owner" }));
});
after(async () => {
  await closeDb();
  await store.end();
});

test("I71-6: the catalog lists the factory teams from the kit", async () => {
  const t = (await call("GET", "/api/company/teams")).json.teams as Json[];
  assert.deepEqual(t.filter((x) => x.origin === "factory").map((x) => x.slug).sort(), ["lanzamiento", "minimo", "producto-web", "producto-web-con-revision"]);
});

test("I71-6 #2 #3: saving a team and adopting it elsewhere yields the same seats, managers, skills and motors, paused; the preview writes nothing", async () => {
  const saved = await call("POST", "/api/company/projects/tienda/teams/save", { name: "Mi equipo de siempre", lessons: true });
  assert.equal(saved.status, 201, JSON.stringify(saved.json));
  assert.equal(saved.json.origin, "owner");
  assert.ok(saved.json.spec.lessons.some((l: Json) => l.role === "taller"));
  await project("cine", "Cine");
  const before = await store.count("agents");
  const pv = await call("GET", `/api/company/projects/cine/teams/${saved.json.slug}/adopt?mode=keep`);
  assert.equal(pv.status, 200, JSON.stringify(pv.json));
  assert.deepEqual(pv.json.arrives.map((x: Json) => x.role).sort(), ["artist", "product-owner", "qa", "research", "taller"]);
  assert.equal(await store.count("agents"), before, "the preview wrote no seat");
  assert.equal(await store.count("teamAdoptions"), 0, "nor an adoption");
  const done = await call("POST", `/api/company/projects/cine/teams/${saved.json.slug}/adopt`, { mode: "keep" });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  const a = await seats("tienda");
  const b = await seats("cine");
  assert.deepEqual(
    b.map((x) => [x.t, x.boss, x.model, x.effort]),
    a.map((x) => [x.t, x.boss, x.model, x.effort]),
  );
  assert.deepEqual(b.find((x) => x.t === "taller")!.packs, ["tdd", "pr"], "the skills it carried came by name");
  assert.ok(b.every((x) => x.paused), "every new seat arrives paused");
  assert.equal(await store.count("teamAdoptions"), 1);
  assert.equal(await store.count("lessons", { agentId: (await store.get("agents", { slug: "taller-cine" }))!.id }), 1, "the ticked lessons came");
});

test("I71-6 #4: an exported company holds no secret value, task, usage figure or machine path", async () => {
  const ex = await call("GET", "/api/company/export?lessons=1&references=1");
  assert.equal(ex.status, 200);
  const files = ex.json.files as { path: string; content: string }[];
  const paths = files.map((f) => f.path);
  for (const p of ["COMPANY.md", "teams/tienda/TEAM.md", "agents/taller-tienda/AGENTS.md", "plania.yaml"]) assert.ok(paths.includes(p), p);
  assert.ok(paths.some((p) => /^skills\/tono-de-la-marca\/SKILL\.md$/.test(p)));
  const all = files.map((f) => f.content).join("\n");
  for (const bad of [/sk-live-abcdefghijklmnop123456/, /\/Users\//, /TND-1/, /carrito secreto/, /tokens?_total|input_tokens|used_week/, /[A-Za-z]:\\/]) assert.ok(!bad.test(all), `nothing like ${bad}`);
  // Keys travel by name only.
  assert.match(files.find((f) => f.path === "plania.yaml")!.content, /TIENDA_DEPLOY_TOKEN/);
  // The tar holds the same files.
  const res = await app.request("/api/company/export.tar", { headers: owner() });
  assert.equal(res.headers.get("content-type"), "application/x-tar");
  const back = pkg.untar(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(back.map((f) => f.path).sort(), paths.filter((p) => p).sort());
});

test("I71-6 #5: export then import into an emptied database reproduces teams, managers, owner skills and motors; a collision renames", async () => {
  const files = (await call("GET", "/api/company/export")).json.files as { path: string; content: string }[];
  const tarB64 = pkg.tarOf(files).toString("base64");
  const expect = { tienda: await seats("tienda"), cine: await seats("cine") };
  // An emptied database: what the foreign keys took with each project goes with it (deleteProject follows them).
  await store.fix(async (uow) => {
    for (const t of ["teamAdoptions", "lessons", "skillVersions", "skills"] as const) await uow.delete(t, {});
    await uow.delete("puestos", { origin: "owner" });
    await uow.delete("agents", { slug: ne("ceo") });
    await uow.delete("tasks", {});
    for (const p of await uow.find("projects")) await deleteProject(uow, p.id);
  });
  const pv = await call("POST", "/api/company/import/preview", { source: { tar: tarB64 } });
  assert.equal(pv.status, 200, JSON.stringify(pv.json));
  assert.deepEqual(pv.json.items.filter((i: Json) => i.kind === "team").map((i: Json) => [i.key, i.action]), [["team:cine", "create"], ["team:tienda", "create"]]);
  assert.equal(await store.count("projects"), 0, "the preview wrote nothing");
  const done = await call("POST", "/api/company/import", { source: { tar: tarB64 } });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  for (const p of ["tienda", "cine"] as const) {
    const got = await seats(p);
    assert.deepEqual(got.map((x) => [x.t, x.boss, x.model, x.effort]), expect[p].map((x) => [x.t, x.boss, x.model, x.effort]), p);
    assert.ok(got.every((x) => x.paused), `${p}: everyone arrives paused`);
  }
  const tonoRow = (await store.get("skills", { slug: "tono-de-la-marca" }))!;
  const tono = { state: tonoRow.state, body: (await store.get("skillVersions", { skillId: tonoRow.id }))!.body };
  assert.deepEqual({ state: tono.state, body: tono.body.trim() }, { state: "off", body: "# Tono\n\nCercano y claro." });
  // Again: every name is taken now, so the default is rename.
  const again = await call("POST", "/api/company/import/preview", { source: { files } });
  assert.deepEqual(again.json.items.filter((i: Json) => i.kind === "team").map((i: Json) => [i.action, i.to]), [["rename", "cine-2"], ["rename", "tienda-2"]]);
  const skip = await call("POST", "/api/company/import", { source: { files }, choices: { "team:cine": "skip", "skill:tono-de-la-marca": "skip" } });
  assert.deepEqual(skip.json.renamed, ["team:tienda→tienda-2"]);
  assert.ok(skip.json.skipped.includes("team:cine"));
  assert.equal(await store.count("projects", { slug: "cine-2" }), 0);
});

test("I71-6 #6: a Paperclip-style team with adapter fields Plania does not know imports and lists what it ignored", async () => {
  const files = [
    { path: "COMPANY.md", content: "---\nname: Acme Labs\nschema: agentcompanies/v1\nbudgetMonthlyCents: 5000\n---\n" },
    { path: "teams/web/TEAM.md", content: "---\nname: Web\nmanager: cto\nheartbeat: 30m\n---\n" },
    { path: "agents/cto/AGENTS.md", content: "---\nname: Ada\ntitle: CTO\nteam: web\nreportsTo: null\nadapterType: claude_local\nadapterConfig:\n  cwd: /srv/acme\nbudgetMonthlyCents: 2000\nskills: [tdd]\n---\nYou lead engineering.\n" },
    { path: "agents/dev/AGENTS.md", content: "---\nname: Bo\ntitle: Software Engineer\nteam: web\nreportsTo: cto\nadapterType: codex_local\nskills: [pr]\n---\n" },
    { path: ".paperclip.yaml", content: "agents:\n  cto:\n    adapter: claude_local\n" },
  ];
  const team = await call("POST", "/api/company/teams/import", { source: { files } });
  assert.equal(team.status, 201, JSON.stringify(team.json));
  assert.ok(team.json.ignored.includes("agents/cto/AGENTS.md: adapterType"));
  assert.ok(team.json.ignored.includes("agents/cto/AGENTS.md: budgetMonthlyCents"));
  const cat = ((await call("GET", "/api/company/teams")).json.teams as Json[]).find((t) => t.slug === team.json.slug)!;
  assert.equal(cat.origin, "imported");
  assert.deepEqual(cat.spec.seats.map((s: Json) => [s.role, s.reports_to]), [["product-owner", null], ["taller", "product-owner"]]);
  const whole = await call("POST", "/api/company/import/preview", { source: { files } });
  assert.equal(whole.status, 200);
  assert.ok(whole.json.ignored.length >= 4);
  const done = await call("POST", "/api/company/import", { source: { files } });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.deepEqual((await seats("web")).map((x) => [x.t, x.boss]), [["product-owner", null], ["taller", "product-owner"]]);
});
