// PLA-I52-7: tres tipos y el carrete. The kind of change from the diff, «solo lo que no se ve» accepting only what
// does not change the screen, and the release card's reel. Throwaway store and capture store; fictional data.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resetTestStore, useTestEnv, type TestStore } from "./helpers.js";

useTestEnv();
const TMP = mkdtempSync(path.join(tmpdir(), "plania-i52-7-"));
process.env.PLANIA_CAPTURES_DIR = TMP;
(globalThis as { React?: unknown }).React = React;
const { makeDb } = await import("../src/db/client.js");
const writes = await import("../src/mcp/writes.js");
const stills = await import("../src/captures/store.js");
const { encodePng } = await import("../src/captures/diff.js");
const { cambioOf } = await import("../src/captures/muestra.js");
const { autoVerdict } = await import("../src/api/auto-accept.js");
const { releaseReel } = await import("../src/captures/probador.js");
const { resolveThread } = await import("../src/runner/threads.js");

type Json = Record<string, any>;

let store: TestStore;
let db: ReturnType<typeof makeDb>["db"];
const ctx = { actor: { agent: "t", session_id: "s-i52-7", machine: "ci" } };
const png = encodePng({ width: 64, height: 40, channels: 3, data: Buffer.alloc(64 * 40 * 3, 180) });
const taskOf = async (key: string) => (await store.get("tasks", { key }))!;
const setTask = (key: string, patch: Json) => store.fix((uow) => uow.update("tasks", { key }, patch));

before(async () => {
  store = await resetTestStore();
  ({ db } = makeDb());
});
after(async () => {
  await store.end();
  rmSync(TMP, { recursive: true, force: true });
});

describe("the kind of change", () => {
  test("screens are se_ve; mail, exports and jobs se_comporta; the rest no_se_ve; tests never count", () => {
    assert.equal(cambioOf(["src/app/panel/page.tsx", "src/db/x.ts"]), "se_ve");
    assert.equal(cambioOf(["src/lib/mailer.ts"]), "se_comporta");
    assert.equal(cambioOf(["src/lib/panel/exportar-excel.ts"]), "se_comporta");
    assert.equal(cambioOf(["src/jobs/recordatorios.ts"]), "se_comporta");
    assert.equal(cambioOf(["drizzle/0007_sucursales.sql", "src/db/sucursales.ts"]), "no_se_ve");
    assert.equal(cambioOf(["src/lib/mailer.test.ts", "src/db/a.ts"]), "no_se_ve", "a test about mail is not mail");
  });
});

describe("«solo lo que no se ve»", () => {
  test("with only that switch on, a delivery that changes the screen waits for the owner; one that does not goes on", async () => {
    await store.fix(async (uow) => {
      const f = (await uow.get("projects", { slug: "filmia" }))!;
      await uow.update("projects", { id: f.id }, { settings: { ...f.settings, auto_accept_invisible: true } });
    });
    const t = await writes.createTask(db, { project: "filmia", title: "Índices", scope: "s", checks: ["ok"] } as never, ctx as never);
    await setTask(t.key, { status: "In review", cambio: "se_ve" });
    const { thread } = await resolveThread(db, "filmia");
    const m = await store.fix((uow) => uow.insert("threadMessages", { threadId: thread.id, authorAgent: "taller-filmia", authorRole: "taller", body: "Listo", links: [{ kind: "ticket", ref: t.key, title: "Índices" }] }));
    const p = (await store.get("projects", { slug: "filmia" }))!;
    const d: Json = { id: `m-${m.id}`, kind: "pr", asker: { agent: "taller-filmia", role: "taller" }, hold: null, evidence: { verdict: "pass", fail: 0 } };
    assert.equal(await autoVerdict(db, p, d as never), "Cambia lo que se ve: revísala tú.");
    await setTask(t.key, { cambio: null });
    assert.equal(await autoVerdict(db, p, d as never), "No se sabe si cambia la pantalla: revísala tú.");
    await setTask(t.key, { cambio: "no_se_ve" });
    assert.equal(await autoVerdict(db, p, d as never), "Todavía no se lee el PR.", "past the kind check, the usual rules apply");
    const all = { ...p, settings: { ...p.settings, auto_accept: true } };
    await setTask(t.key, { cambio: "se_ve" });
    assert.equal(await autoVerdict(db, all as never, d as never), "Todavía no se lee el PR.", "with the full switch on, the kind does not matter");
  });
});


