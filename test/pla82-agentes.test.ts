// PLA-82 (F-12): runner sessions got THREAD_FORBIDDEN (agent null) on thread_post to their own project's thread: the
// agent wrote its own session_id (e.g. artist-mianovia-idea3-r2) instead of run-<hex>, so Plania could not tell which
// roster agent it was. The runner now names the run in an X-Plania-Run header. Also: 16-hex run sessions get their
// closing line. Real /mcp requests against the test DB.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { resetTestStore, useTestEnv, type TestStore } from "./helpers.js";

useTestEnv();
const { app } = await import("../src/app.js");
const { makeDb } = await import("../src/db/client.js");
const { seedOrg } = await import("../scripts/seed-org.js");
const { issueToken } = await import("../src/auth/tokens.js");
const { runSession } = await import("../src/runner/run-session.js");
const { mcpConfig } = await import("../src/runner/runner.js");
const { closingLine } = await import("../src/mcp/threads.js");

type Json = Record<string, any>;
let store: TestStore;
let db: ReturnType<typeof makeDb>["db"];
let secret = "";
const RUN = "abcdef12-3456-4789-8000-000000000001";

const rpc = (body: unknown, extra: Record<string, string> = {}) =>
  app.request("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${secret}`, ...extra }, body: JSON.stringify(body) });
const post = async (session: string, extra: Record<string, string> = {}): Promise<Json> => {
  const r = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "thread_post", arguments: { actor: { agent: "plania-runner", session_id: session }, thread: "micasa", body: "Listo el diseño." } } }, extra)).json()) as Json;
  return JSON.parse(r.result.content[0].text);
};

before(async () => {
  store = await resetTestStore();
  ({ db } = makeDb());
  await seedOrg(db);
  secret = (await issueToken(db, { name: "runner", agent: "plania-runner", scopes: ["read", "write"] }, { agent: "owner", session_id: "web" })).secret;
  const po = (await store.get("agents", { slug: "po-micasa" }))!;
  await store.fix((uow) => uow.insert("agentRuns", { id: RUN, agentId: po.id, projectId: po.projectId!, role: "product-owner", status: "running", summary: "s", queuedAt: uow.now, workKey: "general" }));
});
after(async () => {
  await store.end();
});

test("F-12: the runner's config names the run", () => {
  const cfg = mcpConfig("http://127.0.0.1:3737/mcp", null, runSession(RUN)) as Json;
  assert.deepEqual(cfg.mcpServers.plania.headers, { Authorization: "Bearer ${PLANIA_RUNNER_TOKEN}", "X-Plania-Run": "run-abcdef1234564789" });
  assert.equal((mcpConfig("http://x/mcp") as Json).mcpServers.plania.headers["X-Plania-Run"], undefined);
});

test("F-12: a made-up session_id posts as the run's roster agent when the run is named; without it, or with a bad name, it is refused", async () => {
  assert.equal((await post("po-micasa-idea3-r2-20261118")).error, "THREAD_FORBIDDEN", "as before: nobody knows who it is");
  assert.equal((await post("po-micasa-idea3-r2-20261118", { "X-Plania-Run": "run-zz" })).error, "THREAD_FORBIDDEN", "a malformed run name is ignored");
  const ok = await post("po-micasa-idea3-r2-20261118", { "X-Plania-Run": runSession(RUN) });
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.deepEqual(ok.message.author, { agent: "po-micasa", role: "product-owner" });
  assert.equal((await post(runSession(RUN))).message.author.agent, "po-micasa", "the run session in actor works as before");
});

test("PLA-82: a 16-hex run session gets its closing line on finish (the 8-hex-only match dropped it)", async () => {
  const micasa = await store.projectId("micasa");
  const t = await store.fix((uow) => uow.insert("tasks", { projectId: micasa, key: "MIC-77", title: "Botón", kind: "ticket", status: "In review" }));
  const id = await closingLine(db, { actor: { agent: "plania-runner", session_id: runSession(RUN) } } as never, { project: "micasa", key: t.key, via: "finish", cite: "12 pruebas" });
  assert.ok(id);
  const m = (await store.get("threadMessages", { id: id! }))!;
  assert.equal(m.authorAgent, "po-micasa");
  assert.match(m.body, /^MIC-77 queda En revisión/);
});
