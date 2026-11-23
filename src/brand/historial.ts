// PLA-I69-6: Marca → Historial. Everything the brand has been, in one list: the logo's versions, the style's and the
// voice's (each with its values, so the screen can compare and go back), and every request Marca sent to Taller
// (icons, style, name) with where it stands. Going back never deletes: it makes a new version.
import type { Db } from "../db/client.js";
import { readerOf } from "../store/port.js";
import { tasksMarked } from "./logos.js";
import { listVersions, type VersionRef } from "./upload.js";
import { styleHistory, type Style } from "./style.js";
import { voiceHistory, type Voice } from "./voz.js";

export type RequestKind = "caras" | "estilo" | "nombre";
export type Historial = {
  logo: VersionRef[];
  style: { v: number; at: string; current: boolean; style: Style }[];
  voice: { v: number; at: string; current: boolean; voice: Voice }[];
  requests: { key: string; title: string; kind: RequestKind; status: string; at: string; pr: string | null }[];
};
export const kindOfScope = (scope: string | null): RequestKind | null =>
  !scope ? null : scope.includes("<!-- plania:marca-estilo ") ? "estilo" : scope.includes("<!-- plania:marca-nombre ") ? "nombre" : scope.includes("<!-- plania:marca set=") ? "caras" : null;

export async function historialOf(db: Db, slug: string): Promise<Historial | null> {
  const p = await readerOf(db).get("projects", { slug });
  if (!p) return null;
  const rows = (await tasksMarked(db, p.id, "<!-- plania:marca")).slice(0, 40).map((t) => ({ key: t.key, title: t.title, status: t.status, scope: t.scope, at: t.createdAt, pr: t.prUrl }));
  const requests = rows.flatMap((r) => {
    const kind = kindOfScope(r.scope);
    return kind ? [{ key: r.key, title: r.title, kind, status: r.status, at: r.at.toISOString(), pr: r.pr ?? null }] : [];
  });
  return { logo: await listVersions(db, p.id), style: styleHistory(slug), voice: voiceHistory(slug), requests };
}
