import { db } from "../db/index.js";

export const OUTCOME_STAGES = ["qualified", "meeting", "won", "lost", "not_fit"] as const;
export type OutcomeStage = (typeof OUTCOME_STAGES)[number];

export type CampaignInput = {
  name: string;
  audience?: string;
  valueProp?: string;
  goal?: string;
};

export type CampaignRow = {
  id: number;
  name: string;
  audience: string | null;
  value_prop: string | null;
  goal: string | null;
  active: number;
  created_at: string;
  archived_at: string | null;
  sources: number;
  leads: number;
  invited: number;
  accepted: number;
  messaged: number;
  replied: number;
  qualified: number;
  meetings: number;
  won: number;
  lost: number;
};

const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

export function createCampaign(input: CampaignInput): number {
  const name = text(input.name, 90);
  if (!name) throw new Error("Bitte gib der Kampagne einen Namen.");
  const result = db.prepare(
    "INSERT INTO campaigns(name, audience, value_prop, goal) VALUES(?,?,?,?)",
  ).run(name, text(input.audience, 180) || null, text(input.valueProp, 280) || null, text(input.goal, 120) || null);
  return Number(result.lastInsertRowid);
}

export function updateCampaign(id: number, input: CampaignInput) {
  const name = text(input.name, 90);
  if (!Number.isInteger(id) || id <= 0 || !name) throw new Error("Ungültige Kampagne.");
  return db.prepare(
    "UPDATE campaigns SET name=?, audience=?, value_prop=?, goal=? WHERE id=?",
  ).run(name, text(input.audience, 180) || null, text(input.valueProp, 280) || null, text(input.goal, 120) || null, id).changes > 0;
}

export function setCampaignActive(id: number, active: boolean) {
  return db.prepare(
    "UPDATE campaigns SET active=?, archived_at=CASE WHEN ? THEN NULL ELSE datetime('now') END WHERE id=?",
  ).run(active ? 1 : 0, active ? 1 : 0, id).changes > 0;
}

/** Kampagnen mit einem fokussierten Funnel. Korrelierte Zählungen vermeiden Join-Multiplikate. */
export function listCampaigns(): CampaignRow[] {
  return db.prepare(
    `SELECT c.id, c.name, c.audience, c.value_prop, c.goal, c.active, c.created_at, c.archived_at,
      (SELECT COUNT(*) FROM lead_sources s WHERE s.campaign_id=c.id) AS sources,
      (SELECT COUNT(*) FROM contacts l WHERE l.campaign_id=c.id) AS leads,
      (SELECT COUNT(*) FROM contacts l WHERE l.campaign_id=c.id AND l.invited_at IS NOT NULL) AS invited,
      (SELECT COUNT(*) FROM contacts l WHERE l.campaign_id=c.id AND l.accepted_at IS NOT NULL) AS accepted,
      (SELECT COUNT(*) FROM contacts l WHERE l.campaign_id=c.id AND l.messaged_at IS NOT NULL) AS messaged,
      (SELECT COUNT(*) FROM contacts l WHERE l.campaign_id=c.id AND l.replied_at IS NOT NULL) AS replied,
      (SELECT COUNT(*) FROM sales_outcomes o WHERE o.campaign_id=c.id AND o.stage='qualified') AS qualified,
      (SELECT COUNT(*) FROM sales_outcomes o WHERE o.campaign_id=c.id AND o.stage='meeting') AS meetings,
      (SELECT COUNT(*) FROM sales_outcomes o WHERE o.campaign_id=c.id AND o.stage='won') AS won,
      (SELECT COUNT(*) FROM sales_outcomes o WHERE o.campaign_id=c.id AND o.stage IN ('lost','not_fit')) AS lost
     FROM campaigns c
     ORDER BY c.active DESC, c.created_at DESC`,
  ).all() as CampaignRow[];
}

/** Ergebnis wird pro Kontakt überschrieben: Das Cockpit zeigt immer den aktuellen Stand. */
export function recordOutcome(contactId: number, stage: OutcomeStage, note?: string, valueCents?: number) {
  if (!Number.isInteger(contactId) || contactId <= 0 || !OUTCOME_STAGES.includes(stage)) {
    throw new Error("Ungültiges Vertriebsergebnis.");
  }
  const contact = db.prepare("SELECT campaign_id FROM contacts WHERE id=?").get(contactId) as { campaign_id: number | null } | undefined;
  if (!contact) throw new Error("Kontakt nicht gefunden.");
  const cleanNote = text(note, 600) || null;
  const value = Number.isFinite(valueCents) && Number(valueCents) >= 0 ? Math.round(Number(valueCents)) : null;
  db.prepare(
    `INSERT INTO sales_outcomes(contact_id, campaign_id, stage, note, value_cents, updated_at)
     VALUES(?,?,?,?,?,datetime('now'))
     ON CONFLICT(contact_id) DO UPDATE SET
       campaign_id=excluded.campaign_id, stage=excluded.stage, note=excluded.note,
       value_cents=excluded.value_cents, updated_at=datetime('now')`,
  ).run(contactId, contact.campaign_id, stage, cleanNote, value);
}
