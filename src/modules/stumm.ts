/**
 * STUMM – komplette Funkstille für einen Chat oder Kontakt (2026-10-07).
 *
 * Sinans Vorgabe: Bot auf Voll-Automatik, „ich will mich damit nicht mehr beschäftigen“. Dafür
 * braucht es einen Knopf, mit dem Menschen aus dem GESAMTEN Nachrichten-Prozess fallen – nicht nur
 * aus der proaktiven Ansprache (`automation_status='excluded'` stoppt Erstnachricht/Nachfassen,
 * ließ Antwort-Entwürfe aber bewusst zu). Stumm heißt:
 *  - Sales-Agent überspringt den Thread (kein KI-Aufruf, keine Antwort, keine Eskalation),
 *  - `generateInboxDrafts` legt keinen Antwort-Entwurf an,
 *  - `sendDraft` verwirft alles Offene zu diesem Kontakt/Thread,
 *  - proaktive Ansprache ist über die Beziehungsregel (`do_not_contact`) ohnehin aus.
 * Aufheben: „Wieder freigeben“ im Cockpit (`setRelationshipPolicy resume`) oder `stummAufheben`.
 */
import { db } from "../db/index.js";
import { applyRelationshipSignal } from "./relationshipPolicy.js";
import { resolveContactIdentity } from "./contactIdentity.js";

export type StummQuelle = "mensch" | "agent" | "regel";
export type StummEintrag = {
  id: number;
  contact_id: number | null;
  thread_url: string | null;
  participant: string | null;
  grund: string;
  quelle: StummQuelle;
  created_at: string;
};

const tabelleVorhanden = (name: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** Ist dieser Thread oder dieser Kontakt stumm? Liefert den Eintrag (mit Grund) oder null. */
export function istStumm(threadUrl?: string | null, contactId?: number | null): StummEintrag | null {
  const t = threadUrl && threadUrl.trim() ? threadUrl.trim() : null;
  const c = Number.isInteger(contactId) && (contactId as number) > 0 ? (contactId as number) : null;
  if (!t && !c) return null;
  return (db.prepare(
    `SELECT * FROM stumm
      WHERE (? IS NOT NULL AND thread_url=?) OR (? IS NOT NULL AND contact_id=?)
      ORDER BY thread_url IS NULL, id LIMIT 1`,
  ).get(t, t, c, c) as StummEintrag | undefined) ?? null;
}

/** Alle bekannten Chat-URLs eines Kontakts: bestätigte Identitäten + Threads seiner Antwort-Entwürfe. */
function threadsFuerKontakt(contactId: number): string[] {
  const aus = new Set<string>();
  for (const r of db.prepare(
    "SELECT identity_value FROM contact_identities WHERE contact_id=? AND identity_type='thread_url'",
  ).all(contactId) as { identity_value: string }[]) aus.add(r.identity_value);
  for (const r of db.prepare(
    "SELECT DISTINCT thread_url FROM drafts WHERE contact_id=? AND kind IN ('message','pitchidee') AND thread_url LIKE '%/messaging/%'",
  ).all(contactId) as { thread_url: string }[]) aus.add(r.thread_url);
  return [...aus].filter(Boolean);
}

export interface StummAuftrag {
  threadUrl?: string | null;
  contactId?: number | null;
  participant?: string | null;
  grund: string;
  quelle: StummQuelle;
}

/**
 * Schaltet Thread und/oder Kontakt stumm. Idempotent. Räumt sofort auf: alle offenen Entwürfe des
 * Kontakts/Threads werden verworfen, laufende Agent-Gespräche auf `stumm` gesetzt, der Kontakt über
 * die Beziehungsregel dauerhaft aus der proaktiven Ansprache genommen. `actions` bleibt unberührt.
 */
export function stummschalten(a: StummAuftrag): { contactId: number | null; threads: string[]; verworfen: number } {
  const grund = String(a.grund || "Stummgeschaltet").replace(/\s+/g, " ").trim().slice(0, 240);
  const threadUrl = a.threadUrl && a.threadUrl.trim() ? a.threadUrl.trim() : null;
  let contactId = Number.isInteger(a.contactId) && (a.contactId as number) > 0 ? (a.contactId as number) : null;
  if (!contactId && threadUrl) contactId = resolveContactIdentity(threadUrl, a.participant || "", "stumm")?.id ?? null;
  if (!contactId && !threadUrl) throw new Error("Weder Chat noch Kontakt angegeben.");

  const threads = new Set<string>();
  if (threadUrl) threads.add(threadUrl);
  if (contactId) for (const t of threadsFuerKontakt(contactId)) threads.add(t);
  const liste = [...threads];

  const tx = db.transaction(() => {
    const ins = db.prepare(
      "INSERT OR IGNORE INTO stumm(contact_id,thread_url,participant,grund,quelle) VALUES(?,?,?,?,?)",
    );
    for (const t of liste) ins.run(contactId, t, a.participant ?? null, grund, a.quelle);
    if (contactId) ins.run(contactId, null, a.participant ?? null, grund, a.quelle);

    let verworfen = 0;
    if (contactId) {
      // Proaktive Ansprache aus + deren Entwürfe weg (bestehende Regel, kein zweiter Weg).
      applyRelationshipSignal(contactId, { kind: "do_not_contact", reason: grund }, a.quelle === "mensch" ? "manual" : "agent", `stumm:${Date.now()}`);
      verworfen += db.prepare(
        `UPDATE drafts SET status='discarded',rejection_reason='stumm',blockiert_grund=?
          WHERE status IN ('pending','approved','blockiert') AND contact_id=?`,
      ).run(grund, contactId).changes;
    }
    if (liste.length) {
      const platz = liste.map(() => "?").join(",");
      verworfen += db.prepare(
        `UPDATE drafts SET status='discarded',rejection_reason='stumm',blockiert_grund=?
          WHERE status IN ('pending','approved','blockiert') AND thread_url IN (${platz})`,
      ).run(grund, ...liste).changes;
      if (tabelleVorhanden("agent_conversations")) {
        db.prepare(`UPDATE agent_conversations SET status='stumm',updated_at=datetime('now') WHERE thread_url IN (${platz})`).run(...liste);
      }
    }
    return verworfen;
  });
  const verworfen = tx();
  return { contactId, threads: liste, verworfen };
}

/** Hebt die Funkstille auf (Thread oder Kontakt). Die proaktive Ansprache bleibt gesperrt, bis der
 *  Kontakt im Cockpit „wieder freigegeben“ wird – das macht `setRelationshipPolicy('resume')`, die
 *  ihrerseits diese Funktion ruft. */
export function stummAufheben(x: { threadUrl?: string | null; contactId?: number | null }): number {
  const t = x.threadUrl && x.threadUrl.trim() ? x.threadUrl.trim() : null;
  const c = Number.isInteger(x.contactId) && (x.contactId as number) > 0 ? (x.contactId as number) : null;
  if (!t && !c) return 0;
  const tx = db.transaction(() => {
    const rows = db.prepare(
      "SELECT thread_url FROM stumm WHERE (? IS NOT NULL AND thread_url=?) OR (? IS NOT NULL AND contact_id=?)",
    ).all(t, t, c, c) as { thread_url: string | null }[];
    const threads = rows.map((r) => r.thread_url).filter((u): u is string => !!u);
    if (threads.length && tabelleVorhanden("agent_conversations")) {
      db.prepare(
        `UPDATE agent_conversations SET status='aktiv',updated_at=datetime('now')
          WHERE status='stumm' AND thread_url IN (${threads.map(() => "?").join(",")})`,
      ).run(...threads);
    }
    return db.prepare(
      "DELETE FROM stumm WHERE (? IS NOT NULL AND thread_url=?) OR (? IS NOT NULL AND contact_id=?)",
    ).run(t, t, c, c).changes;
  });
  return tx();
}

/** Für Cockpit/Assistent: wer ist gerade stumm und warum. */
export function stummListe(limit = 200): Array<StummEintrag & { full_name: string | null }> {
  return db.prepare(
    `SELECT s.*, c.full_name FROM stumm s LEFT JOIN contacts c ON c.id=s.contact_id
      WHERE s.thread_url IS NULL OR s.contact_id IS NULL
      ORDER BY s.created_at DESC LIMIT ?`,
  ).all(limit) as Array<StummEintrag & { full_name: string | null }>;
}
