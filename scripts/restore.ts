// PLA-I2-8: pnpm restore:plania <backup file> — bring Plania's data back from a backup (src/update/restore.ts),
// into the store on the devva engine that .env names (PLANIA_DEVVA_PREFIX, default plania), or another one:
//   pnpm restore:plania ~/plania-backups/plania-20261118.devva.jsonl.gz --prefix plania_restore
//   pnpm restore:plania <file> --overwrite --confirm plania
// A store that already has data is replaced only when asked twice. Stop Plania before replacing the store it uses.
// --database is the same as --prefix (the name it had when the data was in Postgres).
import path from "node:path";
import { parseArgs } from "node:util";
import { devvaTarget, restore, RestoreError } from "../src/update/restore.js";

const { values, positionals } = parseArgs({
  options: {
    prefix: { type: "string" },
    database: { type: "string" },
    overwrite: { type: "boolean", default: false },
    confirm: { type: "string" },
  },
  allowPositionals: true,
  strict: true,
});
const file = positionals[0];
if (!file) {
  console.error("Uso: pnpm restore:plania <respaldo .devva.jsonl.gz> [--prefix <nombre>] [--overwrite --confirm <nombre>]");
  process.exit(2);
}
const prefix = values.prefix ?? values.database ?? (process.env.PLANIA_DEVVA_PREFIX?.trim() || "plania");

try {
  await restore({
    file: path.resolve(file),
    prefix,
    overwrite: values.overwrite,
    confirm: values.confirm,
    open: devvaTarget(),
    log: (line) => console.log(line),
  });
} catch (e) {
  if (e instanceof RestoreError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
