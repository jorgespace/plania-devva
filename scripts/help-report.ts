// PLA-I2-18: pnpm help:report — the help report for when the screen does not start. Writes
// plania-ayuda-<date>.txt in the current folder (or --out <file>, or - for the terminal) and prints where.
// It works without the store: then the file says the database did not answer and carries what it could read.
// It sends nothing anywhere.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { closeStore, withDb, type Db } from "../src/db/client.js";
import { buildHelpReport, helpReportFileName, renderHelpReport } from "../src/help-report/index.js";

const { values } = parseArgs({ options: { out: { type: "string" } }, strict: true });
const root = path.resolve(import.meta.dirname, "..");

const report = await buildHelpReport({
  root,
  // The store (the devva engine): opening it fails when the engine does not answer.
  openDb: async () => ({ db: await withDb(async (d): Promise<Db> => d), close: closeStore }),
});
const text = renderHelpReport(report);
if (values.out === "-") process.stdout.write(text);
else {
  const file = path.resolve(values.out ?? helpReportFileName(report));
  await writeFile(file, text, { mode: 0o600 });
  console.log(`Informe guardado en ${file}. Revísalo y, si quieres, mándalo a quien te ayuda: Plania no lo envía.`);
}
