import type { Db } from "../db/client.js";
import { inbox, type InboxItem } from "../mcp/inbox.js";
import { sendToAll, vapidConfig, webPushSender, type PushPayload, type Sender } from "../push.js";
import { storeOf, readerOf } from "../store/port.js";
import type { Job } from "./index.js";
import { defineWords, say } from "../words.js";

// 2.12 push: once a minute, what is new in the owner's inbox (decisiones and pasos: a question,
// a human_action created or parsed from a the owner: line, a release that became ready)
// goes to every subscribed phone as one notification, so a burst is one message. The inbox is the
// source rather than the event feed because it already says what waits on him, whatever wrote it,
// and drops what was answered in the same minute. What was seen lives in machine_state (key "push"):
// the first run only takes the bookmark, so turning push on never replays the backlog.

export const PUSH_EVERY_MS = 60_000;
const STATE_KEY = "push";

type PushState = { seen: string[]; at: string; sent?: number };

// Ids are only unique per kind (a release is release:<slug>).
const itemId = (i: InboxItem) => `${i.kind}:${i.id}`;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// PLA-I2-10: the notice in the install's language; the Spanish is unchanged.
export const PUSH_WORDS = defineWords({
  es: { asked: "Te preguntan", release: "Listo para lanzar", yours: "Te toca", decisions: (n: number) => count(n, "decisión", "decisiones"), steps: (n: number) => count(n, "paso", "pasos"), and: " y ", several: (parts: string) => `Te toca: ${parts}` },
  en: { asked: "A question for you", release: "Ready to release", yours: "Your turn", decisions: (n: number) => count(n, "decision", "decisions"), steps: (n: number) => count(n, "step", "steps"), and: " and ", several: (parts: string) => `Your turn: ${parts}` },
});

// One notification for everything new this minute. A tap opens the Bandeja on Decisiones when one
// of them is a decision, else on Pasos. One item says what it is; several say how many and the first.
export function messageFor(items: InboxItem[], names: Map<string, string>): PushPayload {
  const decisiones = items.filter((i) => i.group === "decisiones");
  const pasos = items.filter((i) => i.group === "pasos");
  const tab = decisiones.length ? "decisiones" : "pasos";
  const first = decisiones[0] ?? pasos[0]!;
  const where = names.get(first.project) ?? first.project;
  const line = `${where}${first.key ? ` · ${first.key}` : ""}: ${first.why || first.title || ""}`.trim();
  const w = say(PUSH_WORDS);
  if (items.length === 1) {
    const title = first.kind === "question" ? w.asked : first.kind === "release" ? w.release : w.yours;
    return { title, body: line, url: `/inbox?tab=${tab}`, tag: "plania-te-toca" };
  }
  const parts = [decisiones.length ? w.decisions(decisiones.length) : "", pasos.length ? w.steps(pasos.length) : ""].filter(Boolean);
  return { title: w.several(parts.join(w.and)), body: line, url: `/inbox?tab=${tab}`, tag: "plania-te-toca" };
}

async function readState(db: Db): Promise<PushState | null> {
  const row = await readerOf(db).get("machineState", { key: STATE_KEY });
  return row ? (row.value as unknown as PushState) : null;
}

// A store write belongs to a project; machine_state belongs to the Mac, so its writes belong to none.
const NO_PROJECT = "";

async function writeState(db: Db, state: PushState) {
  const value = state as unknown as Record<string, unknown>;
  await storeOf(db).write(NO_PROJECT, {}, async (uow) => {
    if (await uow.get("machineState", { key: STATE_KEY })) await uow.update("machineState", { key: STATE_KEY }, { value, updatedAt: uow.now });
    else await uow.insert("machineState", { key: STATE_KEY, value });
  });
}

export async function runPush(db: Db, now = new Date(), send: Sender = webPushSender) {
  const box = await inbox(db, "all");
  const current = (box.items as InboxItem[]).filter((i) => i.group !== "limpieza");
  const prev = await readState(db);
  const seen = new Set(prev?.seen ?? []);
  const fresh = prev ? current.filter((i) => !seen.has(itemId(i))) : [];
  const summary = { new: fresh.length, sent: 0, failed: 0, removed: 0 };
  const vapid = vapidConfig();
  if (fresh.length && vapid) {
    if (await readerOf(db).count("pushSubscriptions")) {
      const names = new Map((await readerOf(db).find("projects")).map((p) => [p.slug, p.title]));
      Object.assign(summary, await sendToAll(db, messageFor(fresh, names), vapid, send));
    }
  }
  // What is no longer waiting drops out of seen, so if it comes back it is news again.
  await writeState(db, { seen: current.map(itemId), at: now.toISOString(), sent: summary.sent });
  return summary;
}

export const pushJob: Job = { name: "push", intervalMs: PUSH_EVERY_MS, runOnce: (db, now) => runPush(db, now) };
