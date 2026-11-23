// PLA-I2-1: install Plania on a new machine in one command.
//   pnpm plania:install                       the store `plania` on the devva engine (deploy/devva/README.md)
//   pnpm plania:install --prefix <name>       another store (lobe prefix); one that already holds data is used only
//                                             when named here, or when .env already names it (a re-run)
//   DEVVA_HOST, DEVVA_PORT, DEVVA_TOKEN_FILE  another engine or token file, from the environment or .env
//   pnpm plania:install --port <n>            the port Plania answers on (3737)
//   pnpm plania:install --no-start            do not start Plania at the end
//   pnpm plania:install --no-open             do not open the browser at the end
// Machine check, check that the devva engine answers with this machine's token, write .env with generated secrets,
// the engine's address and the tool paths it found, build the screen when it is missing, then start Plania (as a
// service where the system supports one, PLA-I2-17) and open the first-start page with the one-time code. The engine
// is not started here: when it does not answer, one sentence says how. There are no migrations. Node only, so it runs
// the same from PowerShell and bash. Safe to run again. --service is still accepted: starting as a service is now the
// default (F4). --database is the same as --prefix (the name it had when the data was in Postgres).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv, parseArgs } from "node:util";
import { findChrome } from "../src/captures/chrome.js";
import { DEFAULT_PREFIX, install, InstallError, INSTALL_WORDS, type MachineCheck } from "../src/db/install.js";
import { browserCommand, finishInstall, FINISH_WORDS } from "../src/install/finish.js";
import { followSystemLocale, installLanguage } from "../src/language.js";
import { pgBinFolder } from "../src/lib/pg-bin.js";
import { formatMachineCheck, installGate, skippedChecks, type MachineItem } from "../src/machine-check/index.js";
import { detectSystem, servicePlatform } from "../src/packaging/service.js";
import { say } from "../src/words.js";
import { words } from "../ui/src/lib/i18n.js";

const repoDir = path.resolve(import.meta.dirname, "..");
const envPath = path.join(repoDir, ".env");
const examplePath = path.join(repoDir, ".env.example");

const { values } = parseArgs({
  options: {
    prefix: { type: "string" },
    database: { type: "string" },
    port: { type: "string" },
    "skip-screen": { type: "boolean" },
    service: { type: "boolean" },
    "no-start": { type: "boolean" },
    "no-open": { type: "boolean" },
  },
  strict: true,
});

// P4: until a language is chosen at first start, the words follow the system's locale.
followSystemLocale();
const language = installLanguage();
const w = say(INSTALL_WORDS, language);
const log = (line: string) => console.log(line);

// The store: --prefix, else the one already in .env (a re-run), else the default. The engine: the environment, else
// .env, else the defaults (127.0.0.1:2505, ~/.config/plania/devva-token).
const fileEnv = existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {};
const named = values.prefix ?? values.database;
const prefix = named ?? (fileEnv.PLANIA_DEVVA_PREFIX?.trim() || DEFAULT_PREFIX);
const engineEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of ["DEVVA_HOST", "DEVVA_PORT", "DEVVA_TOKEN_FILE", "DEVVA_CLIENT"]) {
  if (!engineEnv[key]?.trim() && fileEnv[key]?.trim()) engineEnv[key] = fileEnv[key];
}

// PLA-I2-12: the machine check runs before anything changes; it reads the engine the install will use. F3: when
// nothing blocks, only what is not ready is shown. PLA-I2-4 (from zero): Claude Code missing does not stop the
// install; it is said again after the closing box.
let later: MachineItem[] = [];
const machineCheck: MachineCheck = async () => {
  const gate = await installGate({ env: engineEnv, language }, { skip: skippedChecks() });
  if (!gate.proceed) return { ok: false, lines: [gate.text] };
  later = gate.later;
  const notReady = gate.items.filter((i) => i.state !== "ready");
  return { ok: true, lines: notReady.length ? [formatMachineCheck(notReady, language)] : [] };
};

// F3: Vite's log only when the build fails.
async function buildScreen(): Promise<void> {
  if (values["skip-screen"] || existsSync(path.join(repoDir, "dist/ui/index.html"))) return;
  log(w.building);
  try {
    execFileSync(process.execPath, [path.join(repoDir, "node_modules/vite/bin/vite.js"), "build"], { cwd: repoDir, stdio: "pipe" });
  } catch (e) {
    const out = e as { stdout?: Buffer; stderr?: Buffer };
    process.stderr.write(`${out.stdout?.toString() ?? ""}${out.stderr?.toString() ?? ""}`);
    throw new InstallError(w.buildFailed);
  }
}

const port = Number(values.port ?? process.env.PORT ?? 3737);

try {
  const r = await install({
    prefix,
    named: Boolean(named),
    envPath,
    examplePath,
    env: engineEnv,
    machineCheck,
    buildScreen,
    // F1: the folder of pg_dump (the projects' test copies use it) and Chrome, for .env when not set there already.
    tools: () => {
      const found: Record<string, string> = {};
      const pgBin = pgBinFolder(0);
      if (pgBin) found.PLANIA_PG_BIN = pgBin;
      const chrome = findChrome();
      if (chrome) found.PLANIA_CHROME_PATH = chrome;
      return found;
    },
    log,
  });

  // F4: start Plania (a service where `pnpm service:install` supports the system) and open the first-start page.
  const done = await finishInstall({
    port,
    setupCode: r.setupCode,
    language,
    open: !values["no-open"],
    start: !values["no-start"],
    serviceSupported: !["wsl-no-systemd", "unsupported"].includes(servicePlatform({ platform: process.platform, ...detectSystem() })),
    isUp: () =>
      fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_500) })
        .then((res) => res.ok)
        .catch(() => false),
    startService: async () => {
      try {
        execFileSync(process.execPath, ["--import", "tsx", path.join(repoDir, "scripts/service.ts"), "install", "--port", String(port)], { cwd: repoDir, stdio: "pipe" });
      } catch (e) {
        const out = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
        const said = `${out.stderr?.toString() ?? ""}\n${out.stdout?.toString() ?? ""}`.trim();
        throw new Error(said || out.message || String(e));
      }
    },
    openBrowser: (target) => {
      const { cmd, args } = browserCommand(target);
      const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
      child.on("error", () => undefined);
      child.unref();
    },
    log,
  });
  console.log(`\n${done.box}`);
  if (later.length) console.log(`\n${words(FINISH_WORDS, language).stillMissing}\n${formatMachineCheck(later, language)}`);
} catch (e) {
  if (e instanceof InstallError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
