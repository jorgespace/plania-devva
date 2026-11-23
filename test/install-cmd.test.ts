// B3, B4, P1, P2, P4, F1-F4: the install command on a new machine. Why the devva engine said no (Plania's data is there;
// nothing is asked in the terminal), why a project's Postgres says no, pg_dump and Chrome found on Windows too, the tool
// paths and the engine written to .env, quiet output, Plania started and the first-start page opened with the code in
// the fragment, and the words in the system's language. Every outside call is a fake, except the test engine
// (DEVVA_HOST, DEVVA_PORT, DEVVA_TOKEN_FILE, a throwaway prefix of this file) and a local Postgres when one answers.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import { PG_USER, useTestEnv } from "./helpers.js";

useTestEnv();
const { install, writeSettings } = await import("../src/db/install.js");
const { pgFailureOf, readPg, userOf, withCredentials, isLocalAddress } = await import("../src/lib/pg-connect.js");
const { devvaAddress, devvaFailureOf, readDevva } = await import("../src/install/connect.js");
const { DevvaStore } = await import("../src/store/devva.js");
const { finishInstall, closingBox, firstStartUrl, browserCommand } = await import("../src/install/finish.js");
const { pgToolFor, pgSearchPath, pgBinFolder } = await import("../src/lib/pg-bin.js");
const { findChrome } = await import("../src/captures/chrome.js");
const { machineCheck } = await import("../src/machine-check/index.js");
const lang = await import("../src/language.js");
import type { DevvaReading } from "../src/install/connect.js";
import type { MachineCheckDeps } from "../src/machine-check/index.js";

const scratch = mkdtempSync(path.join(tmpdir(), "plania-install-cmd-"));
// The store the install test makes: a prefix of this checkout and file, never plania.
const PREFIX = `t_icmd_${createHash("sha1").update(`${import.meta.dirname}|install-cmd`).digest("hex").slice(0, 8)}`;
async function purge(prefix: string): Promise<void> {
  const s = await DevvaStore.open({ prefix });
  await s.purge();
  s.close();
}
after(async () => {
  await purge(PREFIX);
  rmSync(scratch, { recursive: true, force: true });
});
// A project's own Postgres on this machine, when one answers (the test copies read one): its maintenance database.
const LOCAL_PG = `postgres://${PG_USER}@localhost:5432/postgres`;
const withDatabase = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};
const only = (files: string[]) => (p: string) => files.includes(p);
const GB = 1024 ** 3;

// --- B3: why a project's Postgres said no (its test copies read it) -------------------------------------------

test("B3: a connection error is read as not running, wrong password, refused role, or missing database", () => {
  const err = (code: string | undefined, message: string) => Object.assign(new Error(message), code ? { code } : {});
  assert.equal(pgFailureOf(err("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432")), "unreachable");
  assert.equal(pgFailureOf(err(undefined, "Connection terminated due to connection timeout")), "unreachable");
  assert.equal(pgFailureOf(err("28P01", 'password authentication failed for user "jorge"')), "bad_password");
  assert.equal(pgFailureOf(err(undefined, "SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string")), "bad_password");
  assert.equal(pgFailureOf(err("28000", 'role "jorge" does not exist')), "auth_refused");
  assert.equal(pgFailureOf(err("28000", 'no pg_hba.conf entry for host "10.0.0.2"')), "auth_refused");
  assert.equal(pgFailureOf(err("3D000", 'database "plania" does not exist')), "no_database");
});

test("B3: the local Postgres's own answers: refused port, missing database, missing role", async (t) => {
  const refused = await readPg("postgres://postgres@127.0.0.1:1/postgres");
  assert.deepEqual([refused.ok, !refused.ok && refused.reason], [false, "unreachable"]);
  const ok = await readPg(LOCAL_PG);
  if (!ok.ok && ok.reason === "unreachable") return t.skip("no Postgres answers on localhost:5432");
  const noDb = await readPg(withDatabase(LOCAL_PG, "plania_test_no_such_database"));
  assert.deepEqual([noDb.ok, !noDb.ok && noDb.reason], [false, "no_database"]);
  const noRole = await readPg(withCredentials(LOCAL_PG, "plania_no_such_role", ""));
  assert.equal(noRole.ok, false);
  // With trust auth the role is refused outright (28000); with password auth the server first asks for a password.
  assert.ok(!noRole.ok && ["auth_refused", "bad_password"].includes(noRole.reason!), JSON.stringify(noRole));
  assert.ok(ok.ok && ok.versionNum >= 140000, JSON.stringify(ok));
});

test("B3: addresses: the user they name, credentials set and encoded, and whether the server is on this machine", () => {
  assert.equal(userOf("postgres://localhost:5432/plania"), undefined);
  assert.equal(userOf("postgres://ana@localhost:5432/plania"), "ana");
  const u = withCredentials("postgres://localhost:5432/plania", "ana", "p@ss:w/rd #1");
  assert.equal(decodeURIComponent(new URL(u).password), "p@ss:w/rd #1");
  assert.equal(new URL(u).pathname, "/plania");
  assert.equal(new URL(withCredentials(u, "postgres", "")).password, "");
  for (const local of ["postgres://localhost/x", "postgres://127.0.0.1:5432/x", "postgres://[::1]:5432/x", "postgres:///x?host=/tmp"]) assert.equal(isLocalAddress(local), true, local);
  assert.equal(isLocalAddress("postgres://db.example.com:5432/x"), false);
});

// --- B3: why the devva engine said no ----------------------------------------------------------------------

test("B3: a client error is read as not running, no token file, or a token the engine refuses", () => {
  const err = (code: string | undefined, message: string) => Object.assign(new Error(message), code ? { code } : {});
  assert.equal(devvaFailureOf(err("CONNECTION_ERROR", "[CONNECTION_ERROR] Failed to connect to 127.0.0.1:2505: connect ECONNREFUSED 127.0.0.1:2505")), "unreachable");
  assert.equal(devvaFailureOf(err("CONNECTION_ERROR", "[CONNECTION_ERROR] Connect to 127.0.0.1:2505 timed out")), "unreachable");
  assert.equal(devvaFailureOf(err("TIMEOUT", "[TIMEOUT] statement timed out")), "unreachable");
  assert.equal(devvaFailureOf(err("ENOENT", "ENOENT: no such file or directory, open '/k/devva-token'")), "no_token");
  assert.equal(devvaFailureOf(err("AUTH_FAILED", "[AUTH_FAILED] the server requires a bearer token")), "bad_token");
  // Connected, then dropped before answering: the engine closes on a token it refuses.
  assert.equal(devvaFailureOf(err("CONNECTION_ERROR", "[CONNECTION_ERROR] Connection closed by server")), "bad_token");
});

test("B3: the engine's own answers: refused port, a token file that is not there, and the engine that answers", async () => {
  const before = process.env.DEVVA_TOKEN;
  const off = await readDevva({ ...process.env, DEVVA_HOST: "127.0.0.1", DEVVA_PORT: "1" });
  assert.deepEqual([off.ok, !off.ok && off.reason, off.where], [false, "unreachable", "127.0.0.1:1"]);
  const none = await readDevva({ ...process.env, DEVVA_TOKEN_FILE: path.join(scratch, "no-token") });
  assert.deepEqual([none.ok, !none.ok && none.reason], [false, "no_token"]);
  const ok = await readDevva(process.env);
  assert.ok(ok.ok, JSON.stringify(ok));
  // A probe never changes the token the process's later connections send.
  assert.equal(process.env.DEVVA_TOKEN, before);
  // A blank line of .env.example counts as unset: the defaults.
  assert.deepEqual((({ host, port }) => ({ host, port }))(devvaAddress({ DEVVA_HOST: "", DEVVA_PORT: " " })), { host: "127.0.0.1", port: 2505 });
});

function machine(probe: (env: NodeJS.ProcessEnv) => Promise<DevvaReading>, extra: Partial<MachineCheckDeps> = {}): MachineCheckDeps {
  return {
    env: { HOME: "/home/someone", CLAUDE_CODE_BIN: "/fake/bin/claude", PLANIA_PG_BIN: "/fake/pg" },
    exec: async (cmd, args) => {
      const name = path.basename(cmd).replace(/\.exe$/i, "");
      if (name === "pg_dump") return { code: 0, stdout: "pg_dump (PostgreSQL) 18.3\n", stderr: "" };
      if (name === "gh" && args[0] === "--version") return { code: 0, stdout: "gh version 2.45.0\n", stderr: "" };
      if (name === "gh") return { code: 0, stdout: "Logged in\n  - Token scopes: 'repo'\n", stderr: "" };
      if (name === "git") return { code: 0, stdout: "git version 2.43.0\n", stderr: "" };
      if (name === "claude") return { code: 0, stdout: "2.1.302 (Claude Code)\n", stderr: "" };
      return { code: null, stdout: "", stderr: "spawn ENOENT" };
    },
    nodeVersion: "22.11.0",
    devvaProbe: probe,
    claudeDryRun: async () => ({ state: "signed_in", structuredOutput: true }),
    freeDisk: async () => 120 * GB,
    totalMemory: () => 16 * GB,
    findChrome: () => null,
    ...extra,
  };
}

const refused = (reason: "unreachable" | "no_token" | "bad_token" | "absent") => async (): Promise<DevvaReading> => ({ ok: false, reason, where: "127.0.0.1:2505", tokenFile: "/k/devva-token" });

test("B3: the machine check names each reason with its own sentence and fix, in both languages", async () => {
  const reasons = ["unreachable", "no_token", "bad_token", "absent"] as const;
  for (const language of ["es", "en"] as const) {
    const items = await Promise.all(
      reasons.map(async (reason) => (await machineCheck(machine(refused(reason), { language }))).find((i) => i.id === "devva")!),
    );
    assert.deepEqual(items.map((i) => i.reason), [...reasons]);
    assert.ok(items.every((i) => i.state === "missing" && i.fix), language);
    assert.equal(new Set(items.map((i) => i.sentence)).size, 4, language);
    assert.equal(new Set(items.map((i) => i.fix)).size, 4, language);
    // The engine's address is named where it is the problem.
    assert.match(items[0]!.sentence, /127\.0\.0\.1:2505/);
    assert.match(items[2]!.sentence, /127\.0\.0\.1:2505/);
  }
  const es = (await machineCheck(machine(refused("bad_token")))).find((i) => i.id === "devva")!;
  assert.equal(es.sentence, "El motor devva responde en 127.0.0.1:2505, pero no aceptó la clave.");
  assert.match(es.fix!, /DEVVA_TOKEN_FILE/);
  const down = (await machineCheck(machine(refused("unreachable")))).find((i) => i.id === "devva")!;
  assert.equal(down.reason, "unreachable");
  assert.match(down.fix!, /deploy\/devva\/README\.md/);
  assert.doesNotMatch(down.sentence, /clave/);
  const ok = (await machineCheck(machine(async () => ({ ok: true, where: "127.0.0.1:2505", lobes: 3 })))).find((i) => i.id === "devva")!;
  assert.deepEqual([ok.state, ok.sentence], ["ready", "El motor devva responde en 127.0.0.1:2505."]);
});

// There is no Plania Postgres to read a version or a folder from: the check runs the pg_dump PLANIA_PG_BIN names (the
// install writes the one it found), and the server's own folder still leads the lookup for a project's test copies.
test("B4: the machine check runs the pg_dump PLANIA_PG_BIN names; a server's own folder leads the lookup", async () => {
  const ran: string[] = [];
  const own = mkdtempSync(path.join(scratch, "pgbin-"));
  const ownDump = path.join(own, "pg_dump");
  const deps = machine(async () => ({ ok: true, where: "127.0.0.1:2505", lobes: 1 }));
  const exec = deps.exec!;
  const items = await machineCheck({
    ...deps,
    env: { ...deps.env, PLANIA_PG_BIN: own },
    exec: async (cmd, args, o) => {
      ran.push(cmd);
      return exec(cmd, args, o);
    },
  });
  assert.ok(ran.includes(ownDump), ran.join(" | "));
  assert.equal(items.find((i) => i.id === "pg_dump")!.state, "ready");
  assert.equal(pgToolFor("pg_dump", 18, { env: { PATH: "" }, serverBinDir: "/srv/pg18/bin", exists: only(["/srv/pg18/bin/pg_dump"]), platform: "linux" }), "/srv/pg18/bin/pg_dump");
});


// --- B4, P2: pg_dump on Windows and the server's major (a project's own Postgres) ----------------------------

test("B4: pg_dump in Laragon's and the EDB installer's folders on Windows, the server's own folder first", () => {
  const env = { PATH: "", ProgramFiles: "C:\\Program Files" };
  const laragon = "C:\\laragon\\bin\\pgsql\\pgsql-18\\bin\\pg_dump.exe";
  const edb17 = "C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe";
  const listDir = (dir: string) => (dir === "C:\\Program Files\\PostgreSQL" ? ["16", "17"] : dir === "C:\\laragon\\bin\\pgsql" ? ["pgsql-18"] : []);
  assert.equal(pgToolFor("pg_dump", 18, { env, platform: "win32", exists: only([laragon, edb17]), listDir }), laragon);
  assert.equal(pgToolFor("pg_dump", 17, { env, platform: "win32", exists: only([laragon, edb17]), listDir }), edb17);
  // Major unknown: the newest installed, EDB's before Laragon's.
  assert.equal(pgToolFor("pg_dump", 0, { env, platform: "win32", exists: only([edb17]), listDir }), edb17);
  assert.equal(pgToolFor("pg_dump", 0, { env, platform: "win32", exists: only([laragon]), listDir }), laragon);
  // The folder the server reports wins over the versioned ones.
  const own = "D:\\pg\\bin";
  assert.equal(pgToolFor("pg_dump", 18, { env, platform: "win32", exists: only([laragon, `${own}\\pg_dump.exe`]), listDir, serverBinDir: own }), `${own}\\pg_dump.exe`);
  // PLANIA_PG_BIN still comes first.
  assert.equal(pgToolFor("pg_dump", 18, { env: { ...env, PLANIA_PG_BIN: "E:\\tools" }, platform: "win32", exists: only([laragon]), listDir }), path.join("E:\\tools", "pg_dump"));
  // F1: the folder to write in .env, or null when only the bare name is left.
  assert.equal(pgBinFolder(18, { env, platform: "win32", exists: only([laragon]), listDir }), "C:\\laragon\\bin\\pgsql\\pgsql-18\\bin");
  assert.equal(pgBinFolder(18, { env, platform: "win32", exists: () => false, listDir: () => [] }), null);
});

test("P2: the search PATH puts the server's major first and knows 18", () => {
  const brew = (m: number) => `/opt/homebrew/opt/postgresql@${m}/bin`;
  const all = only([brew(14), brew(16), brew(18)]);
  const first = (major?: number) => pgSearchPath("/usr/bin", { env: {}, platform: "darwin", exists: all, listDir: () => [], major }).split(path.delimiter)[0];
  assert.equal(first(16), brew(16));
  assert.equal(first(), brew(18));
  const win = pgSearchPath("", { env: { ProgramFiles: "C:\\Program Files" }, platform: "win32", exists: only(["C:\\laragon\\bin\\pgsql\\pgsql-18\\bin"]), listDir: () => [], major: 18 });
  assert.equal(win, "C:\\laragon\\bin\\pgsql\\pgsql-18\\bin");
});

// --- P1: Chrome on Windows ------------------------------------------------------------------------------------

test("P1: Chrome under Program Files, Program Files (x86) and the user's own LOCALAPPDATA", () => {
  const env = { PATH: "", HOME: scratch, ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local" };
  const at = (dir: string) => `${dir}\\Google\\Chrome\\Application\\chrome.exe`;
  assert.equal(findChrome(env, only([at("C:\\Program Files")])), at("C:\\Program Files"));
  assert.equal(findChrome(env, only([at("C:\\Program Files (x86)")])), at("C:\\Program Files (x86)"));
  assert.equal(findChrome(env, only([at("C:\\Users\\ana\\AppData\\Local")])), at("C:\\Users\\ana\\AppData\\Local"));
  assert.equal(findChrome({ ...env, PLANIA_CHROME_PATH: "D:\\c.exe" }, only(["D:\\c.exe", at("C:\\Program Files")])), "D:\\c.exe");
  assert.equal(findChrome(env, () => false), null);
});

// --- F1: the tool paths in .env -------------------------------------------------------------------------------

test("F1: the tool paths found are written to .env, a value already set is kept, an empty one is not written", () => {
  const envPath = path.join(scratch, "tools.env");
  writeFileSync(envPath, "PLANIA_DEVVA_PREFIX=plania\nSESSION_SECRET=s\nMCP_BEARER_TOKEN=t\nPLANIA_PG_BIN=/mine\nPLANIA_CHROME_PATH=\n");
  const keys = writeSettings(envPath, undefined, "plania", () => "x", { PLANIA_PG_BIN: "/found", PLANIA_CHROME_PATH: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", OTHER: " " });
  assert.deepEqual(keys, ["PLANIA_CHROME_PATH"]);
  const env = parseEnv(readFileSync(envPath, "utf8"));
  assert.equal(env.PLANIA_PG_BIN, "/mine");
  assert.equal(env.PLANIA_CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  assert.equal("OTHER" in env, false);
});

test("F1, F3: the install writes the tools it was given and the engine it reached, in a few lines", async () => {
  await purge(PREFIX);
  const envPath = path.join(scratch, "install.env");
  const logs: string[] = [];
  const r = await install({
    prefix: PREFIX,
    named: false,
    envPath,
    log: (l) => logs.push(l),
    tools: () => ({ PLANIA_PG_BIN: "/found/pg/bin", PLANIA_CHROME_PATH: "/found/chrome" }),
  });
  assert.equal(r.created, true);
  const env = parseEnv(readFileSync(envPath, "utf8"));
  assert.deepEqual([env.PLANIA_PG_BIN, env.PLANIA_CHROME_PATH], ["/found/pg/bin", "/found/chrome"]);
  assert.equal(env.DEVVA_PORT, String(devvaAddress().port));
  // One line for the new store and one for the settings; there are no migrations to report.
  assert.equal(logs.length, 2, logs.join(" | "));
  assert.match(logs[0]!, new RegExp(`${PREFIX}`));
  assert.ok(!logs.some((l) => /migraci|migration/i.test(l)), logs.join(" | "));
  // Again: nothing new, and the tool values already set stay.
  logs.length = 0;
  const again = await install({ prefix: PREFIX, named: false, envPath, log: (l) => logs.push(l), tools: () => ({ PLANIA_PG_BIN: "/other" }) });
  assert.deepEqual(again.envKeys, []);
  assert.equal(again.created, false);
  assert.equal(parseEnv(readFileSync(envPath, "utf8")).PLANIA_PG_BIN, "/found/pg/bin");
  assert.deepEqual(logs, [], "a re-run says nothing new");
});

// --- F3, F4: start, open, the closing box ---------------------------------------------------------------------

function finish(o: { up?: boolean[]; supported?: boolean; startFails?: boolean; open?: boolean; start?: boolean; code?: string | null } = {}) {
  const up = [...(o.up ?? [false, true])];
  const calls: string[] = [];
  const logs: string[] = [];
  const deps = {
    port: 3737,
    setupCode: o.code === undefined ? "K7Q2-9XPM" : o.code,
    language: "es" as const,
    open: o.open ?? true,
    start: o.start ?? true,
    serviceSupported: o.supported ?? true,
    isUp: async () => up.shift() ?? false,
    startService: async () => {
      calls.push("service");
      if (o.startFails) throw new Error("launchctl failed\nmore");
    },
    openBrowser: (url: string) => void calls.push(`open ${url}`),
    sleep: async () => {},
    waitTries: 3,
    log: (l: string) => void logs.push(l),
  };
  return { deps, calls, logs };
}

test("F4: not running → started as a service, then the browser opens on first start with the code in the fragment", async () => {
  const f = finish();
  const r = await finishInstall(f.deps);
  assert.equal(r.started, "service");
  assert.deepEqual(f.calls, ["service", "open http://localhost:3737/primer-arranque#code=K7Q2-9XPM"]);
  assert.ok(r.opened);
  assert.ok(r.box.includes("Abre: http://localhost:3737/primer-arranque#code=K7Q2-9XPM"));
  assert.ok(r.box.includes("Código de un solo uso: K7Q2-9XPM"));
  assert.ok(!r.box.includes("pnpm start"));
});

test("F4: already running → not started again; --no-open opens nothing; an owner already made → the screen, no code", async () => {
  const running = finish({ up: [true] });
  assert.equal((await finishInstall(running.deps)).started, "already");
  assert.deepEqual(running.calls, ["open http://localhost:3737/primer-arranque#code=K7Q2-9XPM"]);
  const quiet = finish({ up: [true], open: false });
  const r = await finishInstall(quiet.deps);
  assert.deepEqual([quiet.calls, r.opened], [[], false]);
  const owner = finish({ up: [true], code: null });
  const o = await finishInstall(owner.deps);
  assert.deepEqual(owner.calls, ["open http://localhost:3737/"]);
  assert.ok(!o.box.includes("Código"));
});

test("F4: where no service is supported, or it fails, or --no-start: nothing opens and the box says how to start it", async () => {
  for (const f of [finish({ supported: false }), finish({ startFails: true }), finish({ start: false })]) {
    const r = await finishInstall(f.deps);
    assert.equal(r.started, "not_started");
    assert.equal(r.opened, false);
    assert.ok(!f.calls.some((c) => c.startsWith("open")));
    assert.ok(r.box.includes("Enciéndela con: pnpm start"));
    assert.ok(r.box.includes("K7Q2-9XPM"));
  }
  const failed = finish({ startFails: true });
  await finishInstall(failed.deps);
  assert.ok(failed.logs.includes("No se pudo dejar Plania como servicio (launchctl failed)."), failed.logs.join(" | "));
  // A service that never answers: said, and nothing opens.
  const slow = finish({ up: [false, false, false, false, false] });
  const s = await finishInstall(slow.deps);
  assert.equal(s.started, "not_started");
  assert.ok(slow.logs.includes("Plania no respondió todavía."));
});

test("F3: the closing box is one width; the URL and the browser command keep the fragment", () => {
  const box = closingBox(["Plania está instalada.", "Abre: http://localhost:3737/primer-arranque#code=AB", "x"]).split("\n");
  assert.equal(new Set(box.map((l) => [...l].length)).size, 1);
  assert.match(box[0]!, /^┌─+┐$/);
  assert.equal(firstStartUrl(3800, "a b"), "http://localhost:3800/primer-arranque#code=a%20b");
  assert.deepEqual(browserCommand("http://x/#code=1", "win32"), { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", "http://x/#code=1"] });
  assert.deepEqual(browserCommand("http://x/#code=1", "darwin"), { cmd: "open", args: ["http://x/#code=1"] });
  assert.deepEqual(browserCommand("http://x/#code=1", "linux"), { cmd: "xdg-open", args: ["http://x/#code=1"] });
});

// --- P4: the system's language before one is chosen -----------------------------------------------------------

test("P4: before a language is chosen, the install's words follow the system locale: Spanish for es*, else English", () => {
  assert.equal(lang.localeLanguage({ LANG: "es_MX.UTF-8" }, "en-US"), "es");
  assert.equal(lang.localeLanguage({ LANG: "en_US.UTF-8" }, "es-MX"), "en");
  assert.equal(lang.localeLanguage({ LC_ALL: "es_ES.UTF-8", LANG: "en_US.UTF-8" }, "en-US"), "es");
  assert.equal(lang.localeLanguage({ LANG: "C.UTF-8" }, "es-419"), "es");
  assert.equal(lang.localeLanguage({}, "es"), "es");
  assert.equal(lang.localeLanguage({}, "de-DE"), "en");
  assert.equal(lang.localeLanguage({}, "estonian-ish"), "en");
  try {
    lang.resetLanguage();
    assert.equal(lang.installLanguage({}), "es", "the server, which never follows the system, keeps Spanish");
    assert.equal(lang.followSystemLocale({}, "en-GB"), "en");
    assert.equal(lang.installLanguage({}), "en");
    assert.equal(lang.languageChosen({}), false, "following the system is not a choice");
    assert.equal(lang.installLanguage({ PLANIA_LANGUAGE: "es" }), "es", "the variable wins");
  } finally {
    lang.resetLanguage();
  }
});
