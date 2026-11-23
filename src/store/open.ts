// Opens plania's store, once per process, and makes it what makeDb and withDb hand out.
// The store is devva (deploy/devva/README.md): DEVVA_HOST, DEVVA_PORT, DEVVA_TOKEN_FILE and
// PLANIA_DEVVA_PREFIX say which engine and which lobes.
import { useDb } from "../db/client.js";
import { DevvaStore } from "./devva.js";
import { missingFixedRows, seedFixedRows } from "./seed.js";

let open: Promise<DevvaStore> | null = null;

export function openStore(): Promise<DevvaStore> {
  open ??= DevvaStore.open({ prefix: process.env.PLANIA_DEVVA_PREFIX || "plania" }).then(async (store) => {
    // The rows main's migrations insert (src/store/seed.ts), added once when missing.
    if (await store.read(missingFixedRows)) await store.write("", {}, seedFixedRows);
    useDb(store.handle);
    return store;
  });
  return open;
}
