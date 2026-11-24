// Moves a machine from main's Postgres store to this branch's devva store: every row of every table in the schema,
// copied as it is (same ids, same timestamps). The Postgres database is only read.
//
//   read    each table with the columns the database has. A column it lacks (a migration it never got) is filled
//           the way an insert fills it (src/store/defaults.ts), else null; a column only it has is left behind.
//   check   a column the schema requires, with no default, that the database lacks while the table has rows
//           would be stored as null: the copy refuses and names it.
//   write   the rows as write sets of about BATCH_BYTES each, through DevvaStore.replicate, into a store that holds
//           no commit yet. The log keeps them as ordinary commits, and the store numbers the next row of an
//           identity column after the highest id it copied.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig, type PgColumn } from "drizzle-orm/pg-core";
import type pg from "pg";
import { defaultOf, withDefaults } from "./defaults.js";
import type { DevvaStore } from "./devva.js";
import { keyOf, metaOf, tableNames, tableOf } from "./meta.js";
import type { Change, TableName } from "./types.js";

type AnyRow = Record<string, unknown>;

// What one source database holds. postgresSource reads a real one; tests pass their own.
export type Source = {
  // Every table name in the database's current schema.
  tables(): Promise<string[]>;
  // The column names of one table.
  columns(pgTable: string): Promise<string[]>;
  // Every row of a table, with only the named schema properties, mapped as the schema maps them (Dates, jsonb).
  rows(table: TableName, props: string[]): Promise<AnyRow[]>;
};

export function postgresSource(pool: pg.Pool): Source {
  const db = drizzle(pool);
  return {
    async tables() {
      const r = await pool.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE'");
      return r.rows.map((x) => x.table_name);
    },
    async columns(name) {
      const r = await pool.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = current_schema() and table_name = $1", [name]);
      return r.rows.map((x) => x.column_name);
    },
    async rows(table, props) {
      if (!props.length) return [];
      const cols = getTableColumns(tableOf(table)) as Record<string, PgColumn>;
      return (await db.select(Object.fromEntries(props.map((p) => [p, cols[p]!]))).from(tableOf(table))) as AnyRow[];
    },
  };
}

export type TableReport = {
  table: TableName;
  // The table's name in Postgres.
  source: string;
  rows: number;
  // The source has no such table: nothing to copy.
  absent: boolean;
  // Schema columns the source lacks, filled with their default or null.
  filled: string[];
  // Of those, the ones the schema requires and nothing can fill. A table with rows and one of these is refused.
  unfillable: string[];
  // Source columns the schema no longer has. Their values are not copied.
  dropped: string[];
};

export type SourceData = {
  tables: { table: TableName; rows: AnyRow[] }[];
  report: TableReport[];
  // Source tables the schema does not know. Not copied.
  unknown: string[];
};

// Reads every schema table from the source. now is the clock reading a filled timestamp column gets.
export async function readSource(src: Source, now = new Date()): Promise<SourceData> {
  const present = new Set(await src.tables());
  const known = new Set<string>();
  const out: SourceData = { tables: [], report: [], unknown: [] };
  for (const table of tableNames()) {
    const source = getTableConfig(tableOf(table)).name;
    known.add(source);
    const cols = getTableColumns(tableOf(table)) as Record<string, PgColumn>;
    if (!present.has(source)) {
      out.report.push({ table, source, rows: 0, absent: true, filled: [], unfillable: [], dropped: [] });
      continue;
    }
    const have = new Set(await src.columns(source));
    const props = Object.keys(cols).filter((p) => have.has(cols[p]!.name));
    const filled = Object.keys(cols).filter((p) => !have.has(cols[p]!.name));
    const byName = new Map(getTableConfig(tableOf(table)).columns.map((c) => [c.name, c]));
    const unfillable = filled.filter((p) => cols[p]!.notNull && defaultOf(byName.get(cols[p]!.name) ?? cols[p]!) === undefined);
    const schemaNames = new Set(Object.values(cols).map((c) => c.name));
    const dropped = [...have].filter((n) => !schemaNames.has(n));
    const rows = (await src.rows(table, props)).map((r) => complete(table, r, now));
    rows.sort((a, b) => keyText(table, a).localeCompare(keyText(table, b)));
    out.report.push({ table, source, rows: rows.length, absent: false, filled, unfillable, dropped });
    out.tables.push({ table, rows });
  }
  out.unknown = [...present].filter((n) => !known.has(n)).sort();
  return out;
}

const keyText = (table: TableName, row: AnyRow) => JSON.stringify(metaOf(table).key.map((k) => (row[k] instanceof Date ? (row[k] as Date).toISOString() : row[k])));

function complete(table: TableName, row: AnyRow, now: Date): AnyRow {
  const full = withDefaults(table, row, now);
  for (const col of metaOf(table).columns) if (full[col] === undefined) full[col] = null;
  return full;
}

// The tables a copy would refuse: rows present and a required column with nothing to fill it.
export const refusals = (data: SourceData): TableReport[] => data.report.filter((r) => r.rows > 0 && r.unfillable.length > 0);

// About 1 MB of rows per commit: well under the engine's 16 MiB frame, and few enough commits for a fast boot.
export const BATCH_BYTES = 1_000_000;

const sizeOf = (row: AnyRow) => JSON.stringify(row, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)).length;

// Writes the rows into an empty store. Returns how many commits it took.
export async function copyInto(store: DevvaStore, data: SourceData, onCommit?: (commits: number, rows: number) => void): Promise<number> {
  const refused = refusals(data);
  if (refused.length) throw new Error(`the source lacks required columns: ${refused.map((r) => `${r.source}.${r.unfillable.join(", ")}`).join("; ")}`);
  if (store.commits !== 0) throw new Error(`the store already holds ${store.commits} commits; the copy needs an empty one`);
  let batch: Change[] = [];
  let bytes = 0;
  let commits = 0;
  let rows = 0;
  const flush = async () => {
    if (!batch.length) return;
    await store.replicate({ projectId: "", changes: batch });
    commits += 1;
    rows += batch.length;
    onCommit?.(commits, rows);
    batch = [];
    bytes = 0;
  };
  for (const { table, rows: tableRows } of data.tables) {
    for (const row of tableRows) {
      const size = sizeOf(row);
      if (batch.length && bytes + size > BATCH_BYTES) await flush();
      batch.push({ table, op: "put", key: keyOf(table, row), row });
      bytes += size;
    }
  }
  await flush();
  return commits;
}

// Rows per table in the store, for comparing with the report after a copy.
export async function storeCounts(store: DevvaStore): Promise<Map<TableName, number>> {
  const out = new Map<TableName, number>();
  await store.read(async (r) => {
    for (const table of tableNames()) out.set(table, await r.count(table));
  });
  return out;
}
