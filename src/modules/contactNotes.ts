import { db } from "../db/index.js";

/**
 * NOTIZEN JE KONTAKT (2026-09-22). Bewusst eine eigene Tabelle statt weiterer Spalten auf
 * `contacts`: eine Notiz ist ein EREIGNIS mit Zeitpunkt, kein Zustand. Nur so kann die
 * Kontaktspur zeigen, wann etwas festgehalten wurde, und mehrere Notizen nebeneinander
 * bestehen. `contacts.notes` bleibt unangetastet (Altbestand aus dem Import).
 */
export type ContactNote = {
  id: number;
  contact_id: number;
  text: string;
  created_at: string;
};

const MAX = 4000;

export function addContactNote(contactId: number, text: string): number {
  if (!Number.isInteger(contactId) || contactId <= 0) throw new Error("Bitte wähle einen Kontakt.");
  const inhalt = typeof text === "string" ? text.trim().slice(0, MAX) : "";
  if (!inhalt) throw new Error("Die Notiz ist leer.");
  if (!db.prepare("SELECT 1 FROM contacts WHERE id=?").get(contactId)) throw new Error("Kontakt nicht gefunden.");
  return Number(db.prepare("INSERT INTO contact_notes(contact_id,text) VALUES(?,?)").run(contactId, inhalt).lastInsertRowid);
}

export function deleteContactNote(id: number): boolean {
  return db.prepare("DELETE FROM contact_notes WHERE id=?").run(id).changes > 0;
}

export function listContactNotes(contactId: number, limit = 100): ContactNote[] {
  return db.prepare(
    "SELECT id,contact_id,text,created_at FROM contact_notes WHERE contact_id=? ORDER BY created_at DESC, id DESC LIMIT ?",
  ).all(contactId, limit) as ContactNote[];
}

/** Anzahl Notizen je Kontakt – für die Kontaktliste, ohne jede Notiz zu laden. */
export function noteCounts(): Map<number, number> {
  const rows = db.prepare("SELECT contact_id, COUNT(*) AS n FROM contact_notes GROUP BY contact_id").all() as Array<{ contact_id: number; n: number }>;
  return new Map(rows.map((row) => [row.contact_id, row.n]));
}
