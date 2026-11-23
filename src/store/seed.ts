// Rows every store starts with, which main's SQL migrations insert: the runner settings row and the factory
// seats (0075_equipo_puestos). On devva there are no migrations, so the store adds whichever is missing when it
// opens. It only inserts: a row that exists is left as it is.
import type { UnitOfWork } from "./types.js";

// 0075: the factory seats, in the order the migration lists them.
export const FACTORY_PUESTOS = [
  ["product-owner", "Product owner"],
  ["research", "Research"],
  ["artist", "Artist"],
  ["taller", "Builder"],
  ["qa", "QA"],
  ["copy", "Copy"],
  ["seguridad", "Seguridad"],
  ["marketing", "Marketing"],
  ["data", "Data"],
] as const;

// True when the store lacks one of the fixed rows, so a read-only check can skip the write.
export async function missingFixedRows(r: Pick<UnitOfWork, "get">): Promise<boolean> {
  if (!(await r.get("runnerSettings", { id: 1 }))) return true;
  for (const [slug] of FACTORY_PUESTOS) if (!(await r.get("puestos", { slug }))) return true;
  return false;
}

export async function seedFixedRows(uow: UnitOfWork): Promise<void> {
  if (!(await uow.get("runnerSettings", { id: 1 }))) await uow.insert("runnerSettings", { id: 1 });
  for (const [slug, title] of FACTORY_PUESTOS) {
    if (!(await uow.get("puestos", { slug }))) await uow.insert("puestos", { slug, title, line: "", origin: "factory", promptRef: slug });
  }
}
