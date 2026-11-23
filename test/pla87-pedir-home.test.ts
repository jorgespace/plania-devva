// PLA-87: Inicio's Pedir cut a 501-character request to a 200-character Backlog ticket with no scope. It now sends
// through La corriente's ask route (the idea flow) with the same 2000-character limit. Throwaway DB, fake values only.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { resetTestStore, useOwnerCode, useTestEnv, type TestStore } from "./helpers.js";

useTestEnv();
await useOwnerCode();
process.env.PLANIA_HOME_PROJECT = "zigzag";
process.env.PLANIA_PROMPTS_PROJECT = "micasa";
const { makeDb } = await import("../src/db/client.js");
const { app } = await import("../src/app.js");
const { createSession, SESSION_COOKIE } = await import("../src/auth/session.js");
const { seedOrg } = await import("../scripts/seed-org.js");
const { ne } = await import("../src/store/types.js");

type Json = Record<string, any>;
let store: TestStore;
let closeDb: () => Promise<void>;
const jorge = () => ({ Cookie: `${SESSION_COOKIE}=${createSession()}`, "Content-Type": "application/json" });

before(async () => {
  store = await resetTestStore();
  const made = makeDb();
  closeDb = made.close;
  await seedOrg(made.db);
  await store.fix(async (uow) => {
    await uow.update("runnerSettings", { id: 1 }, { companyPaused: false });
    await uow.update("projects", { slug: ne("micasa") }, { runsPaused: true });
    await uow.update("projects", { slug: "micasa" }, { runsPaused: false });
  });
});
after(async () => {
  await closeDb?.();
  await store?.end();
});

test("PLA-87 #1: Inicio's Pedir uses the ask route, its modes and ASK_MAX, never the 200-character ticket route", async () => {
  const src = await readFile(new URL("../ui/src/components/pedir.tsx", import.meta.url), "utf8");
  assert.match(src, /api\.askProject\(/);
  assert.doesNotMatch(src, /createTask\(/);
  assert.match(src, /maxLength=\{ASK_MAX\}/);
  assert.doesNotMatch(src, /maxLength=\{200\}/);
  assert.match(src, /MODES\.map/);
});

test("PLA-87 #2: a 501-character request sent as Darle forma arrives whole, as an idea", async () => {
  const text = `Agenda en línea: ${"la novia elige sucursal, día y hora. ".repeat(14)}`.slice(0, 500) + "x";
  assert.equal(text.length, 501);
  const res = await app.request("/api/company/projects/micasa/ask", { method: "POST", headers: jorge(), body: JSON.stringify({ text, mode: "forma" }) });
  assert.equal(res.status, 201, await res.clone().text());
  const key = ((await res.json()) as Json).key as string;
  const d = await app.request(`/api/company/projects/micasa/pedidos/${key}`, { headers: jorge() });
  const body = (await d.json()) as Json;
  assert.equal(body.text, text.trim());
  const row = (await store.get("tasks", { key }))!;
  assert.equal(row.kind, "idea");
});
