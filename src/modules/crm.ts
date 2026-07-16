import { db } from "../db/index.js";

export type Contact = {
  id: number;
  profile_url: string;
  full_name?: string;
  headline?: string;
  status: string;
  notes?: string;
};

/** Kontakt anlegen oder ergänzen (kein Duplikat pro Profil-URL). */
export function upsertContact(c: { profileUrl: string; fullName?: string; headline?: string }) {
  db.prepare(
    `INSERT INTO contacts(profile_url, full_name, headline)
     VALUES(?,?,?)
     ON CONFLICT(profile_url) DO UPDATE SET
       full_name = COALESCE(excluded.full_name, contacts.full_name),
       headline  = COALESCE(excluded.headline,  contacts.headline)`,
  ).run(c.profileUrl, c.fullName ?? null, c.headline ?? null);
}

/** Nächste noch nicht kontaktierte Leads. */
export function nextNewContacts(limit: number): Contact[] {
  return db
    .prepare("SELECT * FROM contacts WHERE status = 'new' ORDER BY created_at LIMIT ?")
    .all(limit) as Contact[];
}

export function setStatus(profileUrl: string, status: string) {
  db.prepare("UPDATE contacts SET status = ? WHERE profile_url = ?").run(status, profileUrl);
}

/** Kontakt endgültig aus dem CRM entfernen. Rückgabe: true, wenn gelöscht. */
export function deleteContact(id: number): boolean {
  return db.prepare("DELETE FROM contacts WHERE id = ?").run(id).changes > 0;
}

/** Kontakte, die eingeladen wurden, aber noch nicht als angenommen markiert sind. */
export function invitedNotAccepted(): { profile_url: string }[] {
  return db
    .prepare("SELECT profile_url FROM contacts WHERE status='invited' AND accepted_at IS NULL")
    .all() as { profile_url: string }[];
}

/**
 * Markiert eine Vernetzung als angenommen: setzt accepted_at (Erkennungszeitpunkt)
 * und Status 'accepted'. Nur wirksam, solange noch nicht gesetzt (idempotent).
 * Rückgabe: true, wenn diese Annahme neu erfasst wurde.
 */
export function markAccepted(profileUrl: string): boolean {
  const res = db
    .prepare(
      "UPDATE contacts SET accepted_at=datetime('now'), status='accepted' WHERE profile_url = ? AND accepted_at IS NULL",
    )
    .run(profileUrl);
  return res.changes > 0;
}

export function countContacts(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number }).n;
}

/** Markiert einen gemessagten Kontakt als 'replied' (Hot Lead), matcht per Name. */
export function markRepliedByName(fullName: string): boolean {
  const res = db
    .prepare(
      "UPDATE contacts SET status='replied', replied_at=datetime('now') WHERE full_name = ? AND status='messaged'",
    )
    .run(fullName);
  return res.changes > 0;
}

/** Hot Leads: haben auf unsere Nachricht geantwortet. */
export function hotLeads(): Contact[] {
  return db
    .prepare("SELECT * FROM contacts WHERE status='replied' ORDER BY replied_at DESC")
    .all() as Contact[];
}

/**
 * Kontakte, die vor >= `days` Tagen angeschrieben wurden und NICHT geantwortet haben –
 * Kandidaten fürs Follow-up (max. `limit`).
 */
export function messagedAwaitingFollowup(days: number, limit: number): Contact[] {
  return db
    .prepare(
      `SELECT * FROM contacts
       WHERE status='messaged' AND messaged_at IS NOT NULL
         AND messaged_at <= datetime('now', ?)
       ORDER BY messaged_at LIMIT ?`,
    )
    .all(`-${days} days`, limit) as Contact[];
}

export function countByStatus(): Record<string, number> {
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM contacts GROUP BY status").all() as {
    status: string;
    n: number;
  }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
