// PLA-I2-14: the owner has a name of their own. Neutral stored and wire values, one display name, the old spellings
// read for one protocol version with a warning, and migration 0062 for rows written before (on the devva store, the data
// step src/store/owner-neutral.ts).
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resetTestStore, useTestEnv, type TestStore } from "./helpers.js";

useTestEnv();
delete process.env.PLANIA_CEO_NAME;
const { makeDb } = await import("../src/db/client.js");
const { createMcpServer } = await import("../src/mcp/register.js");
const { ERRORS } = await import("../src/mcp/errors.js");
const { PROTOCOL_VERSION, instructions } = await import("../src/mcp/protocol.js");
const owner = await import("../src/owner.js");

type Json = Record<string, any>;
const ROOT = path.resolve(import.meta.dirname, "..");
const FIRST = /jorge/i; // the first owner's name, which a fresh install must never show
const A = { agent: "test-agent", session_id: "s1", machine: "ci" };
const P = { project: "zigzag" };
const T = { scope: "s", checks: ["c"] };

let store: TestStore;
let db: ReturnType<typeof makeDb>["db"];

async function connect(): Promise<Client> {
  const server = createMcpServer(db);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
async function callWith(client: Client, name: string, args: Json = {}): Promise<Json> {
  const r = (await client.callTool({ name, arguments: { actor: A, ...P, ...args } })) as { isError?: boolean; content: { text: string }[] };
  const data = JSON.parse(r.content[0]!.text) as Json;
  return r.isError ? { __error: data.error, ...data } : data;
}

before(async () => {
  store = await resetTestStore();
  db = makeDb().db;
});
after(async () => {
  owner.resetOwnerName(null);
});

// Every string a field description carries, at any depth of a JSON schema.
function descriptions(schema: unknown, out: string[] = []): string[] {
  if (schema && typeof schema === "object") {
    for (const [k, v] of Object.entries(schema)) {
      if (k === "description" && typeof v === "string") out.push(v);
      else descriptions(v, out);
    }
  }
  return out;
}

// Code lines of a source file: comments dropped, and the lines that read the old spelling on purpose (tagged).
function codeLines(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l) && !/PLA-I2-14/.test(l))
    .map((l) => l.replace(/\s\/\/ .*$/, ""));
}
const walk = (dir: string, ext: RegExp): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p, ext) : ext.test(f) ? [p] : [];
  });

describe("check 1: a fresh install with another name", () => {
  test("no tool description, field description, protocol line or error text names the first owner; the name reads instead", async () => {
    owner.resetOwnerName("Ana");
    const client = await connect();
    const { tools } = await client.listTools();
    assert.ok(tools.length > 40);
    for (const t of tools) {
      assert.doesNotMatch(t.description ?? "", FIRST, `${t.name} description`);
      for (const d of descriptions(t.inputSchema)) assert.doesNotMatch(d, FIRST, `${t.name} field: ${d}`);
    }
    const proto = client.getInstructions() ?? "";
    assert.doesNotMatch(proto, FIRST);
    assert.match(proto, /Need Ana to decide\? ask/);
    assert.match(proto, /a line that starts with "Owner:" becomes one/);
    assert.match(tools.find((t) => t.name === "ask")!.description!, /^Ask Ana a question/);
    for (const [code, [, text]] of Object.entries(ERRORS)) assert.doesNotMatch(text, FIRST, code);
    await client.close();
  });

  test("without a name the text says the owner, and «el dueño» on screen", () => {
    owner.resetOwnerName(null);
    assert.match(instructions(false), /Need the owner to decide\? ask/);
    assert.equal(owner.ownerName("es", { capital: true }), "El dueño");
    assert.equal(owner.ownerEs("de"), "del dueño");
    assert.equal(owner.ownerEs("a"), "al dueño");
    owner.resetOwnerName("Ana");
    assert.equal(owner.ownerEs("de"), "de Ana");
    assert.equal(owner.personalize("Only the owner ships; the owner's screen; owner_agent stays"), "Only Ana ships; Ana's screen; owner_agent stays");
  });

  test("the screen's wording modules and the server's Spanish text never name the first owner; «Te toca» stays", () => {
    const files = [...walk(path.join(ROOT, "ui/src"), /\.(ts|tsx)$/), ...walk(path.join(ROOT, "src"), /\.ts$/).filter((f) => !f.endsWith(`${path.sep}owner.ts`))];
    const hits = files.flatMap((f) => codeLines(f).filter((l) => /\bJorge\b/.test(l)).map((l) => `${path.relative(ROOT, f)}: ${l.trim().slice(0, 120)}`));
    assert.deepEqual(hits, []);
    // PLA-I1-2: Progreso's status words left with the page; the decisions module still says «Te toca».
    assert.match(readFileSync(path.join(ROOT, "src/api/company-decisions.ts"), "utf8"), /lo aplazó desde Te toca\./);
  });

  test("the display name is stored once, read at start, and the brief falls back to it", async () => {
    owner.resetOwnerName(null);
    assert.equal(await owner.loadOwnerName(db), null);
    assert.equal(await owner.setOwnerName(db, "  Ana   María "), "Ana María");
    owner.resetOwnerName(null);
    assert.equal(await owner.loadOwnerName(db), "Ana María");
    const { resolveBriefSettings, DEFAULT_SETTINGS } = await import("../src/brief/settings.js");
    assert.equal(resolveBriefSettings(DEFAULT_SETTINGS, {}).owner_name, "Ana María");
    assert.equal(await owner.setOwnerName(db, null), null);
  });
});

describe("check 3: old spellings read the same, with a warning", () => {
  let client: Client;
  before(async () => {
    owner.resetOwnerName("Ana");
    client = await connect();
  });
  after(() => client.close());

  test("delegated_by_jorge moves the ticket like delegated_by_owner, and warns", async () => {
    const make = async (title: string) => (await callWith(client, "create_task", { title, ...T })).key as string;
    const version = async (key: string) => (await callWith(client, "get_task", { key })).version;
    const a = await make("Neutral");
    const b = await make("Old");
    const neutral = await callWith(client, "set_task", { key: a, status: "Won't do", version: await version(a), reason: "ya no hace falta", delegated_by_owner: { message_id: "msg-owner-0901", quote: "márcalo como no se hace" } });
    const old = await callWith(client, "set_task", { key: b, status: "Won't do", version: await version(b), reason: "ya no hace falta", delegated_by_jorge: { message_id: "msg-owner-0902", quote: "márcalo como no se hace" } });
    assert.equal(neutral.status, "Won't do", JSON.stringify(neutral));
    assert.equal(old.status, neutral.status, JSON.stringify(old));
    assert.equal((neutral.warnings ?? []).some((w: Json) => w.code === "OLD_SPELLING"), false);
    const w = old.warnings.find((x: Json) => x.code === "OLD_SPELLING");
    assert.deepEqual({ used: w.used, read_as: w.read_as }, { used: "delegated_by_jorge", read_as: "delegated_by_owner" });
    const ev = (await store.find("events", { type: "task.delegated_move" })).filter((e) => (e.payload as Json).message_id === "msg-owner-0902");
    assert.equal(ev.length, 1);
  });

  test("a line that starts with the old name or the display name becomes a blocker like an Owner: line; both warn", async () => {
    const key = (await callWith(client, "create_task", { kind: "initiative", title: "Lines", scope: "s" })).key as string;
    const v = async () => (await callWith(client, "get_task", { key })).version;
    await callWith(client, "set_task", { key, status: "Active", version: await v() });
    const neutral = await callWith(client, "set_task", { key, next_action: "Owner: rotate the token", version: await v() });
    const old = await callWith(client, "set_task", { key, next_action: "Owner: rotate the token\nJorge: sign the form", version: await v() });
    const named = await callWith(client, "set_task", { key, next_action: "Owner: rotate the token\nJorge: sign the form\nAna: approve the listing", version: await v() });
    const codes = (r: Json) => (r.warnings ?? []).map((w: Json) => w.code);
    assert.deepEqual(codes(neutral), ["OWNER_LINE_PARSED"]);
    assert.deepEqual(codes(old), ["OWNER_LINE_PARSED", "OLD_SPELLING"]);
    assert.deepEqual(codes(named), ["OWNER_LINE_PARSED", "OLD_SPELLING"]);
    const task = (await store.get("tasks", { key }))!;
    const rows = await store.find("blockers", { taskId: task.id }, { orderBy: [{ column: "createdAt" }] });
    assert.deepEqual(rows.map((r) => [(r.spec as Json).assignee, (r.spec as Json).text]), [["owner", "rotate the token"], ["owner", "sign the form"], ["owner", "approve the listing"]]);
  });

  test("list_tasks reads the old status and says so; an agent may not write as owner or as the old name", async () => {
    const key = (await callWith(client, "create_task", { title: "Asked", ...T, status: "Ready" })).key as string;
    const asked = await callWith(client, "ask", { key, question: "¿Cuál?", options: ["a", "b"] });
    assert.equal(asked.__error, undefined, JSON.stringify(asked));
    const neutral = await callWith(client, "list_tasks", { status: "Needs owner" });
    const old = await callWith(client, "list_tasks", { status: "Needs Jorge" });
    assert.deepEqual(old.tasks.map((t: Json) => t.key), neutral.tasks.map((t: Json) => t.key));
    assert.ok(neutral.tasks.some((t: Json) => t.key === key));
    assert.equal(neutral.warnings, undefined);
    assert.equal(old.warnings[0].code, "OLD_SPELLING");
    for (const agent of ["owner", "Jorge"]) {
      const r = await callWith(client, "set_task", { key, note: "hola", actor: { ...A, agent } });
      assert.equal(r.__error, "RESERVED_ACTOR", agent);
    }
  });
});

describe("check 2: migration 0062 (on the store, the data step src/store/owner-neutral.ts) on rows with the old values", () => {
  // Every row of the tables 0062 rewrites, as text: what a second run must leave as it is.
  const snapshot = async () => {
    const parts: string[] = [];
    for (const t of ["tasks", "events", "blockers", "auditRuns", "threadMessages", "taskComments", "ownerProfile"] as const) {
      for (const r of await store.find(t)) parts.push(`${t} ${JSON.stringify(r)}`);
    }
    return parts.sort().join("|");
  };

  test("old rows read and write correctly after it, and a second run changes nothing", async () => {
    const { ownerNeutral } = await import("../src/store/owner-neutral.js");
    owner.resetOwnerName(null);
    const client = await connect();
    const key = (await callWith(client, "create_task", { title: "Legacy", ...T, status: "Ready" })).key as string;
    const asked = await callWith(client, "ask", { key, question: "¿Sigue?", options: ["sí", "no"] });
    const t = (await store.get("tasks", { key }))!;
    // What a store from before protocol 2.24 holds.
    let th = "";
    await store.fix(async (uow) => {
      await uow.update("tasks", { id: t.id }, { status: "Needs Jorge" as never, origin: "jorge" as never });
      await uow.insert("events", { projectId: t.projectId, taskId: t.id, taskKey: key, type: "task.status", actor: { agent: "jorge", session_id: "web", machine: "screen" }, payload: { from: "Ready", to: "Needs Jorge" } });
      await uow.insert("events", { projectId: t.projectId, taskId: t.id, taskKey: key, type: "note", actor: { agent: "test-agent", session_id: "s1" }, payload: { text: "Jorge pidió esto: lo dejo como estaba" } });
      await uow.insert("blockers", { taskId: t.id, type: "human_action", spec: { assignee: "jorge", text: "firmar", source: "parsed", field: "next_action", line_hash: "abc" } as never });
      const findings = [{ code: "WAITING_ON_JORGE_FREE_TEXT", key, detail: "waits on Jorge", fix_hint: "ask" }];
      if (await uow.get("auditRuns", { projectId: t.projectId })) await uow.update("auditRuns", { projectId: t.projectId }, { findings });
      else await uow.insert("auditRuns", { projectId: t.projectId, count: 1, findings });
      await uow.insert("taskComments", { taskId: t.id, authorAgent: "jorge", body: "Jorge dice hola" });
      th = ((await uow.get("threads", { kind: "project", projectId: t.projectId })) ?? (await uow.insert("threads", { kind: "project", projectId: t.projectId }))).id;
      await uow.insert("threadMessages", { threadId: th, authorAgent: "jorge", authorRole: "ceo", body: "hola" });
    });

    await store.fix(ownerNeutral);
    const row = (await store.get("tasks", { id: t.id }))!;
    assert.deepEqual({ status: row.status, origin: row.origin }, { status: "Needs owner", origin: "owner" });
    const ev = await store.find("events", { taskId: t.id, type: ["task.status", "note"] });
    assert.ok(ev.some((e) => (e.actor as Json).agent === "owner" && (e.payload as Json).to === "Needs owner"));
    assert.ok(ev.some((e) => (e.payload as Json).text === "Jorge pidió esto: lo dejo como estaba"), "free text stays as written");
    assert.equal(((await store.get("blockers", { taskId: t.id }))!.spec as Json).assignee, "owner");
    assert.equal((await store.get("auditRuns", { projectId: t.projectId }))!.findings[0]!.code, "WAITING_ON_OWNER_FREE_TEXT");
    assert.equal((await store.get("taskComments", { taskId: t.id }))!.authorAgent, "owner");
    assert.equal((await store.get("threadMessages", { threadId: th }))!.authorAgent, "owner");

    // Reads and writes work on the rewritten rows.
    assert.equal((await callWith(client, "get_task", { key })).status, "Needs owner");
    assert.ok((await callWith(client, "list_tasks", { status: "Needs owner" })).tasks.some((x: Json) => x.key === key));
    const answered = await callWith(client, "answer", { question_id: asked.question.id, answer: "sí" });
    assert.equal(answered.__error, undefined, JSON.stringify(answered));
    assert.notEqual((await callWith(client, "get_task", { key })).status, "Needs owner");

    const once = await snapshot();
    await store.fix(ownerNeutral);
    assert.equal(await snapshot(), once, "a second run changes nothing");
    await client.close();
  });
});

test("check 4: the protocol version moved and the README tables carry the neutral names", () => {
  assert.equal(PROTOCOL_VERSION, "2.26");
  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /WAITING_ON_OWNER_FREE_TEXT|Needs owner/);
  assert.doesNotMatch(readme.slice(readme.indexOf("<!-- mcp-tools:start -->"), readme.indexOf("<!-- errors:end -->")), /delegated_by_jorge.*\|.*required|RESERVED_ACTOR.*jorge/i);
});
