import { db } from "../db/index.js";
import { resolveContactIdentity } from "./contactIdentity.js";

/**
 * Die vollständige Funnel-Kette. Sie ist bewusst EIN Vokabular für alle Auswertungen: gefunden →
 * geeignet → eingeladen → angenommen → angeschrieben → geantwortet → qualifiziert → Termin →
 * Ergebnis. Vorher lagen die vorderen Stufen nur als Zeitstempel auf `contacts` und die hinteren
 * als Ereignisse — zwei Wahrheiten, die sich nicht fair gegeneinander rechnen ließen.
 */
export const FUNNEL_STAGES = [
  "found", "suitable", "invited", "accepted", "messaged", "replied", "qualified", "meeting", "won", "lost", "not_fit",
] as const;
export type CrmStage = (typeof FUNNEL_STAGES)[number];
export type CrmSource = "backfill" | "bot" | "agent" | "manual";

/**
 * Einordnung einer eingegangenen Antwort. Eine Antwort allein ist kein Erfolg; erst die Richtung
 * macht sie auswertbar. `neutral` ist bewusst enthalten, damit JEDE Antwort eine Einordnung hat
 * und die Summe der Qualitäten nie kleiner ist als die Zahl der Antworten.
 */
export const REPLY_QUALITIES = [
  "interested", "question", "meeting", "later", "busy", "not_fit", "not_interested", "neutral",
] as const;
export type ReplyQuality = (typeof REPLY_QUALITIES)[number];
/** Positiv = das Gespräch geht weiter oder ist gewonnen. Grundlage der positiven Antwortquote. */
export const POSITIVE_QUALITIES: ReadonlySet<ReplyQuality> = new Set<ReplyQuality>(["interested", "question", "meeting"]);

const RANK: Record<string, number> = { messaged: 1, replied: 2, qualified: 3, meeting: 4, won: 5, lost: 5, not_fit: 5 };
const TERMINAL = new Set<string>(["won", "lost", "not_fit"]);
/** Nur diese Stufen sind ein vertriebliches Ergebnis und dürfen `sales_outcomes` fortschreiben. */
const OUTCOME_STAGES = new Set<CrmStage>(["qualified", "meeting", "won", "lost", "not_fit"]);
let backfillDone = false;

type ContactRef = { id: number; campaign_id: number | null; source_id: number | null; goal: string | null };

const CONTACT_REF_SQL =
  `SELECT c.id,c.campaign_id,c.source_id,COALESCE(c.goal_code_override,ca.goal_code) goal
     FROM contacts c LEFT JOIN campaigns ca ON ca.id=c.campaign_id WHERE c.id=?`;

function contactById(contactId: number): ContactRef | undefined {
  return db.prepare(CONTACT_REF_SQL).get(contactId) as ContactRef | undefined;
}

/** URL ist eindeutig; der Name ist nur ein vorsichtiger Fallback für alte Inbox-Daten. */
export function contactForConversation(threadUrl: string, participant = ""): ContactRef | undefined {
  const identity = resolveContactIdentity(threadUrl, participant, "crm_stage");
  if (!identity) return undefined;
  return db.prepare(CONTACT_REF_SQL).get(identity.id) as ContactRef | undefined;
}

/**
 * Schreibt eine Stufe idempotent in die Historie und hält den aktuellen CRM-Stand vorwärts fest.
 * Gewonnen bleibt immer manuell; automatische Signale überschreiben nie einen Endstatus.
 */
export function recordCrmStage(
  contactId: number,
  stage: CrmStage,
  source: CrmSource,
  dedupeKey?: string,
  options: { quality?: ReplyQuality | null; occurredAt?: string | null } = {},
): boolean {
  const contact = contactById(contactId);
  if (!contact) return false;
  // Ein Ereignis je Kontakt und Stufe. Der Schlüssel ist fachlich, nicht zeitlich: ein Neustart
  // oder ein zweiter Lauf schreibt exakt denselben Schlüssel und wird deshalb ignoriert, statt
  // die Zahlen ein zweites Mal zu erhöhen.
  const key = dedupeKey || `contact:${contactId}:${stage}`;
  const quality = options.quality && REPLY_QUALITIES.includes(options.quality) ? options.quality : null;
  const inserted = db.prepare(
    `INSERT OR IGNORE INTO crm_stage_events
       (dedupe_key,contact_id,goal_code,stage,source,campaign_id,source_id,reply_quality,occurred_at)
     VALUES(?,?,?,?,?,?,?,?,COALESCE(?,datetime('now')))`,
  ).run(key, contactId, contact.goal, stage, source, contact.campaign_id, contact.source_id, quality, options.occurredAt ?? null).changes > 0;
  // Altbestand war zunächst keinem Zielweg zugeordnet. Sobald B1/P1/AEC bekannt ist, dürfen
  // dessen belegte Stufen zugerechnet werden, ohne Ereignisse oder Kontakte neu anzulegen.
  if (contact.goal) db.prepare("UPDATE crm_stage_events SET goal_code=? WHERE contact_id=? AND goal_code IS NULL").run(contact.goal, contactId);
  // Dasselbe gilt für die Herkunft: Sie wird nur NACHGETRAGEN, wo sie fehlt, und nie geändert.
  // Eine einmal belegte Zuordnung bleibt stehen, damit Auswertungen reproduzierbar sind.
  if (contact.campaign_id) db.prepare("UPDATE crm_stage_events SET campaign_id=? WHERE contact_id=? AND campaign_id IS NULL").run(contact.campaign_id, contactId);
  if (contact.source_id) db.prepare("UPDATE crm_stage_events SET source_id=? WHERE contact_id=? AND source_id IS NULL").run(contact.source_id, contactId);
  // Die Einordnung einer Antwort kann sich präzisieren (erst „neutral“, dann erkennbar „später“).
  // Das ist eine Korrektur derselben Antwort, kein zweites Ereignis — deshalb UPDATE statt INSERT.
  if (quality && stage === "replied" && !inserted) {
    db.prepare("UPDATE crm_stage_events SET reply_quality=? WHERE dedupe_key=?").run(quality, key);
  }

  if (OUTCOME_STAGES.has(stage)) {
    const current = db.prepare("SELECT stage FROM sales_outcomes WHERE contact_id=?").get(contactId) as { stage: CrmStage } | undefined;
    const mayAdvance = !current || (!TERMINAL.has(current.stage) && RANK[stage] >= RANK[current.stage]);
    if (mayAdvance) db.prepare(
      `INSERT INTO sales_outcomes(contact_id,campaign_id,stage,updated_at) VALUES(?,?,?,datetime('now'))
       ON CONFLICT(contact_id) DO UPDATE SET campaign_id=excluded.campaign_id,stage=excluded.stage,updated_at=datetime('now')`,
    ).run(contactId, contact.campaign_id, stage);
  }
  return inserted;
}

/**
 * Stufen, die ein MENSCH beurteilt und deshalb im Cockpit setzbar sind. Bewusst NICHT dabei:
 * found/suitable/invited/accepted/messaged/replied. Das sind beobachtete Tatsachen des Bots
 * (eine Einladung ging raus oder nicht) – wären sie von Hand setzbar, liessen sich Annahme- und
 * Antwortquote per Klick schönen und die Auswertung wäre wertlos. Was hier steht, ist genau die
 * Einschätzung, die kein Automat treffen kann: passt der Kontakt, steht ein Termin, ist es
 * gewonnen oder verloren.
 */
export const MANUELLE_STUFEN: readonly CrmStage[] = ["qualified", "meeting", "won", "lost", "not_fit"] as const;

/** Stufen, die NIE von Hand entstehen dürfen: sie kosteten eine echte Einladung (Regel 3). */
const NIE_MANUELL = new Set<CrmStage>(["invited", "accepted"]);

/**
 * Setzt eine Vertriebsstufe von Hand. Schreibt über denselben Weg wie der Bot (`recordCrmStage`,
 * Quelle `manual`), damit der fachliche Dedupe-Schlüssel, das Einfrieren der Zuordnung und die
 * Fortschreibung von `sales_outcomes` unverändert gelten. Rückwärts geht es bewusst nicht:
 * `recordCrmStage` lässt `sales_outcomes` nur vorwärts laufen und nie aus einem Endstatus heraus.
 */
export function setStageManually(contactId: number, stage: CrmStage): { ok: boolean; grund?: string } {
  if (!Number.isInteger(contactId) || contactId <= 0) return { ok: false, grund: "Bitte wähle einen Kontakt." };
  if (!FUNNEL_STAGES.includes(stage)) return { ok: false, grund: "Unbekannte Stufe." };
  if (NIE_MANUELL.has(stage)) return { ok: false, grund: "Einladung und Annahme belegt nur der Bot – sonst stimmt die Annahmequote nicht mehr." };
  if (!MANUELLE_STUFEN.includes(stage)) return { ok: false, grund: "Diese Stufe entsteht aus dem Gesprächsverlauf und ist nicht von Hand setzbar." };
  if (!contactById(contactId)) return { ok: false, grund: "Kontakt nicht gefunden." };
  recordCrmStage(contactId, stage, "manual");
  return { ok: true };
}

export function recordConversationStage(
  threadUrl: string,
  participant: string,
  stage: CrmStage,
  source: CrmSource,
  quality?: ReplyQuality | null,
): boolean {
  const contact = contactForConversation(threadUrl, participant);
  return contact ? recordCrmStage(contact.id, stage, source, undefined, { quality }) : false;
}

/**
 * Übersetzt die Gesprächseinordnung in eine Antwortqualität. `do_not_contact` ist fachlich die
 * schärfste Form von „kein Interesse“ und wird bewusst dorthin abgebildet, damit die positive
 * Antwortquote keine eigene Sonderkategorie braucht.
 */
export function replyQualityFromIntent(intent: string | null | undefined): ReplyQuality {
  if (intent === "do_not_contact") return "not_interested";
  return REPLY_QUALITIES.includes(intent as ReplyQuality) ? (intent as ReplyQuality) : "neutral";
}

/** Bestehende Zeitstempel/Ergebnisse einmalig in die neue, anonymisierte Stufenhistorie übernehmen. */
export function backfillCrmStages(): void {
  if (backfillDone) return;
  // WHERE NOT EXISTS: Hat der Live-Pfad (`contact:<id>:<stufe>`) die Stufe schon protokolliert,
  // darf die Übernahme KEINE zweite Zeile anlegen. Vorher entstand je Versand ein Doppel
  // (contact:… + backfill:…), das die Funnel-Zählung nur dank DISTINCT nicht verfälschte
  // und den Tagesbericht verdoppelte (2026-09-22). Regel 1 aus CLAUDE.md: ein Ereignis zählt einmal.
  const add = db.prepare(
    `INSERT OR IGNORE INTO crm_stage_events
       (dedupe_key,contact_id,goal_code,stage,source,created_at,campaign_id,source_id,occurred_at,reply_quality)
     SELECT ?,?,?,?,?,?,?,?,?,?
      WHERE NOT EXISTS (SELECT 1 FROM crm_stage_events x WHERE x.contact_id=? AND x.stage=?)`,
  );
  const contacts = db.prepare(
    `SELECT c.id,c.created_at,c.invited_at,c.accepted_at,c.messaged_at,c.replied_at,c.status,
            c.campaign_id,c.source_id,COALESCE(c.aus_netzwerk,0) aus_netzwerk,
            COALESCE(c.goal_code_override,ca.goal_code) goal, m.intent
       FROM contacts c
       LEFT JOIN campaigns ca ON ca.id=c.campaign_id
       LEFT JOIN conversation_memories m ON m.contact_id=c.id`,
  ).all() as Array<{
    id: number; created_at: string | null; invited_at: string | null; accepted_at: string | null;
    messaged_at: string | null; replied_at: string | null; status: string; campaign_id: number | null;
    source_id: number | null; aus_netzwerk: number; goal: string | null; intent: string | null;
  }>;
  const tx = db.transaction(() => {
    for (const c of contacts) {
      const at = (key: string, stage: CrmStage, when: string | null, quality: ReplyQuality | null = null) => {
        if (when) add.run(`backfill:${c.id}:${key}`, c.id, c.goal, stage, "backfill", when, c.campaign_id, c.source_id, when, quality, c.id, stage);
      };
      // „Gefunden“ ist der Eintritt in den Datenbestand; „geeignet“ heißt: nicht als zu schwach
      // aussortiert. Beides ist aus dem Altbestand belegbar, ohne irgendetwas zu schätzen.
      at("found", "found", c.created_at);
      if (c.status !== "skipped") at("suitable", "suitable", c.created_at);
      // Bestehende Verbindungen (`aus_netzwerk`) haben nie eine Anfrage gekostet. Sie als
      // „eingeladen+angenommen“ zu zählen würde die Annahmequote künstlich nach oben ziehen.
      if (!c.aus_netzwerk) {
        at("invited", "invited", c.invited_at);
        at("accepted", "accepted", c.accepted_at);
      }
      at("messaged", "messaged", c.messaged_at);
      at("replied", "replied", c.replied_at, c.replied_at ? replyQualityFromIntent(c.intent) : null);
    }
    const outcomes = db.prepare("SELECT contact_id,stage,updated_at FROM sales_outcomes").all() as Array<{ contact_id: number; stage: CrmStage; updated_at: string }>;
    for (const o of outcomes) {
      const c = contactById(o.contact_id);
      if (c) add.run(`backfill:${o.contact_id}:${o.stage}`, o.contact_id, c.goal, o.stage, "backfill", o.updated_at, c.campaign_id, c.source_id, o.updated_at, null, o.contact_id, o.stage);
    }
    try {
      const booked = db.prepare("SELECT thread_url,participant,updated_at FROM conversations WHERE status='booked'").all() as Array<{ thread_url: string; participant: string; updated_at: string }>;
      for (const row of booked) {
        const c = contactForConversation(row.thread_url, row.participant || "");
        if (c) {
          add.run(`backfill:conversation:${c.id}:meeting`, c.id, c.goal, "meeting", "backfill", row.updated_at, c.campaign_id, c.source_id, row.updated_at, null, c.id, "meeting");
          recordCrmStage(c.id, "meeting", "backfill", `backfill:conversation:${c.id}:meeting`, { occurredAt: row.updated_at });
        }
      }
      const agent = db.prepare("SELECT id,thread_url,teilnehmer,ergebnis,ts FROM agent_outcomes WHERE ergebnis IN ('gebucht','verloren')").all() as Array<{ id: number; thread_url: string; teilnehmer: string; ergebnis: string; ts: string }>;
      for (const row of agent) {
        const c = contactForConversation(row.thread_url, row.teilnehmer || "");
        if (c) {
          const stage: CrmStage = row.ergebnis === "gebucht" ? "meeting" : "lost";
          add.run(`backfill:agent:${row.id}`, c.id, c.goal, stage, "backfill", row.ts, c.campaign_id, c.source_id, row.ts, null, c.id, stage);
          recordCrmStage(c.id, stage, "backfill", `backfill:agent:${row.id}`, { occurredAt: row.ts });
        }
      }
    } catch { /* Agent-Tabellen existieren in älteren Installationen eventuell noch nicht. */ }
  });
  tx();
  backfillDone = true;
}

export function goalFunnelEconomics() {
  backfillCrmStages();
  const rows = db.prepare(
    `WITH goals(goal) AS (VALUES ('B1'),('P1'),('AEC')),
      stages AS (
        SELECT goal_code goal,
          COUNT(DISTINCT CASE WHEN stage='messaged' THEN contact_id END) messaged,
          COUNT(DISTINCT CASE WHEN stage='replied' THEN contact_id END) replied,
          COUNT(DISTINCT CASE WHEN stage='qualified' THEN contact_id END) qualified,
          COUNT(DISTINCT CASE WHEN stage='meeting' THEN contact_id END) meeting,
          COUNT(DISTINCT CASE WHEN stage='won' THEN contact_id END) won
        FROM crm_stage_events GROUP BY goal_code
      ), values_won AS (
        SELECT COALESCE(c.goal_code_override,ca.goal_code) goal, SUM(COALESCE(o.value_cents,0)) value_cents
          FROM sales_outcomes o JOIN contacts c ON c.id=o.contact_id LEFT JOIN campaigns ca ON ca.id=c.campaign_id
         WHERE o.stage='won' GROUP BY goal
      )
      SELECT g.goal,COALESCE(s.messaged,0) messaged,COALESCE(s.replied,0) replied,
             COALESCE(s.qualified,0) qualified,COALESCE(s.meeting,0) meeting,COALESCE(s.won,0) won,
             COALESCE(v.value_cents,0) won_value_cents
        FROM goals g LEFT JOIN stages s ON s.goal=g.goal LEFT JOIN values_won v ON v.goal=g.goal
       ORDER BY CASE g.goal WHEN 'B1' THEN 1 WHEN 'P1' THEN 2 ELSE 3 END`,
  ).all() as Array<{ goal: string; messaged: number; replied: number; qualified: number; meeting: number; won: number; won_value_cents: number }>;
  const rate = (a: number, b: number) => b ? Math.round(a / b * 1000) / 10 : null;
  return rows.map((r) => ({ ...r,
    rates: { reply: rate(r.replied, r.messaged), qualified: rate(r.qualified, r.replied), meeting: rate(r.meeting, r.qualified), won: rate(r.won, r.meeting) },
    conversionPct: rate(r.won, r.messaged), averageValueEur: r.won ? Math.round(r.won_value_cents / r.won / 100) : null,
  }));
}

export function crmDataQuality() {
  const r = db.prepare(
    `SELECT COUNT(DISTINCT CASE WHEN stage='messaged' THEN contact_id END) messaged,
            COUNT(DISTINCT CASE WHEN stage='messaged' AND goal_code IN ('B1','P1','AEC') THEN contact_id END) assigned,
            SUM(CASE WHEN source='manual' THEN 1 ELSE 0 END) manual,
            SUM(CASE WHEN source IN ('bot','agent') THEN 1 ELSE 0 END) automatic
       FROM crm_stage_events`,
  ).get() as { messaged: number; assigned: number; manual: number | null; automatic: number | null };
  return { ...r, manual: r.manual || 0, automatic: r.automatic || 0, coveragePct: r.messaged ? Math.round(r.assigned / r.messaged * 100) : 0 };
}
