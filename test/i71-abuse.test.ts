// PLA-I71: trying to break Equipo's server. Races (two accepts of one proposal, two adds past eight seats, two moves
// that together make a loop), bad input on every route, a garbage company file, a YAML bomb, a package whose managers
// form a loop, two agents with one role, markup in names, and a team that says nothing. Throwaway DB, no network.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ne, resetTestStore, useTestEnv, type TestStore } from "./helpers.js";

const kit = path.join(mkdtempSync(path.join(tmpdir(), "plania-i71-abuse-")), "kit");
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
const { treeOf } = (await import(new URL("../ui/src/lib/organigrama.ts", import.meta.url).href)) as { treeOf: (t: never) => { top: unknown[]; loose: unknown[] } };

type Json = Record<string, any>;
let store: TestStore;
let db: ReturnType<typeof makeDb>["db"];
let closeDb: () => Promise<void>;
const owner = () => ({ Cookie: `${SESSION_COOKIE}=${createSession()}`, "Content-Type": "application/json" });
const call = async (method: string, url: string, body?: unknown, raw_?: string) => {
  const res = await app.request(url, { method, headers: owner(), ...(raw_ !== undefined ? { body: raw_ } : body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
};
const T = "/api/company/projects/tienda";
const live = async (p = "tienda") => store.count("agents", { projectId: await store.projectId(p), status: ne("retired") });
const loops = async () => {
  // Any agent whose chain of managers comes back to itself.
  const rows = (await store.find("agents")).map((a) => ({ id: a.id, reports_to: a.reportsTo }));
  const up = new Map(rows.map((r) => [r.id, r.reports_to]));
  return rows.filter((r) => {
    const seen = new Set<string>();
    for (let at: string | null | undefined = r.reports_to; at; at = up.get(at)) {
      if (at === r.id) return true;
      if (seen.has(at)) return false;
      seen.add(at);
    }
    return false;
  }).length;
};

before(async () => {
  store = await resetTestStore();
  ({ db, close: closeDb } = makeDb());
  await store.fix((uow) => uow.insert("agents", { slug: "ceo", name: "CEO", role: "ceo", kind: "human" }));
  for (const [slug, title] of [["tienda", "Tienda"], ["otro", "Otro"]] as const) {
    const pid = await store.fix(async (uow) => {
      const p = await uow.insert("projects", { slug, title, keyPrefix: slug.slice(0, 3).toUpperCase() });
      if (slug === "tienda") for (const t of ["Product owner", "Taller", "Research", "Artist", "QA", "Copy", "Seguridad", "Marketing", "Data"]) await uow.insert("docs", { projectId: p.id, title: `Prompt: ${t}`, markdown: `# ${t}`, actor: { agent: "t", session_id: "s" } });
      return p.id;
    });
    await ensureTeam(db, { id: pid, slug, title });
  }
});
after(async () => {
  await closeDb();
  await store.end();
});

test("abuse: every seat route refuses bad input with a code, never a 500", async () => {
  const cases: [string, string, unknown, number, string][] = [
    ["PUT", `${T}/team/nadie/pause`, { paused: true }, 404, "AGENT_NOT_FOUND"],
    ["PUT", `${T}/team/taller-tienda/pause`, { paused: "sí" }, 400, "INVALID_BODY"],
    ["PUT", `${T}/team/taller-tienda/manager`, { reports_to: "taller-otro" }, 400, "MANAGER_NOT_ON_TEAM"],
    ["PUT", `${T}/team/taller-tienda/manager`, { reports_to: "ceo" }, 400, "MANAGER_NOT_ON_TEAM"],
    ["PUT", `${T}/team/taller-otro/manager`, { reports_to: null }, 404, "AGENT_NOT_FOUND"],
    ["PUT", `${T}/team/taller-tienda/manager`, { reports_to: "x".repeat(500) }, 400, "INVALID_BODY"],
    ["POST", `${T}/team/taller-tienda/retire`, { now: true }, 400, "INVALID_BODY"],
    ["POST", "/api/company/puestos", { title: "x".repeat(61), line: "", base: "taller" }, 400, "PUESTO_INVALID"],
    ["POST", "/api/company/puestos", { title: "Nuevo", line: "y".repeat(201), base: "taller" }, 400, "PUESTO_INVALID"],
    ["POST", "/api/company/puestos", { title: "Nuevo", line: "", base: "asistente" }, 400, "PUESTO_INVALID"],
    ["POST", "/api/company/puestos", { title: "Taller", line: "", base: "taller" }, 409, "SEAT_TAKEN"],
    ["POST", `${T}/proposals/not-a-uuid/decide`, { accept: true }, 404, "PROPOSAL_NOT_FOUND"],
    ["POST", `${T}/team`, { template: "../../etc" }, 400, "INVALID_TEMPLATE"],
    ["GET", "/api/company/projects/nada/equipo", undefined, 404, "PROJECT_NOT_FOUND"],
    ["GET", "/api/company/projects/nada/tienda", undefined, 404, "PROJECT_NOT_FOUND"],
    ["GET", `${T}/teams/nada/adopt`, undefined, 404, "TEAM_NOT_FOUND"],
    ["POST", `${T}/teams/save`, { name: "" }, 400, "INVALID_BODY"],
    ["POST", "/api/company/import/preview", { source: { url: "javascript:alert(1)" } }, 400, "SKILL_IMPORT_FORMAT"],
    ["POST", "/api/company/import/preview", { source: { url: "https://intranet.test/a" } }, 400, "SKILL_IMPORT_FORMAT"],
    ["POST", "/api/company/import/preview", { source: { files: "no" } }, 400, "INVALID_BODY"],
  ];
  for (const [m, u, b, st, code] of cases) {
    const r = await call(m, u, b);
    assert.equal(r.status, st, `${m} ${u} ${JSON.stringify(b)?.slice(0, 60)}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.error, code, `${m} ${u}`);
  }
  // Not JSON at all.
  assert.equal((await call("PUT", `${T}/team/taller-tienda/pause`, undefined, "{nope")).status, 400);
  assert.equal(await loops(), 0);
});

test("abuse: odd names become safe slugs; markup stays text", async () => {
  const odd = await call("POST", "/api/company/puestos", { title: "Diseño ÑÜ!!", line: "<img src=x onerror=alert(1)>", base: "artist" });
  assert.equal(odd.status, 201, JSON.stringify(odd.json));
  assert.equal(odd.json.slug, "diseno-nu");
  const digits = await call("POST", "/api/company/puestos", { title: "123 ventas", line: "", base: "copy" });
  assert.equal(digits.json.slug, "p-123-ventas");
  const symbols = await call("POST", "/api/company/puestos", { title: "!!!", line: "", base: "copy" });
  assert.equal(symbols.status, 201);
  assert.match(symbols.json.slug, /^[a-z][a-z0-9-]*$/);
  assert.equal((await call("POST", "/api/company/puestos", { title: "!!!", line: "", base: "copy" })).json.error, "SEAT_TAKEN");
});

test("abuse: two moves at once cannot make a loop", async () => {
  // Research and Artist under the PO; ask each to report to the other at the same moment.
  const [a, b] = await Promise.all([call("PUT", `${T}/team/research-tienda/manager`, { reports_to: "artist-tienda" }), call("PUT", `${T}/team/artist-tienda/manager`, { reports_to: "research-tienda" })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.json, b.json]));
  assert.equal(await loops(), 0);
  // A chain of three closed by the last move.
  await call("PUT", `${T}/team/research-tienda/manager`, { reports_to: "po-tienda" });
  await call("PUT", `${T}/team/artist-tienda/manager`, { reports_to: "research-tienda" });
  await call("PUT", `${T}/team/taller-tienda/manager`, { reports_to: "artist-tienda" });
  assert.equal((await call("PUT", `${T}/team/research-tienda/manager`, { reports_to: "taller-tienda" })).json.error, "MANAGER_LOOP");
  assert.equal((await call("PUT", `${T}/team/po-tienda/manager`, { reports_to: "taller-tienda" })).json.error, "MANAGER_LOOP");
  assert.equal(await loops(), 0);
  for (const s of ["artist", "taller"]) await call("PUT", `${T}/team/${s}-tienda/manager`, { reports_to: "po-tienda" });
});

test("abuse: adds at the same moment never pass eight seats", async () => {
  await call("PUT", `${T}/team/research-tienda/pause`, { paused: true });
  await call("PUT", `${T}/team/research-tienda/pause`, { paused: true });
  assert.equal(await live(), 4);
  const tries = await Promise.all(["qa", "copy", "seguridad", "marketing", "data", "diseno-nu", "p-123-ventas"].map((t) => call("POST", `${T}/team`, { template: t })));
  assert.equal(await live(), 8, JSON.stringify(tries.map((t) => [t.status, t.json.error])));
  assert.equal(tries.filter((t) => t.status === 201).length, 4);
  assert.ok(tries.filter((t) => t.status !== 201).every((t) => t.json.error === "TEAM_FULL"), JSON.stringify(tries.map((t) => t.json.error)));
});

test("abuse: a proposal accepted twice at once makes one seat; a full team keeps the proposal waiting", async () => {
  await call("POST", `${T}/team/data-tienda/retire`, {});
  await call("POST", `${T}/team/copy-tienda/retire`, {});
  const pid = await store.projectId("tienda");
  const mk = async (role: string) => (await store.fix((uow) => uow.insert("seatProposals", { projectId: pid, role, reason: "Hace falta.", proposedBy: "po-tienda" }))).id;
  const one = await mk("data");
  const [a, b] = await Promise.all([call("POST", `${T}/proposals/${one}/decide`, { accept: true }), call("POST", `${T}/proposals/${one}/decide`, { accept: true })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.json, b.json]));
  assert.equal([a, b].find((x) => x.status === 409)!.json.error, "PROPOSAL_DECIDED");
  assert.equal(await store.count("agents", { slug: "data-tienda", status: ne("retired") }), 1);
  // Fill the team, then accept another: refused, and the proposal still waits.
  await call("POST", `${T}/team`, { template: "copy" });
  assert.equal(await live(), 8);
  const full = await mk("seguridad-2");
  await store.fix((uow) => uow.update("seatProposals", { id: full }, { role: "marketing" }));
  await call("POST", `${T}/team/marketing-tienda/retire`, {});
  await call("POST", `${T}/team`, { template: "data" }).catch(() => undefined);
  await call("POST", "/api/company/puestos", { title: "Extra", line: "", base: "copy" });
  await call("POST", `${T}/team`, { template: "extra" });
  assert.equal(await live(), 8);
  const refused = await call("POST", `${T}/proposals/${full}/decide`, { accept: true });
  assert.equal(refused.json.error, "TEAM_FULL", JSON.stringify(refused.json));
  assert.equal((await store.get("seatProposals", { id: full }))!.state, "proposed");
});

test("abuse: retire twice, then bring the role back with its history", async () => {
  const id = (await store.get("agents", { slug: "qa-tienda" }))!.id;
  assert.equal((await call("POST", `${T}/team/qa-tienda/retire`, {})).status, 200);
  assert.equal((await call("POST", `${T}/team/qa-tienda/retire`, {})).json.error, "AGENT_NOT_FOUND");
  assert.equal((await call("PUT", `${T}/team/qa-tienda/pause`, { paused: false })).json.error, "AGENT_NOT_FOUND");
  assert.equal((await call("POST", `${T}/team`, { template: "qa" })).status, 201);
  assert.equal((await store.get("agents", { slug: "qa-tienda" }))!.id, id, "the same seat comes back");
});

test("abuse: a garbage company file creates nothing", async () => {
  const before = await store.count("projects");
  for (const tar of [Buffer.from("not a tar at all, just words").toString("base64"), Buffer.alloc(4096, 7).toString("base64"), ""]) {
    const pv = await call("POST", "/api/company/import/preview", { source: { tar } });
    assert.equal(pv.status, 400, JSON.stringify(pv.json));
    assert.equal(pv.json.error, "SKILL_IMPORT_FORMAT");
    assert.equal((await call("POST", "/api/company/import", { source: { tar } })).status, 400);
  }
  assert.equal((await call("POST", "/api/company/import", { source: { files: [{ path: "README.md", content: "hola" }] } })).json.error, "SKILL_IMPORT_FORMAT");
  assert.equal((await call("POST", "/api/company/teams/import", { source: { files: [] } })).json.error, "SKILL_IMPORT_FORMAT");
  assert.equal(await store.count("projects"), before);
});

test("abuse: a package with a manager loop, a YAML bomb, two agents with one role and path tricks imports without a loop", async () => {
  const bomb = `---\na: &a ["x","x","x","x","x","x","x","x","x"]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]\ne: [*d,*d,*d,*d,*d,*d,*d,*d,*d]\nname: Bomba\nteam: lazo\nrole: research\nreportsTo: b-agent\n---\n`;
  const files = [
    { path: "COMPANY.md", content: "---\nname: Lazo\n---\n" },
    { path: "teams/lazo/TEAM.md", content: "---\nname: <script>alert(1)</script>\nmanager: a-agent\n---\n" },
    { path: "agents/a-agent/AGENTS.md", content: "---\nname: A\nteam: lazo\nrole: product-owner\nreportsTo: c-agent\n---\n" },
    { path: "agents/b-agent/AGENTS.md", content: "---\nname: B\nteam: lazo\nrole: taller\nreportsTo: a-agent\n---\n" },
    { path: "agents/c-agent/AGENTS.md", content: "---\nname: C\nteam: lazo\nrole: qa\nreportsTo: b-agent\n---\n" },
    { path: "agents/d-agent/AGENTS.md", content: "---\nname: D\nteam: lazo\nrole: taller\nreportsTo: a-agent\n---\n" },
    { path: "agents/bomb/AGENTS.md", content: bomb },
    { path: "../../etc/passwd", content: "root:x:0:0" },
    { path: "skills/../../x/SKILL.md", content: "---\nname: X\ndescription: y\n---\nbody" },
  ];
  const pv = await call("POST", "/api/company/import/preview", { source: { files } });
  assert.equal(pv.status, 200, JSON.stringify(pv.json));
  const done = await call("POST", "/api/company/import", { source: { files } });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(await loops(), 0, "no manager loop was written");
  assert.ok(done.json.skipped.some((s: string) => /taller/.test(s)), `a second agent with the same role is listed as skipped: ${JSON.stringify(done.json)}`);
  const title = (await store.get("projects", { slug: "lazo" }))?.title;
  assert.equal(title, "<script>alert(1)</script>", "kept as text; the screen escapes it");
  // The imported chart draws: the PO at the top, nobody dropped.
  const team = ((await call("GET", "/api/company/projects/lazo")).json.team as Json[]).map((m) => ({ ...m }));
  const t = treeOf(team as never);
  assert.equal(t.top.length + t.loose.length > 0, true);
  assert.equal(team.length, 4);
});

test("abuse: an imported team whose seats name each other as managers adopts without a loop", async () => {
  const files = [
    { path: "teams/x/TEAM.md", content: "---\nname: Circular\n---\n" },
    { path: "agents/p/AGENTS.md", content: "---\nname: P\nteam: x\nrole: product-owner\nreportsTo: q\n---\n" },
    { path: "agents/q/AGENTS.md", content: "---\nname: Q\nteam: x\nrole: research\nreportsTo: r\n---\n" },
    { path: "agents/r/AGENTS.md", content: "---\nname: R\nteam: x\nrole: artist\nreportsTo: q\n---\n" },
  ];
  const t = await call("POST", "/api/company/teams/import", { source: { files } });
  assert.equal(t.status, 201, JSON.stringify(t.json));
  const p = (await store.fix((uow) => uow.insert("projects", { slug: "circ", title: "Circ", keyPrefix: "CIR" }))).id;
  void p;
  const done = await call("POST", `/api/company/projects/circ/teams/${t.json.slug}/adopt`, { mode: "keep" });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(await loops(), 0);
  // Adopting the same team again brings nobody new.
  const again = await call("GET", `/api/company/projects/circ/teams/${t.json.slug}/adopt`);
  assert.equal(again.json.arrives.length, 0);
});

test("abuse: the package parser survives an empty, huge or binary file", () => {
  assert.doesNotThrow(() => pkg.parsePackage([]));
  assert.doesNotThrow(() => pkg.parsePackage([{ path: "agents/a/AGENTS.md", content: "---\n:::\n\t- [\n---\n" }]));
  assert.doesNotThrow(() => pkg.parsePackage([{ path: "agents/a/AGENTS.md", content: "\u0000\u0001\u0002".repeat(1000) }]));
  assert.equal(pkg.untar(Buffer.alloc(0)).length, 0);
});
