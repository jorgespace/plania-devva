// The move from main's Postgres store to the devva store (src/store/from-postgres.ts): a throwaway Postgres
// database (plania_test_*) is read and copied into a test store's own lobes.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { PG_USER, useTestEnv } from "./helpers.js";

useTestEnv();
const { DevvaStore } = await import("../src/store/devva.js");
const { copyInto, postgresSource, readSource, refusals, storeCounts } = await import("../src/store/from-postgres.js");
type Store = Awaited<ReturnType<typeof DevvaStore.open>>;

const hash = createHash("sha1").update(import.meta.dirname).digest("hex").slice(0, 10);
const DB = `plania_test_frompg_${hash}`;
const ADMIN = `postgres://${PG_USER}@127.0.0.1:5432/postgres`;
// The engine cannot drop a lobe, so this file always uses the same ones, emptied before and after.
const PREFIX = `t_${hash}_frompg`;

const project = randomUUID();
const at = (iso: string) => new Date(iso);
let pool: pg.Pool;
let store: Store;

async function freshStore(): Promise<Store> {
  const s = await DevvaStore.open({ prefix: PREFIX });
  if (s.commits === 0) return s;
  await s.purge();
  s.close();
  return DevvaStore.open({ prefix: PREFIX });
}

before(async () => {
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`drop database if exists ${DB} with (force)`);
  await admin.query(`create database ${DB}`);
  await admin.end();
  pool = new pg.Pool({ connectionString: `postgres://${PG_USER}@127.0.0.1:5432/${DB}` });
  // Two of the schema's tables as an older database has them (fewer columns, one gone since), and one table
  // the schema no longer knows.
  await pool.query(`
    create table projects (id uuid primary key, slug text not null unique, title text not null, key_prefix text not null default '',
      settings jsonb not null default '{}', created_at timestamptz not null default now(), legacy text);
    create table events (id bigint generated always as identity primary key, project_id uuid not null, task_key text,
      type text not null, actor jsonb not null, payload jsonb not null default '{}', created_at timestamptz not null default now());
    create table old_things (x int);
  `);
  await pool.query(`insert into projects (id, slug, title, key_prefix, settings, created_at, legacy) values ($1, 'micasa', 'MiCasa', 'MIC', $2, $3, 'old')`, [
    project,
    { release_target: "prod", quotas: { runs: 3 } },
    at("2026-03-01T10:00:00.123Z"),
  ]);
  for (const [i, type] of ["task.created", "task.status", "task.comment"].entries()) {
    await pool.query(`insert into events (project_id, task_key, type, actor, payload, created_at) values ($1, 'MIC-1', $2, $3, $4, $5)`, [
      project,
      type,
      { agent: "owner", session_id: "web" },
      { n: i, list: ["a", "b"] },
      at(`2026-03-0${i + 2}T08:00:00Z`),
    ]);
  }
  store = await freshStore();
});

after(async () => {
  await pool?.end();
  if (store) {
    await store.purge();
    store.close();
  }
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`drop database if exists ${DB} with (force)`);
  await admin.end();
});

test("reads what the database has, fills what it lacks, and names what it leaves behind", async () => {
  const data = await readSource(postgresSource(pool), at("2026-11-23T12:00:00Z"));
  const projects = data.report.find((r) => r.table === "projects")!;
  assert.equal(projects.rows, 1);
  assert.deepEqual(projects.dropped, ["legacy"]);
  assert.ok(projects.filled.includes("body") && projects.filled.includes("version"), projects.filled.join(","));
  assert.deepEqual(projects.unfillable, []);
  assert.equal(data.report.find((r) => r.table === "events")!.rows, 3);
  assert.equal(data.report.find((r) => r.table === "tasks")!.absent, true);
  assert.deepEqual(data.unknown, ["old_things"]);
  assert.deepEqual(refusals(data), []);

  const [row] = data.tables.find((t) => t.table === "projects")!.rows;
  assert.equal(row!.id, project);
  assert.equal(row!.body, "");
  assert.equal(row!.version, 1);
  assert.deepEqual(row!.createdAt, at("2026-03-01T10:00:00.123Z"));
  assert.deepEqual(row!.settings, { release_target: "prod", quotas: { runs: 3 } });
  assert.equal("legacy" in row!, false);
});

test("copies every row as it is, numbers the next event after the copied ones, and refuses a store with commits", async () => {
  const data = await readSource(postgresSource(pool));
  const commits = await copyInto(store, data);
  assert.equal(commits, 1);
  const counts = await storeCounts(store);
  assert.equal(counts.get("projects"), 1);
  assert.equal(counts.get("events"), 3);

  const events = await store.read((r) => r.find("events", { projectId: project }, { orderBy: [{ column: "id" }] }));
  assert.deepEqual(events.map((e) => e.id), [1, 2, 3]);
  assert.deepEqual(events[1]!.createdAt, at("2026-03-03T08:00:00Z"));
  assert.deepEqual(events[1]!.payload, { n: 1, list: ["a", "b"] });
  assert.deepEqual(events[1]!.actor, { agent: "owner", session_id: "web" });
  assert.equal(events[1]!.tokenId, null);

  const next = await store.write("", {}, (uow) => uow.insert("events", { projectId: project, type: "task.note", actor: { agent: "owner", session_id: "web" } }));
  assert.equal(next.id, 4);

  // A second boot replays the copy from the log and finds the same rows.
  store.close();
  store = await DevvaStore.open({ prefix: PREFIX });
  assert.equal((await storeCounts(store)).get("events"), 4);
  assert.equal(await store.verify(), 0);

  await assert.rejects(copyInto(store, data), /already holds/);
});

test("a table with rows that lacks a required column with no default refuses the copy", async () => {
  const data = await readSource({
    tables: async () => ["projects"],
    columns: async () => ["id", "slug"],
    rows: async () => [{ id: randomUUID(), slug: "x" }],
  });
  const [refused] = refusals(data);
  assert.equal(refused?.table, "projects");
  assert.deepEqual(refused?.unfillable, ["title"]);
  const held = store.commits;
  await assert.rejects(copyInto(store, data), /projects\.title/);
  assert.equal(store.commits, held);
});
