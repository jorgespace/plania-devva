// Moves this machine's plania data from main's Postgres store into the devva store your .env names
// (DEVVA_HOST, DEVVA_PORT, DEVVA_TOKEN_FILE, PLANIA_DEVVA_PREFIX, default prefix plania). See src/store/from-postgres.ts.
//   pnpm devva:from-postgres postgres://postgres@127.0.0.1:5432/plania --dry-run   what it would copy; writes nothing
//   pnpm devva:from-postgres postgres://postgres@127.0.0.1:5432/plania             the copy
// The Postgres database is only read. The store must hold no commit yet, so run it before plania first starts on
// devva, with the server stopped. The owner runs it; no agent copies into a real store.
import pg from "pg";
import { DevvaStore } from "../src/store/devva.js";
import { copyInto, postgresSource, readSource, refusals, storeCounts } from "../src/store/from-postgres.js";

const url = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!url || !/^postgres(ql)?:\/\//.test(url)) {
  console.error("usage: pnpm devva:from-postgres <postgres url> [--dry-run]");
  process.exit(2);
}
const prefix = process.env.PLANIA_DEVVA_PREFIX || "plania";

const pool = new pg.Pool({ connectionString: url, max: 2 });
let store: DevvaStore | null = null;
try {
  const data = await readSource(postgresSource(pool));
  let total = 0;
  for (const r of data.report) {
    total += r.rows;
    const notes = [
      r.absent ? "not in the source" : "",
      r.filled.length ? `filled: ${r.filled.join(", ")}` : "",
      r.unfillable.length ? `REQUIRED and missing: ${r.unfillable.join(", ")}` : "",
      r.dropped.length ? `left behind: ${r.dropped.join(", ")}` : "",
    ].filter(Boolean);
    if (r.rows || notes.length) console.log(`${r.source}: ${r.rows}${notes.length ? `  (${notes.join("; ")})` : ""}`);
  }
  if (data.unknown.length) console.log(`tables the schema does not know, not copied: ${data.unknown.join(", ")}`);
  console.log(`${total} rows in ${data.tables.length} tables`);
  const refused = refusals(data);
  if (refused.length) {
    console.error(`refused: ${refused.map((r) => r.source).join(", ")} lack a required column`);
    process.exitCode = 1;
  } else if (dryRun) {
    console.log(`dry run: nothing written. The copy goes to the lobes ${prefix}_log and ${prefix}_ent.`);
  } else {
    store = await DevvaStore.open({ prefix, timeoutMs: 60_000 });
    const started = Date.now();
    const commits = await copyInto(store, data, (c, n) => {
      if (c % 10 === 0) console.log(`  ${n} of ${total} rows (${c} commits)`);
    });
    const counts = await storeCounts(store);
    const off = data.report.filter((r) => (counts.get(r.table) ?? 0) !== r.rows);
    if (off.length) {
      for (const r of off) console.error(`${r.source}: ${r.rows} read, ${counts.get(r.table) ?? 0} in the store`);
      process.exitCode = 1;
    } else console.log(`copied ${total} rows in ${commits} commits to ${prefix} in ${Math.round((Date.now() - started) / 1000)} s; every table's count matches`);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  store?.close();
  await pool.end();
}
