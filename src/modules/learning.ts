import { createHash } from "node:crypto";
import { db } from "../db/index.js";
import { config } from "../config.js";

export type LearningGoal = "B1" | "P1" | "AEC" | null;
export type LearningRule = {
  code: string;
  title: string;
  instruction: string;
  evidence: number;
  goalCode: LearningGoal;
};

type DraftLearningRow = {
  id: number;
  kind: string;
  thread_url: string;
  participant: string | null;
  draft: string;
  ki_original: string | null;
  intent: string | null;
  rejection_reason: string | null;
};

let historyBackfilled = false;

const norm = (value: string | null | undefined) => String(value || "").replace(/\s+/g, " ").trim();
const words = (value: string | null | undefined) => norm(value).toLocaleLowerCase("de-DE").split(/\s+/).filter(Boolean);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function style(text: string) {
  const clean = norm(text);
  const lengthBucket = clean.length <= 180 ? "short" : clean.length <= 350 ? "medium" : "long";
  const hasQuestion = clean.includes("?") ? 1 : 0;
  const hasCta = /telefon|anruf|nummer|termin|call|kurz reden|austausch|kennenlern/i.test(clean) ? 1 : 0;
  return { lengthBucket, hasQuestion, hasCta };
}

export function classifyChange(original: string | null | undefined, finalText: string): string {
  const a = words(original), b = words(finalText);
  if (norm(original) === norm(finalText)) return "unchanged";
  if (!a.length) return "written_by_user";
  const source = new Set(a);
  const overlap = b.length ? b.filter((word) => source.has(word)).length / b.length : 0;
  if (overlap < 0.3) return "rewritten";
  if (b.length < a.length * 0.7) return "shorter";
  if (b.length > a.length * 1.4) return "longer";
  if (norm(original).includes("?") && !norm(finalText).includes("?")) return "question_removed";
  if (!norm(original).includes("?") && norm(finalText).includes("?")) return "question_added";
  return "tone_changed";
}

function goalForThread(threadUrl: string, participant = ""): LearningGoal {
  const row = db.prepare(
    `SELECT COALESCE(c.goal_code_override,ca.goal_code) goal
       FROM contacts c LEFT JOIN campaigns ca ON ca.id=c.campaign_id
      WHERE c.profile_url=? OR lower(trim(c.full_name))=lower(trim(?))
      ORDER BY CASE WHEN c.profile_url=? THEN 0 ELSE 1 END LIMIT 1`,
  ).get(threadUrl, participant, threadUrl) as { goal: string | null } | undefined;
  return row?.goal === "B1" || row?.goal === "P1" || row?.goal === "AEC" ? row.goal : null;
}

function insertEvent(input: {
  dedupeKey: string;
  eventType: string;
  goalCode: LearningGoal;
  draftKind?: string | null;
  intent?: string | null;
  changeKey?: string | null;
  reasonKey?: string | null;
  text?: string;
  outcome?: string | null;
}) {
  const features = style(input.text || "");
  db.prepare(
    `INSERT OR IGNORE INTO learning_events
      (dedupe_key,event_type,goal_code,draft_kind,intent,change_key,reason_key,length_bucket,has_question,has_cta,outcome)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(input.dedupeKey, input.eventType, input.goalCode, input.draftKind ?? null, input.intent ?? null,
    input.changeKey ?? null, input.reasonKey ?? null, input.text ? features.lengthBucket : null,
    input.text ? features.hasQuestion : null, input.text ? features.hasCta : null, input.outcome ?? null);
}

export function learnFromDraft(draftId: number, eventType: "approved" | "rejected" | "sent", reasonKey?: string) {
  const draft = db.prepare(
    "SELECT id,kind,thread_url,participant,draft,ki_original,intent,rejection_reason FROM drafts WHERE id=?",
  ).get(draftId) as DraftLearningRow | undefined;
  if (!draft) return;
  const allowedReason = ["different_approach", "artificial", "too_personal", "too_salesy", "custom"].includes(String(reasonKey))
    ? String(reasonKey) : null;
  insertEvent({
    dedupeKey: `${eventType}:draft:${draft.id}`,
    eventType,
    goalCode: goalForThread(draft.thread_url, draft.participant || ""),
    draftKind: draft.kind,
    intent: draft.intent,
    changeKey: eventType === "approved" || eventType === "sent" ? classifyChange(draft.ki_original, draft.draft) : null,
    reasonKey: eventType === "rejected" ? allowedReason : null,
    text: draft.draft,
  });
}

export function learnFromReply(threadUrl: string, participant: string, incoming: string, intent: string) {
  const sent = db.prepare(
    "SELECT id,kind,draft,ki_original,intent FROM drafts WHERE thread_url=? AND status='sent' ORDER BY sent_at DESC,id DESC LIMIT 1",
  ).get(threadUrl) as { id: number; kind: string; draft: string; ki_original: string | null; intent: string | null } | undefined;
  if (!sent) return;
  insertEvent({
    dedupeKey: `reply:${hash(`${threadUrl}\n${incoming}`)}`,
    eventType: "reply",
    goalCode: goalForThread(threadUrl, participant),
    draftKind: sent.kind,
    intent: intent || sent.intent,
    changeKey: classifyChange(sent.ki_original, sent.draft),
    text: sent.draft,
    outcome: intent === "absage" ? "negative" : ["meeting", "chance", "positive"].includes(intent) ? "positive" : "neutral",
  });
}

export function learnFromOutcome(contactId: number, outcome: string) {
  const contact = db.prepare("SELECT profile_url,full_name FROM contacts WHERE id=?").get(contactId) as
    | { profile_url: string; full_name: string | null }
    | undefined;
  if (!contact) return;
  const sent = db.prepare(
    "SELECT id,kind,draft,ki_original,intent FROM drafts WHERE thread_url=? AND status='sent' ORDER BY sent_at DESC,id DESC LIMIT 1",
  ).get(contact.profile_url) as { id: number; kind: string; draft: string; ki_original: string | null; intent: string | null } | undefined;
  insertEvent({
    dedupeKey: `outcome:${contactId}:${outcome}`,
    eventType: "outcome",
    goalCode: goalForThread(contact.profile_url, contact.full_name || ""),
    draftKind: sent?.kind,
    intent: sent?.intent,
    changeKey: sent ? classifyChange(sent.ki_original, sent.draft) : null,
    text: sent?.draft,
    outcome,
  });
}

/**
 * Nutzt die bereits vorhandene Freigabe-/Ablehnungs-/Ergebnis-Historie als Startwissen.
 * Durch die dedupe_keys ist der Lauf beliebig oft sicher; im Prozess wird er trotzdem nur
 * einmal ausgeführt. Auch beim Rückblick landen ausschließlich abstrakte Merkmale in der
 * Lerntabelle, nie die gelesenen Texte, Namen oder Profil-URLs.
 */
export function backfillLearningHistory() {
  if (historyBackfilled) return;
  historyBackfilled = true;
  const drafts = db.prepare(
    `SELECT id,status,rejection_reason FROM drafts
      WHERE status IN ('approved','sent','discarded')`,
  ).all() as { id: number; status: string; rejection_reason: string | null }[];
  for (const draft of drafts) {
    if (draft.status === "sent") learnFromDraft(draft.id, "sent");
    else if (draft.status === "approved") learnFromDraft(draft.id, "approved");
    else if (draft.rejection_reason) learnFromDraft(draft.id, "rejected", draft.rejection_reason);
  }
  const outcomes = db.prepare("SELECT contact_id,stage FROM sales_outcomes").all() as { contact_id: number; stage: string }[];
  for (const outcome of outcomes) learnFromOutcome(outcome.contact_id, outcome.stage);
}

type CountRow = { goal_code: string | null; key: string; n: number };

export function learningRules(goalCode?: LearningGoal): LearningRule[] {
  backfillLearningHistory();
  const params: unknown[] = [];
  const where = goalCode ? "AND goal_code=?" : "";
  if (goalCode) params.push(goalCode);
  const selectedGoal = goalCode ? "goal_code" : "NULL";
  const groupedGoal = goalCode ? "goal_code," : "";
  const reasons = db.prepare(
    `SELECT ${selectedGoal} goal_code,reason_key key,COUNT(*) n FROM learning_events
      WHERE event_type='rejected' AND reason_key IS NOT NULL ${where} GROUP BY ${groupedGoal}reason_key`,
  ).all(...params) as CountRow[];
  const changes = db.prepare(
    `SELECT ${selectedGoal} goal_code,change_key key,COUNT(*) n FROM learning_events
      WHERE event_type='approved' AND change_key NOT IN ('unchanged','written_by_user') ${where}
      GROUP BY ${groupedGoal}change_key`,
  ).all(...params) as CountRow[];
  const rules: LearningRule[] = [];
  const add = (row: CountRow, code: string, title: string, instruction: string) => {
    if (row.n >= 2) rules.push({ code, title, instruction, evidence: row.n, goalCode: row.goal_code as LearningGoal });
  };
  for (const row of reasons) {
    if (row.key === "too_salesy") add(row, "less_salesy", "Weniger verkäuferisch", "Kein Pitch, keine Nutzenbehauptung und kein Druck, bevor die Person selbst einen Bedarf zeigt.");
    if (row.key === "artificial") add(row, "more_natural", "Natürlicher schreiben", "Schreibe gesprochener, einfacher und weniger glatt. Vermeide typische KI-Floskeln.");
    if (row.key === "too_personal") add(row, "less_personal", "Mehr Abstand halten", "Bleib bei beruflichen und von der Person selbst geöffneten Themen. Keine privaten Annahmen.");
  }
  for (const row of changes) {
    if (row.key === "shorter") add(row, "shorter", "Kürzer antworten", "Formuliere deutlich kürzer als dein erster Impuls. Ein Gedanke reicht.");
    if (row.key === "question_removed") add(row, "fewer_questions", "Weniger Fragen", "Stelle nicht automatisch eine Frage. Reagiere auch einmal nur mit einer klaren Aussage.");
    if (row.key === "rewritten") add(row, "fresh_direction", "Eigenständigere Richtung", "Vermeide Standardschablonen und leite den nächsten Schritt konkret aus dem aktuellen Gespräch ab.");
    if (row.key === "tone_changed") add(row, "tone", "Ton näher anpassen", "Nutze kurze gesprochene Sätze und die Wortwahl aus dem Nutzerprofil konsequenter.");
  }
  return rules.sort((a, b) => b.evidence - a.evidence).slice(0, 6);
}

export function learningGuidance(goalCode?: LearningGoal): string {
  const specific = learningRules(goalCode);
  const fallback = specific.length ? specific : learningRules(null);
  if (!fallback.length) return "";
  return `\n# Aus bisherigen Entscheidungen gelernt\n${fallback.slice(0, 4).map((rule) => `- ${rule.instruction} (${rule.evidence} Lernsignale)`).join("\n")}\n`;
}

export function anonymousLearningSnapshot(minimumCount = 5) {
  backfillLearningHistory();
  const rows = db.prepare(
    `SELECT goal_code goal,event_type event,draft_kind kind,intent,change_key change,reason_key reason,
            length_bucket length,has_question question,has_cta cta,outcome,COUNT(*) count
       FROM learning_events
      GROUP BY goal_code,event_type,draft_kind,intent,change_key,reason_key,length_bucket,has_question,has_cta,outcome
     HAVING COUNT(*)>=? ORDER BY count DESC`,
  ).all(minimumCount);
  return { schemaVersion: 1, minimumCount, aggregates: rows };
}

export function learningSummary() {
  backfillLearningHistory();
  const total = (db.prepare("SELECT COUNT(*) n FROM learning_events").get() as { n: number }).n;
  const byGoal = db.prepare(
    "SELECT COALESCE(goal_code,'ALLGEMEIN') goal,COUNT(*) events FROM learning_events GROUP BY COALESCE(goal_code,'ALLGEMEIN') ORDER BY events DESC",
  ).all();
  const decisions = (db.prepare("SELECT COUNT(*) n FROM learning_events WHERE event_type IN ('approved','rejected','outcome')").get() as { n: number }).n;
  const aggregateCount = anonymousLearningSnapshot().aggregates.length;
  return {
    total,
    decisions,
    byGoal,
    rules: learningRules(),
    anonymousAggregates: aggregateCount,
    privacy: { localOnly: !config.learning.syncEnabled, rawTextsStored: false, syncConfigured: config.learning.syncEnabled && !!config.learning.syncUrl },
  };
}

export async function syncAnonymousLearning(): Promise<{ sent: number; skipped?: string }> {
  if (!config.learning.syncEnabled) return { sent: 0, skipped: "nicht aktiviert" };
  if (!/^https:\/\//i.test(config.learning.syncUrl)) return { sent: 0, skipped: "keine sichere Sync-URL" };
  const payload = anonymousLearningSnapshot();
  if (!payload.aggregates.length) return { sent: 0, skipped: "noch keine ausreichend großen Aggregate" };
  const response = await fetch(config.learning.syncUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Lern-Sync HTTP ${response.status}`);
  db.prepare("UPDATE learning_events SET synced_at=datetime('now') WHERE synced_at IS NULL").run();
  return { sent: payload.aggregates.length };
}
