import { db } from "../db/index.js";
import { canonicalProfileUrl } from "../core/profileUrl.js";
import { proactiveDecision } from "./relationshipPolicy.js";
import { linkContactIdentity, resolveContactIdentity } from "./contactIdentity.js";
import { recordCrmStage, replyQualityFromIntent, type ReplyQuality } from "./crmStages.js";

export type Contact = {
  id: number;
  profile_url: string;
  full_name?: string;
  headline?: string;
  status: string;
  notes?: string;
  aus_netzwerk?: number | null;
  /** azubi | student – steuert den Winkel der Erstnachricht. Sinan hat NICHT studiert. */
  zielgruppe?: string | null;
  automation_status?: string | null;
  snoozed_until?: string | null;
  snooze_label?: string | null;
  snooze_reason?: string | null;
  do_not_contact?: number | null;
};

/** Kontakt anlegen oder ergänzen (kein Duplikat pro Profil-URL). */
export function upsertContact(c: { profileUrl: string; fullName?: string; headline?: string; sourceId?: number }) {
  const profileUrl = canonicalProfileUrl(c.profileUrl);
  // Zielgruppe direkt beim Anlegen bestimmen – sie entscheidet später den Winkel der
  // Erstnachricht (Azubi vs. Student). Aus der Headline, nicht aus der Quelle: eine Suche
  // liefert gemischte Ergebnisse, die Headline ist die Wahrheit über die Person.
  const zg = zielgruppeAusHeadline(c.headline);
  const { score, grund } = scoreLead(c.fullName, c.headline);
  // source_id nur beim ANLEGEN setzen (COALESCE): der erste Fund bestimmt die Quelle des
  // Kontakts – für den Quellen-Vergleich in der Analytics. Spätere Duplikate ändern sie nicht.
  const campaignId = c.sourceId
    ? (db.prepare("SELECT campaign_id FROM lead_sources WHERE id=?").get(c.sourceId) as { campaign_id: number | null } | undefined)?.campaign_id ?? null
    : null;
  db.prepare(
    `INSERT INTO contacts(profile_url, normalized_url, full_name, headline, zielgruppe, lead_score, score_grund, source_id, campaign_id)
     VALUES(?,?,?,?,?,?,?,?,?)
     -- Ohne Konfliktziel: Die produktive DB hat für normalized_url bewusst einen partiellen
     -- Unique-Index. SQLite akzeptiert dort ON CONFLICT(normalized_url) ohne dessen WHERE-Klausel
     -- nicht und brach dadurch den gesamten Lead-Import ab. Ziel-los greift der Upsert sowohl
     -- für die kanonische URL als auch für den älteren profile_url-Unique-Key korrekt.
     ON CONFLICT DO UPDATE SET
       full_name   = COALESCE(excluded.full_name, contacts.full_name),
       headline    = COALESCE(excluded.headline,  contacts.headline),
       zielgruppe  = COALESCE(excluded.zielgruppe, contacts.zielgruppe),
       lead_score  = excluded.lead_score,
       score_grund = excluded.score_grund,
       source_id   = COALESCE(contacts.source_id, excluded.source_id),
       campaign_id = COALESCE(contacts.campaign_id, excluded.campaign_id)`,
  ).run(profileUrl, profileUrl, c.fullName ?? null, c.headline ?? null, zg, score, grund, c.sourceId ?? null, campaignId);
  // Quellengebundene Aufträge nehmen ausschließlich die Kontakte auf, die über genau diese
  // Quelle gefunden wurden. Bestehende Kontakte werden beim Anlegen eines neuen Auftrags nicht
  // rückwirkend vereinnahmt; Duplikate bleiben durch INSERT OR IGNORE sicher.
  const row = db.prepare("SELECT id,status,accepted_at,aus_netzwerk,full_name FROM contacts WHERE normalized_url=?").get(profileUrl) as
    | { id: number; status: string; accepted_at: string | null; aus_netzwerk: number | null; full_name: string | null }
    | undefined;
  if (row) linkContactIdentity({ contactId: row.id, value: profileUrl, type: "profile_url", confidence: "confirmed", source: "contact_upsert", participant: row.full_name || "" });
  // Funnel-Eintritt. Der Dedupe-Schlüssel je Kontakt sorgt dafür, dass ein erneuter Fund über
  // dieselbe oder eine zweite Quelle den Kontakt NICHT ein zweites Mal als „gefunden“ zählt.
  if (row) {
    recordCrmStage(row.id, "found", "bot");
    if (score >= SCORE_MIN) recordCrmStage(row.id, "suitable", "bot");
  }
  if (campaignId) {
    if (row) {
      const connected = !!row.aus_netzwerk || !!row.accepted_at || ["accepted", "messaged", "replied"].includes(row.status);
      if (proactiveDecision(row.id, connected ? "campaign" : "connect").ok) {
        db.prepare("INSERT OR IGNORE INTO campaign_targets(campaign_id,contact_id,route,status) VALUES(?,?,?,?)")
          .run(campaignId, row.id, connected ? "network" : "external", connected ? "queued" : "awaiting_connection");
      }
    }
  }
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
      `SELECT *
       FROM contacts
       WHERE status = 'new'
         AND COALESCE(do_not_contact,0)=0
         AND COALESCE(automation_status,'active')='active'
         AND (snoozed_until IS NULL OR snoozed_until<=datetime('now'))
         AND (retry_after IS NULL OR retry_after <= datetime('now'))
       ORDER BY
         CASE WHEN EXISTS (
           SELECT 1
           FROM campaign_targets ct
           JOIN campaigns c ON c.id = ct.campaign_id
           WHERE ct.contact_id = contacts.id
             AND ct.status = 'awaiting_connection'
             AND c.active = 1
         ) THEN 0 ELSE 1 END,
         COALESCE(lead_score, 50) DESC,
         created_at
       LIMIT ?`,
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

/**
 * ATOMARER LEAD-ANSPRUCH gegen Doppel-Vernetzungen (auch bei zwei parallel laufenden Engines).
 * Setzt 'new' → 'inviting' und gibt NUR true zurück, wenn DIESER Aufruf den Lead geschnappt hat.
 * SQLite serialisiert das UPDATE → selbst wenn zwei Prozesse gleichzeitig zugreifen, gewinnt genau
 * einer (changes=1), der andere bekommt changes=0 und lässt den Lead in Ruhe. Das schließt die
 * Rennbedingung der reinen actions-Prüfung, weil hier NICHTS erst nach einem langsamen Klick passiert.
 */
export function claimForInvite(profileUrl: string): boolean {
  return db.prepare("UPDATE contacts SET status='inviting' WHERE profile_url=? AND status='new'").run(profileUrl).changes > 0;
}
/** Anspruch zurückgeben (Versand scheiterte/wurde übersprungen) → Lead wieder 'new', wird neu versucht. */
export function releaseInvite(profileUrl: string): void {
  db.prepare("UPDATE contacts SET status='new' WHERE profile_url=? AND status='inviting'").run(profileUrl);
}
/** Beim Engine-Start: hängengebliebene 'inviting' (Prozess starb mitten im Versand) wieder freigeben. */
export function resetHaengendeInvites(): number {
  return db.prepare("UPDATE contacts SET status='new' WHERE status='inviting'").run().changes;
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
  if (res.changes > 0) {
    const row = db.prepare("SELECT id FROM contacts WHERE profile_url=?").get(profileUrl) as { id: number } | undefined;
    if (row) recordCrmStage(row.id, "accepted", "bot");
  }
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

/**
 * Inbox-Antwort mit stabiler URL-Zuordnung; Namen dienen nur als eindeutiger Altbestands-Fallback.
 * Jede echte eingehende Nachricht zählt als Antwort – unabhängig davon, ob sie positiv ist.
 */
export function markInboundReply(threadUrl: string, fullName: string, declined = false): number | null {
  const contact = resolveContactIdentity(threadUrl, fullName, "inbound_reply");
  if (!contact) return null;
  db.prepare(
    `UPDATE contacts SET status=?, replied_at=COALESCE(replied_at,datetime('now')),
                         last_meaningful_contact_at=datetime('now')
      WHERE id=? AND status IN ('messaged','replied')`,
  ).run(declined ? "closed" : "replied", contact.id);
  // Die Antwort zählt genau einmal; die Einordnung darf sich später präzisieren. Ohne eigene
  // Einordnung gilt eine höflich abgelehnte Antwort als „nicht passend“, sonst als neutral.
  const memory = db.prepare("SELECT intent FROM conversation_memories WHERE contact_id=?").get(contact.id) as { intent: string } | undefined;
  const quality: ReplyQuality = memory ? replyQualityFromIntent(memory.intent) : declined ? "not_fit" : "neutral";
  recordCrmStage(contact.id, "replied", "bot", undefined, { quality });
  return contact.id;
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
/**
 * Kandidaten fürs Nachfassen – ZWEISTUFIG.
 *  - Stufe 1: angeschrieben, keine Antwort, noch kein Follow-up → nach `days` Tagen fällig.
 *  - Stufe 2: genau EIN Follow-up ist raus, immer noch keine Antwort → erst nach `days2`
 *    Tagen fällig (längerer Abstand, damit es nicht drängend wirkt).
 * Wer schon zwei Follow-ups hat oder noch einen offenen Entwurf, fällt raus.
 * `messaged_at` wird beim Senden aktualisiert, ist also immer "letzter Kontakt".
 */
export function messagedAwaitingFollowup(days: number, limit: number, days2 = 7): Contact[] {
  const gesendetOderOffen = "status IN ('pending','approved','sent')";
  return db
    .prepare(
      `SELECT c.* FROM contacts c
       WHERE c.status='messaged' AND c.messaged_at IS NOT NULL
         AND COALESCE(c.do_not_contact,0)=0
         AND COALESCE(c.automation_status,'active')='active'
         AND (c.snoozed_until IS NULL OR c.snoozed_until<=datetime('now'))
         AND NOT EXISTS (
           SELECT 1 FROM drafts d WHERE d.thread_url = c.profile_url
             AND d.kind='followup' AND d.status IN ('pending','approved','discarded')
         )
         AND (
           (  (SELECT COUNT(*) FROM drafts d WHERE d.thread_url = c.profile_url AND d.kind='followup' AND d.${gesendetOderOffen}) = 0
              AND c.messaged_at <= datetime('now', ?) )
           OR
           (  (SELECT COUNT(*) FROM drafts d WHERE d.thread_url = c.profile_url AND d.kind='followup' AND d.${gesendetOderOffen}) = 1
              AND c.messaged_at <= datetime('now', ?) )
         )
       ORDER BY c.messaged_at LIMIT ?`,
    )
    .all(`-${days} days`, `-${days2} days`, limit) as Contact[];
}

export function countByStatus(): Record<string, number> {
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM contacts GROUP BY status").all() as {
    status: string;
    n: number;
  }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
