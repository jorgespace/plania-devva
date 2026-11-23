// PLA-I2-14: makes the stored owner values neutral on the devva store ('jorge' → 'owner', 'Needs Jorge' →
// 'Needs owner', …), as main's migration 0062_owner_neutral does on Postgres. See src/store/owner-neutral.ts.
//   pnpm devva:owner-neutral
// Run it once, with the server stopped, on the store your .env names. Safe to run twice.
import { closeStore, withDb } from "../src/db/client.js";
import { storeOf } from "../src/store/port.js";
import { ownerNeutral } from "../src/store/owner-neutral.js";

try {
  const changed = await withDb((db) => storeOf(db).write("", {}, ownerNeutral));
  const total = Object.values(changed).reduce((a, b) => a + b, 0);
  if (!total) console.log("Nothing to change: the stored owner values are already neutral.");
  else for (const [table, n] of Object.entries(changed)) console.log(`${table}: ${n} row(s) changed`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await closeStore();
}
