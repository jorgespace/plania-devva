// PLA-I32-2: one team per project. The roster as it stands before the deploy (11 rows, fake values, the
// same shape) is rebuilt on a fresh test store with six projects, then seedOrg runs the way Jorge's deploy
// runs it, twice. Never a real database.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resetTestStore, useTestEnv } from "./helpers.js";

useTestEnv();
const { makeDb } = await import("../src/db/client.js");
const { seedOrg } = await import("../scripts/seed-org.js");
const { roleOf } = await import("../src/runner/limits.js");
const { notNull } = await import("../src/store/types.js");

const PROJECTS: [slug: string, title: string, prefix: string][] = [
  ["alfa", "Alfa", "ALF"],
  ["bravo", "Bravo", "BRV"],
  ["charlie", "Charlie", "CHA"],
  ["delta", "Delta", "DEL"],
  ["eco", "Eco", "ECO"],
  ["plania", "Plania", "PLA"],
];

// Today's 11 rows after PLA-I30-1 (fake names, same roles).
const ROSTER: [slug: string, name: string, role: string, title: string, kind: string, caps: string, parent: string | null][] = [
  ["ceo", "CEO", "human", "CEO", "human", "{}", null],
  ["asistente", "Asistente", "chief-of-staff", "Chief of Staff", "bot", "{staff}", "ceo"],
  ["taller", "Taller", "taller", "Builder", "bot", "{engineering}", "ceo"],
  ["research", "Research", "shared", "Shared service", "bot", "{research}", "asistente"],
  ["artist", "Artist", "shared", "Shared service", "bot", "{design}", "asistente"],
  ["po-charlie", "Bot Charlie", "product-owner", "Product owner", "bot", "{charlie}", "ceo"],
  ["po-alfa", "Casita", "product-owner", "Product owner", "bot", "{alfa}", "ceo"],
  ["po-delta", "Delta", "product-owner", "Product owner", "bot", "{delta}", "ceo"],
  ["po-bravo", "Bravo", "product-owner", "Product owner", "bot", "{bravo}", "ceo"],
  ["po-eco", "Eco", "product-owner", "Product owner", "bot", "{eco}", "ceo"],
  ["po-plania", "Plania", "product-owner", "Product owner", "bot", "{plania}", "ceo"],
];

test("I32-2: today's 11-row roster becomes asistente, ceo and six teams of four; the shared three retire with their history", async () => {
  // The test store starts with its four seeded projects, none of them these six: they go (nothing hangs off them yet),
  // and the roster starts empty.
  const store = await resetTestStore();
  try {
    // A Postgres array literal ("{a,b}") as a list.
    const list = (literal: string) => literal.slice(1, -1).split(",").filter(Boolean);
    await store.fix(async (uow) => {
      await uow.delete("projects", { slug: ["micasa", "workia", "filmia", "zigzag"] });
      for (const [slug, title, prefix] of PROJECTS) if (!(await uow.get("projects", { slug }))) await uow.insert("projects", { slug, title, keyPrefix: prefix });
      for (const [slug, nm, role, title, kind, caps] of ROSTER) {
        await uow.insert("agents", { slug, name: nm, role, title, kind, adapter: kind === "human" ? "none" : "claude_code", adapterConfig: { command_env: "CLAUDE_CODE_BIN" }, capabilities: list(caps) });
      }
      for (const [slug, , , , , , parent] of ROSTER) {
        if (parent) await uow.update("agents", { slug }, { reportsTo: (await uow.get("agents", { slug: parent }))!.id });
      }
    });
    const id = async (slug: string) => {
      const agent = await store.get("agents", { slug });
      assert.ok(agent, slug);
      return agent.id;
    };
    const pid = (slug: string) => store.projectId(slug);
    // History on the rows that change or stay: runs of an existing PO and of the shared taller,
    // an open ticket of the shared taller in alfa and a closed one in bravo.
    const [poAlfa, taller, poPlania, alfa, bravo] = [await id("po-alfa"), await id("taller"), await id("po-plania"), await pid("alfa"), await pid("bravo")];
    await store.fix(async (uow) => {
      await uow.insert("agentRuns", { agentId: poAlfa, projectId: alfa, role: "product-owner", status: "ok" });
      await uow.insert("agentRuns", { agentId: poAlfa, projectId: alfa, role: "product-owner", status: "fail" });
      await uow.insert("agentRuns", { agentId: taller, projectId: alfa, role: "taller", status: "ok" });
      await uow.insert("heartbeatRuns", { agentId: poPlania, startedAt: uow.now, status: "ok", adapter: "claude_code" });
      await uow.insert("tasks", { projectId: alfa, key: "ALF-1", title: "Fake open ticket", kind: "ticket", status: "Ready", ownerAgent: taller });
      await uow.insert("tasks", { projectId: bravo, key: "BRV-1", title: "Fake closed ticket", kind: "ticket", status: "Done", ownerAgent: taller });
    });
    const alfaPoId = await id("po-alfa");

    const { db } = makeDb();
    const first = await seedOrg(db);
    assert.deepEqual(first.retired.sort(), ["artist", "research", "taller"]);
    const second = await seedOrg(db);
    assert.deepEqual([second.inserted, second.removed, second.retired], [[], [], []], "a second run changes nothing");

    const agents = await store.find("agents", {}, { orderBy: [{ column: "slug" }] });
    const projectSlug = new Map((await store.find("projects")).map((p) => [p.id, p.slug]));
    const agentSlug = new Map(agents.map((a) => [a.id, a.slug]));
    const rows = agents.map((a) => ({
      slug: a.slug,
      status: a.status,
      adapter: a.adapter,
      project: a.projectId ? (projectSlug.get(a.projectId) ?? null) : null,
      role_template: a.roleTemplate,
      boss: a.reportsTo ? (agentSlug.get(a.reportsTo) ?? null) : null,
      note: a.note,
      role: a.role,
      capabilities: a.capabilities,
    }));
    const live = rows.filter((r) => r.status !== "retired");
    const company = live.filter((r) => !r.project).map((r) => r.slug);
    assert.deepEqual(company, ["asistente", "ceo"]);
    assert.equal(live.find((r) => r.slug === "asistente")!.role_template, "asistente");
    for (const [slug] of PROJECTS) {
      const team = live.filter((r) => r.project === slug);
      assert.deepEqual(
        team.map((r) => [r.slug, r.role_template, r.boss]),
        [
          [`artist-${slug}`, "artist", `po-${slug}`],
          [`po-${slug}`, "product-owner", "ceo"],
          [`research-${slug}`, "research", `po-${slug}`],
          [`taller-${slug}`, "taller", `po-${slug}`],
        ],
        slug,
      );
      for (const r of team) {
        assert.equal(r.adapter, "claude_code", r.slug);
        assert.equal(roleOf({ slug: r.slug, role: r.role, capabilities: r.capabilities, roleTemplate: r.role_template }), r.role_template, r.slug);
      }
    }
    assert.equal(live.length, 2 + 6 * 4);

    const retired = rows.filter((r) => r.status === "retired");
    assert.deepEqual(retired.map((r) => [r.slug, r.adapter, r.project]), [["artist", "none", null], ["research", "none", null], ["taller", "none", null]]);

    // An existing PO keeps its id, name and runs (PLA-I2-3: no slug is renamed any more).
    const alfaPo = (await store.get("agents", { slug: "po-alfa" }))!;
    assert.equal(alfaPo.id, alfaPoId);
    assert.equal(alfaPo.name, "Casita");
    assert.equal(await store.count("agentRuns", { agentId: alfaPoId }), 2);
    assert.equal(await store.count("heartbeatRuns", { agentId: await id("po-plania") }), 1);
    assert.equal((await store.get("agents", { slug: "po-charlie" }))!.name, "Bot Charlie", "an existing name is kept");

    // The shared taller keeps its run; its open ticket moved to the project's Taller, the closed one stayed.
    assert.equal(await store.count("agentRuns", { agentId: await id("taller") }), 1);
    const slugOf = new Map((await store.find("agents")).map((a) => [a.id, a.slug]));
    const owners = (await store.find("tasks", { ownerAgent: notNull() }, { orderBy: [{ column: "key" }] })).map((t) => ({ key: t.key, slug: slugOf.get(t.ownerAgent!) }));
    assert.deepEqual(owners, [{ key: "ALF-1", slug: "taller-alfa" }, { key: "BRV-1", slug: "taller" }]);
  } finally {
    await store.end();
  }
});
