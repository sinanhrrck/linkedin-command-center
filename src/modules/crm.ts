import { db } from "../db/index.js";

export type Contact = {
  id: number;
  profile_url: string;
  full_name?: string;
  headline?: string;
  status: string;
  notes?: string;
  /** azubi | student – steuert den Winkel der Erstnachricht. Sinan hat NICHT studiert. */
  zielgruppe?: string | null;
};

/** Kontakt anlegen oder ergänzen (kein Duplikat pro Profil-URL). */
export function upsertContact(c: { profileUrl: string; fullName?: string; headline?: string }) {
  // Zielgruppe direkt beim Anlegen bestimmen – sie entscheidet später den Winkel der
  // Erstnachricht (Azubi vs. Student). Aus der Headline, nicht aus der Quelle: eine Suche
  // liefert gemischte Ergebnisse, die Headline ist die Wahrheit über die Person.
  const zg = zielgruppeAusHeadline(c.headline);
  const { score, grund } = scoreLead(c.fullName, c.headline);
  db.prepare(
    `INSERT INTO contacts(profile_url, full_name, headline, zielgruppe, lead_score, score_grund)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(profile_url) DO UPDATE SET
       full_name   = COALESCE(excluded.full_name, contacts.full_name),
       headline    = COALESCE(excluded.headline,  contacts.headline),
       zielgruppe  = COALESCE(excluded.zielgruppe, contacts.zielgruppe),
       lead_score  = excluded.lead_score,
       score_grund = excluded.score_grund`,
  ).run(c.profileUrl, c.fullName ?? null, c.headline ?? null, zg, score, grund);
}

/** Nächste noch nicht kontaktierte Leads. */
/**
 * Die nächsten Leads zum Vernetzen – BESTE ZUERST. Bei begrenztem Tages-Cap (12-20) sollen
 * die knappen Anfragen an die Leads mit der höchsten ICP-Passung gehen, nicht an die ältesten.
 * Genau Sinans "Priorisierung, wer heute Aufmerksamkeit braucht".
 * Leads unter der Müll-Schwelle (SCORE_MIN) werden GAR NICHT angeschrieben – sie kosten sonst
 * Kontingent für nichts. `markSkippedLowScore` hat sie vorher auf 'skipped' gesetzt.
 */
export const SCORE_MIN = 25;

export function nextNewContacts(limit: number): Contact[] {
  return db
    .prepare(
      "SELECT * FROM contacts WHERE status = 'new' ORDER BY COALESCE(lead_score, 50) DESC, created_at LIMIT ?",
    )
    .all(limit) as Contact[];
}

/**
 * Sortiert schwache Leads aus, BEVOR sie Kontingent kosten: status 'new' → 'skipped', wenn der
 * Score unter SCORE_MIN liegt. Rein lesend auf der DB, kein Governor. Nachvollziehbar über
 * score_grund. Wird vor dem Outreach-Tick aufgerufen.
 */
export function markSkippedLowScore(): number {
  const r = db
    .prepare("UPDATE contacts SET status='skipped' WHERE status='new' AND lead_score IS NOT NULL AND lead_score < ?")
    .run(SCORE_MIN);
  return r.changes;
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
/**
 * Zielgruppe aus der Headline ableiten. Entscheidet den Winkel der Erstnachricht:
 * Sinan war Azubi, hat aber NICHT studiert – einem Studenten Studien-Erfahrung
 * vorzuspielen wäre gelogen (siehe context.ts ANGLE_STUDENT).
 *
 * Reihenfolge zählt: "dualer Student" ist beides, gilt aber als Azubi – dual Studierende
 * sind im Betrieb und leben faktisch die Azubi-Lebenslage, da passt Sinans Geschichte.
 */
/**
 * LEAD-SCORING aus Name + Headline (0-100). Bewusst OHNE Profilbesuch: jedes Profil einzeln
 * zu öffnen wären teure, rate-limitierte profileViews mit Ban-Risiko (siehe CLAUDE.md). Die
 * Headline ist das Maximum an gratis Signal – reicht für zwei Dinge, die das Zielbild fordert:
 * die knappen Tages-Anfragen auf die BESTEN Leads priorisieren und echten Müll aussortieren,
 * bevor er Kontingent kostet.
 *
 * Regelbasiert (kein KI-Call, läuft bei jedem Lead): Signale, die Sinans ICP treffen, geben
 * Punkte; Signale für schlechte Leads ziehen ab. Konservativ kalibriert – im Zweifel lieber
 * mittelmäßig einstufen als einen echten Azubi rauswerfen.
 */
export function scoreLead(name?: string | null, headline?: string | null): { score: number; grund: string } {
  const h = (headline ?? "").toLowerCase();
  if (!h) return { score: 30, grund: "keine Headline, wenig Anhaltspunkt" };

  let score = 50;
  const plus: string[] = [];
  const minus: string[] = [];

  // + Klarer kaufmännischer Ausbildungsberuf (genau Sinans ICP)
  if (/bankkauf|industriekauf|büromanagement|einzelhandel|groß.?\s?und\s?außenhandel|versicherungskauf|kauffrau|kaufmann|steuerfachang/i.test(h)) {
    score += 20; plus.push("klarer kaufm. Beruf");
  }
  // + Ausbildung/Lehre ausdrücklich genannt (in der Lebenslage, nicht schon fertig)
  if (/auszubild|ausbildung|azubi|lehrjahr|dual/i.test(h)) { score += 12; plus.push("in Ausbildung"); }
  // + Region in Sinans Nähe (laut Über mich: regionale Nähe hilft der Annahme)
  if (/heidelberg|mannheim|ludwigshafen|frankfurt|karlsruhe|speyer|worms|darmstadt|rhein.?neckar/i.test(h)) {
    score += 12; plus.push("Region nah");
  }
  // + Namhafter/seriöser Betrieb genannt = echtes Profil, kein Fake
  if (/sparkasse|volksbank|targobank|commerzbank|deutsche bank|bosch|basf|sap|dm |rewe|edeka|siemens|daimler|mercedes/i.test(h)) {
    score += 8; plus.push("seriöser Betrieb");
  }

  // − Sucht selbst einen Job → anderer Kontext, nicht Sinans Winkel ("was nach der Ausbildung")
  if (/open to work|#opentowork|auf (job|arbeits)?suche|suche (eine )?stelle|bewerbe mich/i.test(h)) {
    score -= 25; minus.push("sucht selbst Job");
  }
  // − Schon fertig / nicht mehr in der Ausbildungs-Lebenslage
  if (/ehemalig|ex-azubi|abgeschlossen|a\.d\.|ausgelernt|fertig mit/i.test(h)) { score -= 20; minus.push("schon fertig"); }
  // − Influencer/Content-Sprech → meist unpassend, oft Fake-Reichweite
  if (/content creator|influencer|coach|mindset|umsatz|\d+k follower|link in bio/i.test(h)) { score -= 20; minus.push("Influencer-Sprech"); }
  // − Emoji-Wüste (mehr als 4) → selten seriöses Azubi-Profil
  const emojis = (headline ?? "").match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu)?.length ?? 0;
  if (emojis > 4) { score -= 10; minus.push("Emoji-Wüste"); }

  score = Math.max(0, Math.min(100, score));
  const grund = [plus.length ? "+ " + plus.join(", ") : "", minus.length ? "− " + minus.join(", ") : ""]
    .filter(Boolean).join("  ") || "durchschnittlich";
  return { score, grund };
}

export function zielgruppeAusHeadline(headline?: string | null): "azubi" | "student" | null {
  const h = (headline ?? "").toLowerCase();
  if (!h) return null;
  if (/dual|azubi|auszubild|ausbildung|lehrjahr|lehrling/.test(h)) return "azubi";
  if (/student|studium|studier|bachelor|master|b\.?sc|m\.?sc/.test(h)) return "student";
  return null;
}

/**
 * Höfliche Absage: Person hat geantwortet, aber abgewunken ("hab schon einen Plan",
 * "danke der Nachfrage"). Status 'closed' statt 'replied' – damit taucht sie NICHT in den
 * Hot Leads auf. Vorher zählte jede Antwort als heißer Lead, auch ein klares Nein; das
 * verfälscht die Pipeline und Sinan würde die Falschen priorisieren.
 * `replied_at` wird trotzdem gesetzt: sie HAT geantwortet, das gehört in die Historie.
 */
export function markDeclinedByName(fullName: string): boolean {
  const res = db
    .prepare(
      "UPDATE contacts SET status='closed', replied_at=COALESCE(replied_at, datetime('now')) WHERE full_name = ? AND status IN ('messaged','replied')",
    )
    .run(fullName);
  return res.changes > 0;
}

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
