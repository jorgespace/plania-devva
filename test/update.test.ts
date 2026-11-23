// PLA-I2-8: updating an installed package and restoring a backup. The update runs on temp folders against its own
// throwaway store on the test engine, with the outside calls injected (unpacking, dependencies, the service, the kit's
// store side); its backup is the real devva one (the nightly job's checked dump of the store's log). The restore test
// loads such a backup into another throwaway store. (Main's case of a failing migration is not carried over: the
// store has no migrations, so an update has no migration step.)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { after, before, describe, test } from "node:test";
import { useTestEnv } from "./helpers.js";
import { startupProblem } from "../src/install/connect.js";
import { dumpStore } from "../src/jobs/backup.js";
import { kitHashes } from "../src/release.js";
import { DevvaStore } from "../src/store/devva.js";
import { freshBackup, update, UpdateError, type UpdateDeps } from "../src/update/index.js";
import { keepKitEdits } from "../src/update/kit-merge.js";
import { devvaTarget, readDump, restore, RestoreError } from "../src/update/restore.js";
import { pendingKit, reportLines, type UpdateReport } from "../ui/src/lib/actualizar.js";

useTestEnv();
// Throwaway stores of this checkout and file on the test engine, never plania: the installed one, a restore's
// source and its target.
const tag = createHash("sha1").update(`${import.meta.dirname}|update`).digest("hex").slice(0, 8);
const UPD = `t_upd_${tag}`;
const SRC = `t_rsrc_${tag}`;
const RST = `t_rst_${tag}`;
const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `plania-upd-${p}-`));

async function withStore<T>(prefix: string, fn: (s: DevvaStore) => Promise<T>): Promise<T> {
  const s = await DevvaStore.open({ prefix });
  try {
    return await fn(s);
  } finally {
    s.close();
  }
}
const purge = (prefix: string) => withStore(prefix, (s) => s.purge());
const putData = (prefix: string, n: number) =>
  withStore(prefix, (s) =>
    s.write("", {}, async (uow) => {
      if (await uow.get("machineState", { key: "test.data" })) await uow.update("machineState", { key: "test.data" }, { value: { n } });
      else await uow.insert("machineState", { key: "test.data", value: { n } });
    }),
  );
const dataOf = (prefix: string) => withStore(prefix, (s) => s.read(async (r) => (await r.get("machineState", { key: "test.data" }))?.value ?? null));
// Every row of a store, as text: what an update must leave as it was.
const rowsOf = (prefix: string) => withStore(prefix, async (s) => [...(await s.fingerprint()).entries()].sort());

// A release folder: a built screen, a kit, its manifest.
function release(dir: string, version: string, opts: { kit: Record<string, string> }): string {
  mkdirSync(path.join(dir, "dist/ui"), { recursive: true });
  writeFileSync(path.join(dir, "dist/ui/index.html"), `<title>Plania ${version}</title>`);
  for (const [rel, text] of Object.entries(opts.kit)) {
    mkdirSync(path.dirname(path.join(dir, "kit", rel)), { recursive: true });
    writeFileSync(path.join(dir, "kit", rel), text);
  }
  writeFileSync(path.join(dir, "VERSION"), `${version}\n`);
  writeFileSync(
    path.join(dir, "release.json"),
    JSON.stringify({ format: 1, name: "plania", version, commit: null, built_at: "2026-11-19T00:00:00Z", node: ">=22", migrations: null, kit: kitHashes(path.join(dir, "kit")) }),
  );
  return dir;
}

const KIT_N = { "roles/po.md": "po v1\n", "roles/qa.md": "qa v1\n", "skills/x/SKILL.md": "skill v1\n" };
const KIT_N1 = { "roles/po.md": "po v2 from the release\n", "roles/qa.md": "qa v1\n", "skills/x/SKILL.md": "skill v2\n" };

// The installed N with the buyer's own changes: .env, an edited po (the release changes it too), an edited qa (the
// release does not), an added role; the skill is untouched.
function installedN(): string {
  const root = path.join(tmp("inst"), "plania");
  release(root, "1.0.0", { kit: KIT_N });
  writeFileSync(path.join(root, ".env"), `PLANIA_DEVVA_PREFIX=${UPD}\nSESSION_SECRET=mine\n`);
  writeFileSync(path.join(root, "kit/roles/po.md"), "po edited by the buyer\n");
  writeFileSync(path.join(root, "kit/roles/qa.md"), "qa edited by the buyer\n");
  writeFileSync(path.join(root, "kit/roles/mine.md"), "a role of my own\n");
  return root;
}

type Calls = string[];
function deps(root: string, nextDir: string, calls: Calls, over: Partial<UpdateDeps> = {}): UpdateDeps & { lines: string[]; reports: UpdateReport[] } {
  const lines: string[] = [];
  const reports: UpdateReport[] = [];
  const backupDir = path.join(path.dirname(root), "backups");
  const pkg = path.join(path.dirname(root), "plania-next.tar.gz");
  writeFileSync(pkg, "stand-in archive");
  return {
    lines,
    reports,
    root,
    packageFile: pkg,
    now: () => new Date(),
    log: (l) => lines.push(l),
    inFlight: async () => [],
    extract: async (_file, dir) => {
      calls.push("extract");
      cpSync(nextDir, path.join(dir, "plania-next"), { recursive: true });
    },
    installDeps: async () => void calls.push("deps"),
    backupDir,
    dump: async (file) => {
      calls.push("dump");
      writeFileSync(file, gzipSync("-- dump"));
    },
    service: { stop: async () => void calls.push("stop"), start: async () => void calls.push("start") },
    kitRoles: async () => [{ role: "asistente", title: "Prompt: asistente", state: "doc_newer" }],
    record: async (r) => void reports.push(r),
    ...over,
  };
}

// Version N's store with data in it.
async function storeAtN(): Promise<void> {
  await purge(UPD);
  await putData(UPD, 42);
}

describe("update", () => {
  before(async () => storeAtN());
  after(async () => purge(UPD));

  test("from N with data to N+1: data intact, a checked backup, settings and kit edits kept, report recorded", async () => {
    await storeAtN();
    const root = installedN();
    const next = release(path.join(tmp("next"), "plania-1.1.0"), "1.1.0", { kit: KIT_N1 });
    const before = await rowsOf(UPD);
    const calls: Calls = [];
    // The real backup an update takes: the store's log, read fresh from the engine, checked in a throwaway store.
    const d = deps(root, next, calls, {
      dump: async (file) => {
        calls.push("dump");
        await dumpStore({ prefix: UPD }, file);
      },
    });
    const report = await update(d);

    // No migration step: the store has none.
    assert.deepEqual(calls, ["extract", "deps", "dump", "stop", "start"]);
    // The new program files, the buyer's own files.
    assert.equal(readFileSync(path.join(root, "VERSION"), "utf8"), "1.1.0\n");
    assert.match(readFileSync(path.join(root, ".env"), "utf8"), /SESSION_SECRET=mine/);
    assert.equal(readFileSync(path.join(root, "kit/roles/po.md"), "utf8"), "po edited by the buyer\n");
    assert.equal(readFileSync(path.join(root, "kit.new/roles/po.md"), "utf8"), "po v2 from the release\n");
    assert.equal(readFileSync(path.join(root, "kit/roles/qa.md"), "utf8"), "qa edited by the buyer\n");
    assert.equal(readFileSync(path.join(root, "kit/roles/mine.md"), "utf8"), "a role of my own\n");
    assert.equal(readFileSync(path.join(root, "kit/skills/x/SKILL.md"), "utf8"), "skill v2\n", "an untouched file takes the release's version");
    assert.ok(existsSync(`${root}.previous-1.0.0/VERSION`), "the previous version is kept for going back");
    assert.ok(!readdirSync(path.dirname(root)).some((n) => n.startsWith(".plania-incoming-")), "the unpacked package is cleaned up");
    // The store: every row that was there is still there, as it was; the engine answers for the new version's start.
    assert.deepEqual(await rowsOf(UPD), before);
    assert.deepEqual(await dataOf(UPD), { n: 42 });
    assert.equal(await startupProblem(process.env), null, "the new version starts");
    // The backup is a complete dump of the store's log.
    assert.ok(readDump(report.backup)!.commits >= 1);
    // The report: kit files and roles, on the screen and printed.
    assert.deepEqual(d.reports, [report]);
    assert.equal(report.from, "1.0.0");
    assert.equal(report.to, "1.1.0");
    assert.match(report.backup, /plania-pre-update-1\.0\.0-to-1\.1\.0-.*\.devva\.jsonl\.gz$/);
    assert.deepEqual(
      report.kit_files.map((k) => `${k.file} ${k.kind}`).sort(),
      ["kit/roles/mine.md added", "kit/roles/po.md both", "kit/roles/qa.md edited"],
    );
    assert.equal(pendingKit(report), 2);
    for (const line of reportLines(report)) assert.ok(d.lines.includes(line), line);
    assert.ok(d.lines.some((l) => /kit\.new\/roles\/po\.md/.test(l)));
    assert.ok(d.lines.some((l) => /Prompt: asistente.*kit:sync --force/.test(l)));
    assert.match(d.lines.at(-1)!, /versión 1\.1\.0.*\/novedades/);
  });

  test("the update says how to go back with the backup when it fails after the stop: one sentence, the restore command", async () => {
    // Main's case was a failing migration; there is none, so the stop itself fails here. The store is not touched.
    await storeAtN();
    const root = installedN();
    const next = release(path.join(tmp("bad"), "plania-1.1.0"), "1.1.0", { kit: KIT_N1 });
    const before = await rowsOf(UPD);
    const calls: Calls = [];
    const d = deps(root, next, calls, { service: { stop: async () => (calls.push("stop"), Promise.reject(new Error("launchctl: no such service"))), start: async () => void calls.push("start") } });
    await assert.rejects(update(d), (e: unknown) => {
      assert.ok(e instanceof UpdateError);
      assert.equal(e.code, "STOP_FAILED");
      assert.match(e.message, /sigue en la versión 1\.0\.0/);
      assert.match(e.message, /pnpm restore:plania .*plania-pre-update-1\.0\.0-to-1\.1\.0-.*\.devva\.jsonl\.gz --prefix/);
      return true;
    });
    assert.deepEqual(calls, ["extract", "deps", "dump", "stop", "start"]);
    // The old program files stay, untouched.
    assert.equal(readFileSync(path.join(root, "VERSION"), "utf8"), "1.0.0\n");
    assert.equal(readFileSync(path.join(root, "kit/roles/po.md"), "utf8"), "po edited by the buyer\n");
    assert.ok(!existsSync(path.join(root, "kit.new")));
    const backups = readdirSync(path.join(path.dirname(root), "backups"));
    assert.equal(backups.length, 1);
    assert.deepEqual(await rowsOf(UPD), before);
  });

  test("an update with a run in flight is refused with one sentence, and nothing is touched", async () => {
    const root = installedN();
    const calls: Calls = [];
    const d = deps(root, root, calls, { inFlight: async () => [{ kind: "run", text: "po trabaja en PLA-1" }] });
    await assert.rejects(update(d), (e: unknown) => {
      assert.ok(e instanceof UpdateError);
      assert.equal(e.code, "IN_FLIGHT");
      assert.equal(e.message, "No se actualizó: hay trabajo en curso (po trabaja en PLA-1). Espera a que termine y vuelve a correr la actualización.");
      return true;
    });
    assert.deepEqual(calls, []);
    assert.equal(readFileSync(path.join(root, "VERSION"), "utf8"), "1.0.0\n");
  });

  test("the same or an older version is refused before anything stops", async () => {
    const root = installedN();
    const calls: Calls = [];
    const same = release(path.join(tmp("same"), "plania-1.0.0"), "1.0.0", { kit: KIT_N });
    await assert.rejects(update(deps(root, same, calls)), (e: unknown) => e instanceof UpdateError && e.code === "NOT_NEWER");
    assert.deepEqual(calls, ["extract"]);
  });

  test("no backup from today: the old version is put back before the new one opens the store", async () => {
    await storeAtN();
    const root = installedN();
    const next = release(path.join(tmp("nob"), "plania-1.1.0"), "1.1.0", { kit: KIT_N1 });
    const calls: Calls = [];
    const yesterday = new Date(Date.now() - 36 * 3600_000);
    const d = deps(root, next, calls, {
      dump: async (file) => {
        calls.push("dump");
        writeFileSync(file, gzipSync("-- dump"));
        utimesSync(file, yesterday, yesterday);
      },
    });
    await assert.rejects(update(d), (e: unknown) => e instanceof UpdateError && e.code === "NO_FRESH_BACKUP");
    assert.ok(!calls.includes("migrate"));
    assert.equal(readFileSync(path.join(root, "VERSION"), "utf8"), "1.0.0\n");
    assert.equal(calls.at(-1), "start");
  });

  test("freshBackup finds today's non-empty dump only", () => {
    const dir = tmp("fresh");
    const now = new Date();
    assert.equal(freshBackup(dir, now), null);
    writeFileSync(path.join(dir, "plania-20200101.devva.jsonl.gz"), "x");
    const old = new Date(now.getTime() - 48 * 3600_000);
    utimesSync(path.join(dir, "plania-20200101.devva.jsonl.gz"), old, old);
    writeFileSync(path.join(dir, "plania-empty.devva.jsonl.gz"), "");
    // A Postgres dump from before the store is not a backup of it.
    writeFileSync(path.join(dir, "plania-20990101.sql.gz"), "x");
    assert.equal(freshBackup(dir, now), null);
    writeFileSync(path.join(dir, "plania-pre-update-x.devva.jsonl.gz"), "x");
    assert.equal(freshBackup(dir, now), path.join(dir, "plania-pre-update-x.devva.jsonl.gz"));
  });

  test("without the shipped hashes (an older package) every differing kit file is kept, the release's beside it", () => {
    const prev = tmp("prev");
    const nextRoot = tmp("nextroot");
    for (const [d, files] of [[prev, { "roles/po.md": "mine" }], [nextRoot, { "roles/po.md": "theirs", "roles/qa.md": "new" }]] as const) {
      for (const [rel, t] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(d, "kit", rel)), { recursive: true });
        writeFileSync(path.join(d, "kit", rel), t);
      }
    }
    assert.deepEqual(keepKitEdits(prev, nextRoot, null), [{ file: "kit/roles/po.md", kind: "both" }]);
    assert.equal(readFileSync(path.join(nextRoot, "kit/roles/po.md"), "utf8"), "mine");
    assert.equal(readFileSync(path.join(nextRoot, "kit.new/roles/po.md"), "utf8"), "theirs");
  });
});

describe("restore", () => {
  after(async () => {
    await purge(SRC);
    await purge(RST);
  });

  test("brings a store back from a backup file, and refuses to replace one with data unless asked twice", async () => {
    await purge(SRC);
    await purge(RST);
    await putData(SRC, 7);
    const file = path.join(tmp("bk"), "plania-20261119.devva.jsonl.gz");
    await dumpStore({ prefix: SRC }, file);

    const lines: string[] = [];
    const r = await restore({ file, prefix: RST, open: devvaTarget(), log: (l) => lines.push(l) });
    assert.equal(r.created, true);
    assert.equal(r.commits, await withStore(SRC, async (s) => s.commits));
    assert.deepEqual(await rowsOf(RST), await rowsOf(SRC));
    assert.deepEqual(await dataOf(RST), { n: 7 });
    assert.match(lines.at(-1)!, /volvió del respaldo/);

    // A store with data: refused, then refused with a wrong confirmation, then replaced when asked twice.
    await assert.rejects(restore({ file, prefix: RST, open: devvaTarget() }), (e: unknown) => e instanceof RestoreError && e.code === "HAS_DATA" && e.message.includes(`--overwrite --confirm ${RST}`));
    await assert.rejects(restore({ file, prefix: RST, overwrite: true, confirm: "plania", open: devvaTarget() }), (e: unknown) => e instanceof RestoreError && e.code === "HAS_DATA");
    await putData(RST, 0);
    const again = await restore({ file, prefix: RST, overwrite: true, confirm: RST, open: devvaTarget() });
    assert.equal(again.replaced, true);
    assert.deepEqual(await dataOf(RST), { n: 7 });
  });

  test("a missing backup file, or one that is not a whole dump, is one sentence, and no store is touched", async () => {
    const opened: string[] = [];
    const open = async (prefix: string) => (opened.push(prefix), Promise.reject(new Error("never")));
    await assert.rejects(restore({ file: path.join(tmpdir(), "no-such-backup.devva.jsonl.gz"), prefix: RST, open }), (e: unknown) => e instanceof RestoreError && e.code === "NO_FILE");
    const cut = path.join(tmp("cut"), "plania-20261119.devva.jsonl.gz");
    writeFileSync(cut, gzipSync(`${JSON.stringify({ plania_devva_dump: 1, commits: 3 })}\n${JSON.stringify({ seq: 1 })}\n`));
    await assert.rejects(restore({ file: cut, prefix: RST, overwrite: true, confirm: RST, open }), (e: unknown) => e instanceof RestoreError && e.code === "NOT_DUMP");
    await assert.rejects(restore({ file: cut, prefix: "Not-A-Prefix", open }), (e: unknown) => e instanceof RestoreError && e.code === "BAD_NAME");
    assert.deepEqual(opened, []);
  });
});

describe("screen", () => {
  test("Novedades shows the last update's kept kit edits with what to do", async () => {
    const React = await import("react");
    (globalThis as { React?: unknown }).React = React;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { MemoryRouter } = await import("react-router");
    const page = (await import(new URL("../ui/src/pages/novedades.tsx", import.meta.url).href)) as Record<string, any>;
    const last: UpdateReport = {
      from: "1.0.0",
      to: "1.1.0",
      at: "2026-11-19T12:00:00Z",
      backup: "/home/ana/plania-backups/plania-pre-update-1.0.0-to-1.1.0.devva.jsonl.gz",
      kit_files: [{ file: "kit/roles/po.md", kind: "both" }],
      kit_roles: [{ role: "qa", title: "Prompt: qa", state: "both_changed" }],
    };
    const html = renderToStaticMarkup(
      React.createElement(MemoryRouter, null, React.createElement(page.NovedadesView, { release: { version: "1.1.0", commit: null, built_at: null, packaged: true, notes: "", last_update: last } })),
    );
    assert.match(html, /data-last-update="1\.1\.0"/);
    assert.match(html, /De la versión 1\.0\.0 a la 1\.1\.0, el 19 de noviembre\./);
    assert.match(html, /kit\.new\/roles\/po\.md/);
    assert.match(html, /Prompt: qa/);
    assert.equal((html.match(/data-kit-todo="1"/g) ?? []).length, 2);
  });
});
