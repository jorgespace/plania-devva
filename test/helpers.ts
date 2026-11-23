// Shared setup: a throwaway devva store per test file, seeded with the four projects.
// The tests need a running devva engine (deploy/devva/README.md). DEVVA_HOST, DEVVA_PORT and DEVVA_TOKEN_FILE
// say which; every test file writes to lobes of its own (named after the checkout and the file) and empties them.
import { rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { after } from "node:test";
import type { Reader, UnitOfWork } from "../src/store/types.js";

// The comparisons a filter can use, for tests: find("events", { id: gt(cursor) }).
export { gt, gte, lt, lte, ne, notNull } from "../src/store/types.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// PLANIA_TEST_PGUSER: the Postgres role tests use for a PRODUCT's databases (a test copy, the Máquina's reader), when
// it is not the OS user (a Windows machine whose role is postgres). Plania's own data is never in Postgres here.
export const PG_USER = encodeURIComponent(process.env.PLANIA_TEST_PGUSER || (process.platform === "win32" ? "postgres" : userInfo().username));

export const TEST_BEARER = "test-token";
export const TEST_READ_TOKEN = "test-read-token";
export const TEST_CI_TOKEN = "test-ci-token";

// Must run before the app reads its env, so call it at module top level before importing src/.
export function useTestEnv(): void {
  process.env.MCP_BEARER_TOKEN = TEST_BEARER;
  process.env.MCP_READ_TOKEN = TEST_READ_TOKEN;
  process.env.PLANIA_CI_TOKEN = TEST_CI_TOKEN;
  process.env.SESSION_SECRET = "test-session-secret-that-is-at-least-32-bytes";
  process.env.PLANIA_JOBS = "0";
  // PLA-I60-2: admission's free-memory and disk floor reads this machine; tests that check it pass deps.machine.
  process.env.PLANIA_MACHINE_CHECK = "0";
  // PLA-I2-4: machine-bound parts (test copy, stills, base lever) count as available; i2-4 tests decide per case.
  process.env.PLANIA_TEST_SYSTEM_SUPPORT = "all";
  // AUDIT-2: tests never read the repo's own kit (its skills and default kits would join every run). A test that
  // wants a kit points PLANIA_KIT_DIR at its own folder.
  process.env.PLANIA_KIT_DIR ??= path.join(REPO_ROOT, "test", "fixtures", "no-kit");
  // PLA-I72-4: the kept test passwords go to a scratch file, never the user's ~/.config. PLA-159: the file this
  // chose is removed when the test process ends (one was left in the temp folder on every run); a path a test set
  // itself stays the test's to clean.
  if (!process.env.PLANIA_TEST_PASSWORDS_FILE) {
    const file = path.join(tmpdir(), `plania-test-passwords-${process.pid}.json`);
    process.env.PLANIA_TEST_PASSWORDS_FILE = file;
    process.once("exit", () => rmSync(file, { force: true }));
  }
}

// A fresh, seeded store for a test file, and the way a test looks at it: reads (get, find, count) for
// assertions, and fix() for arranging rows no tool would write (a backdated lease, a row in a past state).
export type TestStore = Reader & {
  fix<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T>;
  // The id of one of the four seeded projects (micasa, workia, filmia, zigzag), or of any project by slug.
  projectId(slug: string): Promise<string>;
  end(): Promise<void>;
};

const SEED = [
  ["micasa", "MiCasa", "MIC"],
  ["workia", "Workia", "WRK"],
  ["filmia", "Filmia", "FIL"],
  ["zigzag", "Zigzag", "ZIG"],
] as const;

type DevvaT = Awaited<ReturnType<typeof import("../src/store/devva.js").DevvaStore.open>>;
let open: DevvaT | null = null;
async function endStore(): Promise<void> {
  const old = open;
  open = null;
  if (!old) return;
  const { useDb } = await import("../src/db/client.js");
  useDb(null);
  await old.purge();
  old.close();
}
after(endStore);

// Opens a new store on lobes of its own, makes it the one the app uses, and seeds it. A second call in the
// same file empties and closes the first.
export async function resetTestStore(): Promise<TestStore> {
  const { storeOf } = await import("../src/store/port.js");
  const { makeDb, useDb } = await import("../src/db/client.js");
  const { DevvaStore } = await import("../src/store/devva.js");
  const { seedFixedRows } = await import("../src/store/seed.js");
  await endStore();
  // The engine cannot drop a lobe, so a test file always uses the same ones: named after the checkout and the
  // file, emptied before use (a run that died leaves rows behind) and again when the file ends.
  const { createHash } = await import("node:crypto");
  const prefix = `t_${createHash("sha1").update(`${import.meta.dirname}|${process.argv[1] ?? ""}`).digest("hex").slice(0, 10)}`;
  open = await DevvaStore.open({ prefix });
  if (open.commits > 0) {
    await open.purge();
    open.close();
    open = await DevvaStore.open({ prefix });
  }
  useDb(open.handle);
  await open.write("", {}, async (uow) => {
    for (const [slug, title, keyPrefix] of SEED) await uow.insert("projects", { slug, title, keyPrefix });
    await seedFixedRows(uow);
  });
  // Resolved on every call: the handle changes when the store is rebuilt.
  const store = () => storeOf(makeDb().db);
  return {
    get: (table, key) => store().read((r) => r.get(table, key)),
    find: (table, where, options) => store().read((r) => r.find(table, where, options)),
    count: (table, where) => store().read((r) => r.count(table, where)),
    fix: (fn) => store().write("", {}, fn),
    projectId: async (slug) => {
      const p = await store().read((r) => r.get("projects", { slug }));
      if (!p) throw new Error(`no project ${slug}`);
      return p.id;
    },
    end: endStore,
  };
}

// PLA-I36-11: the owner's code in tests. A fixed secret in a memory store (never the keychain); each call moves
// the TOTP clock one step, so two codes in the same test never share a time step.
const OWNER_SECRET = Buffer.alloc(20, 7);
let ownerTick = 0;
export async function useOwnerCode(enrolled = true): Promise<void> {
  const { MemoryOwnerSecretStore, useOwnerStore } = await import("../src/auth/owner-store.js");
  const store = new MemoryOwnerSecretStore();
  if (enrolled) await store.set(OWNER_SECRET);
  useOwnerStore(store);
}
export async function ownerCode(): Promise<string> {
  const { ownerClock, totp } = await import("../src/auth/owner-totp.js");
  const base = Date.now();
  ownerTick += 1;
  const at = base + ownerTick * 30_000;
  ownerClock.now = () => at;
  return totp(OWNER_SECRET, at);
}
