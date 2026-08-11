import { db } from "../db/index.js";
import { resolveContactIdentity } from "./contactIdentity.js";

export type CrmStage = "messaged" | "replied" | "qualified" | "meeting" | "won" | "lost" | "not_fit";
export type CrmSource = "backfill" | "bot" | "agent" | "manual";

const RANK: Record<CrmStage, number> = { messaged: 1, replied: 2, qualified: 3, meeting: 4, won: 5, lost: 5, not_fit: 5 };
const TERMINAL = new Set<CrmStage>(["won", "lost", "not_fit"]);
let backfillDone = false;

type ContactRef = { id: number; campaign_id: number | null; goal: string | null };

function contactById(contactId: number): ContactRef | undefined {
  return db.prepare(
    `SELECT c.id,c.campaign_id,COALESCE(c.goal_code_override,ca.goal_code) goal
       FROM contacts c LEFT JOIN campaigns ca ON ca.id=c.campaign_id WHERE c.id=?`,
  ).get(contactId) as ContactRef | undefined;
}

/** URL ist eindeutig; der Name ist nur ein vorsichtiger Fallback für alte Inbox-Daten. */
export function contactForConversation(threadUrl: string, participant = ""): ContactRef | undefined {
  const identity = resolveContactIdentity(threadUrl, participant, "crm_stage");
  if (!identity) return undefined;
  return db.prepare(
    `SELECT c.id,c.campaign_id,COALESCE(c.goal_code_override,ca.goal_code) goal
       FROM contacts c LEFT JOIN campaigns ca ON ca.id=c.campaign_id
      WHERE c.id=?`,
  ).get(identity.id) as ContactRef | undefined;
}

/**
 * Schreibt eine Stufe idempotent in die Historie und hält den aktuellen CRM-Stand vorwärts fest.
 * Gewonnen bleibt immer manuell; automatische Signale überschreiben nie einen Endstatus.
 */
export function recordCrmStage(contactId: number, stage: CrmStage, source: CrmSource, dedupeKey?: string): boolean {
  const contact = contactById(contactId);
  if (!contact) return false;
  const key = dedupeKey || `contact:${contactId}:${stage}`;
  const inserted = db.prepare(
    `INSERT OR IGNORE INTO crm_stage_events(dedupe_key,contact_id,goal_code,stage,source)
     VALUES(?,?,?,?,?)`,
  ).run(key, contactId, contact.goal, stage, source).changes > 0;
  // Altbestand war zunächst keinem Zielweg zugeordnet. Sobald B1/P1/AEC bekannt ist, dürfen
  // dessen belegte Stufen zugerechnet werden, ohne Ereignisse oder Kontakte neu anzulegen.
  if (contact.goal) db.prepare("UPDATE crm_stage_events SET goal_code=? WHERE contact_id=? AND goal_code IS NULL").run(contact.goal, contactId);

  if (["qualified", "meeting", "lost", "not_fit", "won"].includes(stage)) {
    const current = db.prepare("SELECT stage FROM sales_outcomes WHERE contact_id=?").get(contactId) as { stage: CrmStage } | undefined;
    const mayAdvance = !current || (!TERMINAL.has(current.stage) && RANK[stage] >= RANK[current.stage]);
    if (mayAdvance) db.prepare(
      `INSERT INTO sales_outcomes(contact_id,campaign_id,stage,updated_at) VALUES(?,?,?,datetime('now'))
       ON CONFLICT(contact_id) DO UPDATE SET campaign_id=excluded.campaign_id,stage=excluded.stage,updated_at=datetime('now')`,
    ).run(contactId, contact.campaign_id, stage);
  }
  return inserted;
}

export function recordConversationStage(threadUrl: string, participant: string, stage: CrmStage, source: CrmSource): boolean {
  const contact = contactForConversation(threadUrl, participant);
  return contact ? recordCrmStage(contact.id, stage, source) : false;
}

/** Bestehende Zeitstempel/Ergebnisse einmalig in die neue, anonymisierte Stufenhistorie übernehmen. */
export function backfillCrmStages(): void {
  if (backfillDone) return;
  const add = db.prepare(
    `INSERT OR IGNORE INTO crm_stage_events(dedupe_key,contact_id,goal_code,stage,source,created_at)
     VALUES(?,?,?,?,?,?)`,
  );
  const contacts = db.prepare(
    `SELECT c.id,c.messaged_at,c.replied_at,COALESCE(c.goal_code_override,ca.goal_code) goal
       FROM contacts c LEFT JOIN campaigns ca ON ca.id=c.campaign_id`,
  ).all() as Array<{ id: number; messaged_at: string | null; replied_at: string | null; goal: string | null }>;
  const tx = db.transaction(() => {
    for (const c of contacts) {
      if (c.messaged_at) add.run(`backfill:${c.id}:messaged`, c.id, c.goal, "messaged", "backfill", c.messaged_at);
      if (c.replied_at) add.run(`backfill:${c.id}:replied`, c.id, c.goal, "replied", "backfill", c.replied_at);
    }
    const outcomes = db.prepare("SELECT contact_id,stage,updated_at FROM sales_outcomes").all() as Array<{ contact_id: number; stage: CrmStage; updated_at: string }>;
    for (const o of outcomes) {
      const c = contactById(o.contact_id);
      if (c) add.run(`backfill:${o.contact_id}:${o.stage}`, o.contact_id, c.goal, o.stage, "backfill", o.updated_at);
    }
    try {
      const booked = db.prepare("SELECT thread_url,participant,updated_at FROM conversations WHERE status='booked'").all() as Array<{ thread_url: string; participant: string; updated_at: string }>;
      for (const row of booked) {
        const c = contactForConversation(row.thread_url, row.participant || "");
        if (c) {
          add.run(`backfill:conversation:${c.id}:meeting`, c.id, c.goal, "meeting", "backfill", row.updated_at);
          recordCrmStage(c.id, "meeting", "backfill", `backfill:conversation:${c.id}:meeting`);
        }
      }
      const agent = db.prepare("SELECT id,thread_url,teilnehmer,ergebnis,ts FROM agent_outcomes WHERE ergebnis IN ('gebucht','verloren')").all() as Array<{ id: number; thread_url: string; teilnehmer: string; ergebnis: string; ts: string }>;
      for (const row of agent) {
        const c = contactForConversation(row.thread_url, row.teilnehmer || "");
        if (c) {
          const stage = row.ergebnis === "gebucht" ? "meeting" : "lost";
          add.run(`backfill:agent:${row.id}`, c.id, c.goal, stage, "backfill", row.ts);
          recordCrmStage(c.id, stage, "backfill", `backfill:agent:${row.id}`);
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
