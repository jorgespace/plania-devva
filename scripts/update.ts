// PLA-I2-8: pnpm update:plania <package file> — update this install to a newer release package, keeping the data,
// the settings and the owner's kit edits (src/update/index.ts says every step).
//   pnpm update:plania ~/Downloads/plania-0.2.0.tar.gz
//   pnpm update:plania <file> --no-service     Plania is not a service here: stop it first, start it after
// Run it from the installed folder. It refuses while work is in flight. The data stays in the devva engine
// (deploy/devva/README.md): the update backs it up and never migrates it.
import { execFileSync, execSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { closeStore, withDb } from "../src/db/client.js";
import { devvaAddress } from "../src/install/connect.js";
import { backupDir, dumpStore } from "../src/jobs/backup.js";
import { inFlight } from "../src/ops/in-flight.js";
import { detectSystem, serviceInstalled, startCommand, stopCommand } from "../src/packaging/service.js";
import { writeVia } from "../src/runner/limits.js";
import { readerOf } from "../src/store/port.js";
import { update, UpdateError } from "../src/update/index.js";
import { PASOS, type KitHeldRole } from "../ui/src/lib/actualizar.js";
import { kitStatus, kitSync } from "./kit.js";

const { values, positionals } = parseArgs({
  options: { "no-service": { type: "boolean", default: false }, port: { type: "string", default: "3737" } },
  allowPositionals: true,
  strict: true,
});
const packageFile = positionals[0];
if (!packageFile) {
  console.error("Uso: pnpm update:plania <archivo del paquete, plania-<versión>.tar.gz>");
  process.exit(2);
}
const root = path.resolve(import.meta.dirname, "..");
// The store this install uses: its lobe prefix on the engine .env names.
const prefix = process.env.PLANIA_DEVVA_PREFIX?.trim() || "plania";
const engine = devvaAddress();

// PLA-I2-19: Windows' stop and start requests run with this Node and package.
const sys = { platform: process.platform, uid: userInfo().uid, home: homedir(), ...detectSystem(), node: process.execPath, root, localAppData: process.env.LOCALAPPDATA };
let service: { stop: () => Promise<void>; start: () => Promise<void> } | null = null;
if (!values["no-service"]) {
  const stop = stopCommand(sys);
  const start = startCommand(sys);
  if (!stop || !start || !serviceInstalled(sys)) {
    console.error(PASOS.noService);
    process.exit(1);
  }
  service = {
    stop: async () => void execFileSync(stop.cmd, stop.args, { stdio: "inherit", cwd: root }),
    start: async () => void execFileSync(start.cmd, start.args, { stdio: "inherit", cwd: root }),
  };
}

const promptsProject = process.env.PLANIA_PROMPTS_PROJECT || "plania";

try {
  await update({
    root,
    packageFile: path.resolve(packageFile),
    now: () => new Date(),
    log: (line) => console.log(line),
    inFlight: () => withDb((db) => inFlight(db)),
    extract: async (file, dir) => void execFileSync("tar", ["-xzf", file, "-C", dir], { stdio: "inherit" }),
    installDeps: async (dir) => void execSync("pnpm install --prod --frozen-lockfile", { cwd: dir, stdio: "inherit" }),
    backupDir: backupDir(),
    // The nightly job's checked dump of the store's log, read fresh from the engine (the server may still run).
    dump: (file) => dumpStore({ prefix, host: engine.host, port: engine.port, tokenFile: engine.tokenFile, clientModule: engine.client }, file),
    service,
    // Role prompts nobody edited in Plania take the release's text; edited ones stay and are reported.
    kitRoles: () =>
      withDb(async (db): Promise<KitHeldRole[]> => {
        if (!(await readerOf(db).get("projects", { slug: promptsProject }))) return [];
        await kitSync(db, { force: false });
        return (await kitStatus(db))
          .filter((r) => r.state === "doc_newer" || r.state === "both_changed")
          .map((r) => ({ role: r.role, title: r.title, state: r.state as KitHeldRole["state"] }));
      }),
    // machine_state belongs to no project.
    record: (report) =>
      withDb(async (db) => {
        await writeVia(db, async (uow) => {
          if (await uow.get("machineState", { key: "update.last" })) await uow.update("machineState", { key: "update.last" }, { value: report, updatedAt: uow.now });
          else await uow.insert("machineState", { key: "update.last", value: report });
        });
      }),
    port: Number(values.port),
  });
  await closeStore().catch(() => {});
} catch (e) {
  await closeStore().catch(() => {});
  if (e instanceof UpdateError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
