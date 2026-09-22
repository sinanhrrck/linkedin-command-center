import { db } from "../db/index.js";
import { getUnifiedContactTimeline } from "./contactTimeline.js";
import { getConversationMemory } from "./conversationMemory.js";
import { listContactNotes } from "./contactNotes.js";
import { FUNNEL_STAGES, MANUELLE_STUFEN } from "./crmStages.js";

/** Eine gemeinsame Arbeitsansicht pro Person. Sie verwendet ausschließlich die zentrale
 * Kontakt-ID; Namen dienen hier nicht mehr als versteckter Join zwischen getrennten Tabellen. */
export function getConversationWorkspace(contactId: number) {
  if (!Number.isInteger(contactId) || contactId <= 0) throw new Error("Kontakt fehlt.");
  const contact = db.prepare(
    `SELECT c.id,c.full_name,c.headline,c.profile_url,c.status,c.messaged_at,c.replied_at,
            c.automation_status,c.snoozed_until,c.snooze_label,c.snooze_reason,c.do_not_contact,
            ca.name AS campaign_name,o.stage AS outcome_stage,o.note AS outcome_note
       FROM contacts c
       LEFT JOIN campaigns ca ON ca.id=c.campaign_id
       LEFT JOIN sales_outcomes o ON o.contact_id=c.id
      WHERE c.id=?`,
  ).get(contactId) as Record<string, string | number | null> | undefined;
  if (!contact) throw new Error("Kontakt nicht gefunden.");

  const identities = db.prepare(
    `SELECT identity_type,identity_value,confidence,source,last_seen_at
       FROM contact_identities WHERE contact_id=?
       ORDER BY CASE identity_type WHEN 'profile_url' THEN 0 WHEN 'thread_url' THEN 1 ELSE 2 END,last_seen_at DESC`,
  ).all(contactId);
  const threadCount = (identities as Array<{ identity_type: string }>).filter((row) => row.identity_type === "thread_url").length;

  const allConflicts = db.prepare(
    `SELECT id,identity_type,identity_value,participant,candidate_contact_ids,reason,created_at
       FROM contact_identity_conflicts WHERE status='open' ORDER BY created_at DESC`,
  ).all() as Array<{ id: number; identity_type: string; identity_value: string; participant: string | null; candidate_contact_ids: string | null; reason: string; created_at: string }>;
  const conflicts = allConflicts.filter((row) => {
    try { return (JSON.parse(row.candidate_contact_ids || "[]") as number[]).includes(contactId); }
    catch { return false; }
  });

  const tasks = db.prepare(
    "SELECT id,title,due_at,status FROM sales_tasks WHERE contact_id=? ORDER BY status,COALESCE(due_at,'9999-12-31'),created_at",
  ).all(contactId);

  // Erreichte Stufen kommen AUSSCHLIESSLICH aus crm_stage_events – der einzigen Wahrheit für
  // Funnel-Zahlen. Hier wird nur gelesen, nie aus contacts.* rekonstruiert.
  const erreichteStufen = db.prepare(
    "SELECT stage, MIN(occurred_at) AS seit, source FROM crm_stage_events WHERE contact_id=? GROUP BY stage",
  ).all(contactId) as Array<{ stage: string; seit: string; source: string }>;

  return {
    contact,
    memory: getConversationMemory(contactId),
    timeline: getUnifiedContactTimeline(contactId),
    notes: listContactNotes(contactId),
    stufen: {
      alle: FUNNEL_STAGES,
      erreicht: erreichteStufen,
      manuell: MANUELLE_STUFEN,
      aktuell: (contact.outcome_stage as string | null) || null,
    },
    tasks,
    identities,
    conflicts,
    threadCount,
    identityState: conflicts.length ? "needs_review" : threadCount ? "linked" : "profile_only",
  };
}
