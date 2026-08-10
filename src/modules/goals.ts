import { db } from "../db/index.js";

export const GOAL_CODES = ["B1", "P1", "AEC"] as const;
export type GoalCode = (typeof GOAL_CODES)[number];

export type ConversationGoal = {
  code: GoalCode;
  label: string;
  instruction: string;
  campaignId: number | null;
};

const DEFINITIONS: Record<GoalCode, Omit<ConversationGoal, "campaignId">> = {
  B1: {
    code: "B1",
    label: "Kunde",
    instruction: "Führe das Gespräch bei echter Passung behutsam zu einer Kundenberatung. Keine Beratung im Chat erzwingen; Ziel ist ein passender persönlicher Beratungstermin.",
  },
  P1: {
    code: "P1",
    label: "Vertriebspartner",
    instruction: "Führe das Gespräch bei echter Passung behutsam zu einem Austausch über eine Zusammenarbeit als Vertriebspartner. Nicht kalt pitchen; erst Interesse und Passung verstehen.",
  },
  AEC: {
    code: "AEC",
    label: "AEC",
    instruction: "Führe das Gespräch behutsam zum hinterlegten AEC-Ziel. Nutze nur Fakten aus Profil, Auftrag und Gespräch; erfinde keine Bedeutung oder Leistungsbeschreibung für AEC.",
  },
};

export function isGoalCode(value: unknown): value is GoalCode {
  return typeof value === "string" && GOAL_CODES.includes(value as GoalCode);
}

export function goalDefinition(code: GoalCode, campaignId: number | null = null): ConversationGoal {
  return { ...DEFINITIONS[code], campaignId };
}

/** Findet den Auftrag eines Chats. Profil-URL ist der beste Schlüssel, der Name der Fallback. */
export function goalForConversation(threadUrl: string, participant = ""): ConversationGoal | null {
  const row = db.prepare(
    `SELECT ca.id campaign_id,COALESCE(c.goal_code_override,ca.goal_code) goal_code
       FROM contacts c JOIN campaigns ca ON ca.id=c.campaign_id
      WHERE ca.active=1 AND COALESCE(c.goal_code_override,ca.goal_code) IN ('B1','P1','AEC')
        AND (c.profile_url=? OR lower(trim(c.full_name))=lower(trim(?)))
      ORDER BY CASE WHEN c.profile_url=? THEN 0 ELSE 1 END LIMIT 1`,
  ).get(threadUrl, participant, threadUrl) as { campaign_id: number; goal_code: string } | undefined;
  return row && isGoalCode(row.goal_code) ? goalDefinition(row.goal_code, row.campaign_id) : null;
}

export function goalForContact(contactId: number): ConversationGoal | null {
  const row = db.prepare(
    `SELECT ca.id campaign_id,COALESCE(c.goal_code_override,ca.goal_code) goal_code FROM contacts c JOIN campaigns ca ON ca.id=c.campaign_id
      WHERE c.id=? AND ca.active=1 AND COALESCE(c.goal_code_override,ca.goal_code) IN ('B1','P1','AEC') LIMIT 1`,
  ).get(contactId) as { campaign_id: number; goal_code: string } | undefined;
  return row && isGoalCode(row.goal_code) ? goalDefinition(row.goal_code, row.campaign_id) : null;
}

export function recordGoalAlert(input: {
  threadUrl: string;
  participant: string;
  currentGoal: GoalCode;
  suggestedGoal?: GoalCode | null;
  summary: string;
  campaignId?: number | null;
}): number {
  const contact = db.prepare(
    "SELECT id FROM contacts WHERE profile_url=? OR lower(trim(full_name))=lower(trim(?)) ORDER BY CASE WHEN profile_url=? THEN 0 ELSE 1 END LIMIT 1",
  ).get(input.threadUrl, input.participant, input.threadUrl) as { id: number } | undefined;
  db.prepare(
    `INSERT INTO goal_alerts(campaign_id,contact_id,thread_url,participant,current_goal,suggested_goal,summary)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(thread_url) WHERE status='open' DO UPDATE SET
       suggested_goal=excluded.suggested_goal,summary=excluded.summary,created_at=datetime('now')`,
  ).run(input.campaignId ?? null, contact?.id ?? null, input.threadUrl, input.participant,
    input.currentGoal, input.suggestedGoal ?? null, input.summary.slice(0, 800));
  return Number((db.prepare("SELECT id FROM goal_alerts WHERE thread_url=? AND status='open'").get(input.threadUrl) as { id: number }).id);
}

export function resolveGoalAlert(id: number, action: "accepted" | "dismissed"): boolean {
  const alert = db.prepare("SELECT * FROM goal_alerts WHERE id=? AND status='open'").get(id) as
    | { contact_id: number | null; suggested_goal: string | null }
    | undefined;
  if (!alert) return false;
  const tx = db.transaction(() => {
    if (action === "accepted" && alert.contact_id && isGoalCode(alert.suggested_goal))
      db.prepare("UPDATE contacts SET goal_code_override=? WHERE id=?").run(alert.suggested_goal, alert.contact_id);
    db.prepare("UPDATE goal_alerts SET status=?,resolved_at=datetime('now') WHERE id=?").run(action, id);
  });
  tx();
  return true;
}
