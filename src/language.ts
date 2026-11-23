// PLA-I2-10: the install's language, the one switch for the screen, the morning brief and the server's sentences.
// Spanish ("es") unless the owner chose English ("en") at first start or later in Plomería. Stored in machine_state
// (key "language"), the way src/folders.ts keeps the folders, so no migration is needed; PLANIA_LANGUAGE wins when
// set. Saving it also sets the brief's language, so the brief follows it instead of keeping a switch of its own.
// The screen's twin is ui/src/lib/i18n.ts; the locale for dates and numbers follows it (src/locale.ts).
import type { Q } from "./mcp/tx.js";
import { writeVia } from "./runner/limits.js";
import { readerOf } from "./store/port.js";
import { LANGUAGES, DEFAULT_LANGUAGE, isLanguage, type Language } from "../ui/src/lib/i18n.js";

export { LANGUAGES, DEFAULT_LANGUAGE, isLanguage, type Language };
export const LANGUAGE_KEY = "language";

let cached: Language | null = null;
// P4: set by the command-line tools (the install, the machine check) before a language is chosen; null in the server.
let systemFallback: Language | null = null;

/** The language now: PLANIA_LANGUAGE, else the stored one, else the system's (command-line tools only), else Spanish. */
export function installLanguage(env: NodeJS.ProcessEnv = process.env): Language {
  const v = env.PLANIA_LANGUAGE?.trim().toLowerCase();
  if (isLanguage(v)) return v;
  return cached ?? systemFallback ?? DEFAULT_LANGUAGE;
}

/**
 * P4: the system's language from its locale: Spanish for es*, English for anything else. LC_ALL, LC_MESSAGES and LANG
 * first (C and POSIX say nothing), then the locale Node reads from the system (on Windows, the user's region).
 */
export function localeLanguage(env: NodeJS.ProcessEnv = process.env, systemLocale: string = Intl.DateTimeFormat().resolvedOptions().locale): Language {
  const named = [env.LC_ALL, env.LC_MESSAGES, env.LANG].map((x) => x?.trim()).find((x) => x && !/^(C|POSIX)(\.|$)/i.test(x));
  return /^es([-_.@]|$)/i.test(named ?? systemLocale ?? "") ? "es" : "en";
}

/** P4: the install command's words follow the system locale until a language is chosen. */
export function followSystemLocale(env: NodeJS.ProcessEnv = process.env, systemLocale?: string): Language {
  systemFallback = localeLanguage(env, systemLocale);
  return systemFallback;
}

/** True when the language was chosen (stored or set in PLANIA_LANGUAGE); false on an install before first start. */
export const languageChosen = (env: NodeJS.ProcessEnv = process.env): boolean => isLanguage(env.PLANIA_LANGUAGE?.trim().toLowerCase()) || cached !== null;

/** Reads the stored language into memory. The server calls it at start (through loadInstallState). */
export async function loadLanguage(db: Q): Promise<Language> {
  const row = await readerOf(db).get("machineState", { key: LANGUAGE_KEY });
  const v = (row?.value as { language?: unknown } | undefined)?.language;
  cached = isLanguage(v) ? v : null;
  return cached ?? DEFAULT_LANGUAGE;
}

/** Stores the language and points the brief at it. Takes effect at once (in memory). */
export async function saveLanguage(db: Q, language: Language): Promise<Language> {
  if (!isLanguage(language)) throw new Error(`unknown language: ${String(language)}`);
  // Both rows belong to no project: one company write (first start's own write when called inside it).
  await writeVia(db, async (uow) => {
    const now = uow.now;
    if (await uow.get("machineState", { key: LANGUAGE_KEY })) await uow.update("machineState", { key: LANGUAGE_KEY }, { value: { language }, updatedAt: now });
    else await uow.insert("machineState", { key: LANGUAGE_KEY, value: { language }, updatedAt: now });
    // The brief follows: its row keeps every other setting; with no row yet the defaults apply with this language.
    if (await uow.get("briefSettings", { id: 1 })) await uow.update("briefSettings", { id: 1 }, { language, updatedAt: now });
    else await uow.insert("briefSettings", { id: 1, language, updatedAt: now });
  });
  cached = language;
  return language;
}

/** Tests: forget what was loaded. */
export function resetLanguage(): void {
  cached = null;
  systemFallback = null;
}
