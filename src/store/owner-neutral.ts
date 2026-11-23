// PLA-I2-14 on the devva store: main's migration 0062_owner_neutral as a data step. Stored values become neutral:
//   tasks.status            'Needs Jorge' → ST.needsOwner
//   tasks.origin            'jorge' → 'owner'
//   taskComments.authorAgent, threadMessages.authorAgent and authorRole: 'jorge' → 'owner'
//   every jsonb column      the exact JSON strings in PAIRS, wherever they sit (actor.agent, event payloads, a
//                           blocker's assignee, audit codes, a brief action's undo status). Only whole JSON strings
//                           change, so free text that mentions the first owner is left as it was written.
// Safe to run twice: the second run finds nothing to change. The owner runs it (scripts/devva-owner-neutral.ts);
// no agent applies it to a real store.
import { getTableColumns } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { ST } from "../state/status.js";
import { keyOf, tableNames, tableOf } from "./meta.js";
import type { TableName, UnitOfWork } from "./types.js";

export const PAIRS: readonly [string, string][] = [
  ["jorge", "owner"],
  ["Needs Jorge", ST.needsOwner], // PLA-I2-14: the old spelling, read on purpose
  ["WAITING_ON_JORGE_FREE_TEXT", "WAITING_ON_OWNER_FREE_TEXT"],
  ["JORGE_LINE_PARSED", "OWNER_LINE_PARSED"],
  ["needs_jorge", "needs_owner"],
  ["waiting_jorge", "waiting_owner"],
  ["delegated_by_jorge", "delegated_by_owner"],
  ["handed_to_jorge", "handed_to_owner"],
];

// The text columns 0062 rewrites by value.
const TEXT_COLUMNS: { table: TableName; column: string; from: string; to: string }[] = [
  { table: "tasks", column: "status", from: "Needs Jorge", to: ST.needsOwner }, // PLA-I2-14: the old spelling, read on purpose
  { table: "tasks", column: "origin", from: "jorge", to: "owner" },
  { table: "taskComments", column: "authorAgent", from: "jorge", to: "owner" },
  { table: "threadMessages", column: "authorAgent", from: "jorge", to: "owner" },
  { table: "threadMessages", column: "authorRole", from: "jorge", to: "owner" },
];

// A jsonb value with every whole JSON string in PAIRS replaced, or undefined when nothing changes.
export function neutralJson(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  let text = JSON.stringify(value);
  const before = text;
  for (const [from, to] of PAIRS) text = text.split(JSON.stringify(from)).join(JSON.stringify(to));
  return text === before ? undefined : JSON.parse(text);
}

const jsonColumns = (table: TableName): string[] =>
  Object.entries(getTableColumns(tableOf(table)) as Record<string, PgColumn>)
    .filter(([, c]) => c.dataType === "json")
    .map(([prop]) => prop);

// Rewrites every stored value 0062 rewrites, inside one write. Returns how many rows changed per table.
export async function ownerNeutral(uow: UnitOfWork): Promise<Record<string, number>> {
  const changed: Record<string, number> = {};
  const note = (table: string) => (changed[table] = (changed[table] ?? 0) + 1);
  for (const { table, column, from, to } of TEXT_COLUMNS) {
    const rows = await uow.update(table, { [column]: from } as never, { [column]: to } as never);
    for (let i = 0; i < rows.length; i++) note(table);
  }
  for (const table of tableNames()) {
    const cols = jsonColumns(table);
    if (!cols.length) continue;
    for (const row of (await uow.find(table)) as Record<string, unknown>[]) {
      const patch: Record<string, unknown> = {};
      for (const col of cols) {
        const next = neutralJson(row[col]);
        if (next !== undefined) patch[col] = next;
      }
      if (!Object.keys(patch).length) continue;
      await uow.update(table, keyOf(table, row) as never, patch as never);
      note(table);
    }
  }
  return changed;
}
