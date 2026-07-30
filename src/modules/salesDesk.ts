import { db } from "../db/index.js";

const clean = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

export type SalesTask = {
  id: number;
  contact_id: number;
  title: string;
  due_at: string | null;
  status: "open" | "done";
  full_name: string | null;
  profile_url: string;
  campaign_name: string | null;
};

export function addSalesTask(contactId: number, title: string, dueAt?: string) {
  if (!Number.isInteger(contactId) || contactId <= 0) throw new Error("Bitte wähle einen Kontakt.");
  const task = clean(title, 220);
  if (!task) throw new Error("Beschreibe den nächsten Schritt.");
  const contact = db.prepare("SELECT id FROM contacts WHERE id=?").get(contactId);
  if (!contact) throw new Error("Kontakt nicht gefunden.");
  const due = clean(dueAt, 10);
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error("Das Datum ist ungültig.");
  return Number(db.prepare("INSERT INTO sales_tasks(contact_id,title,due_at) VALUES(?,?,?)").run(contactId, task, due || null).lastInsertRowid);
}

export function completeSalesTask(id: number) {
  return db.prepare("UPDATE sales_tasks SET status='done', completed_at=datetime('now') WHERE id=? AND status='open'").run(id).changes > 0;
}

export function deleteSalesTask(id: number) {
  return db.prepare("DELETE FROM sales_tasks WHERE id=?").run(id).changes > 0;
}

export function openSalesTasks(limit = 30): SalesTask[] {
  return db.prepare(
    `SELECT t.id, t.contact_id, t.title, t.due_at, t.status, c.full_name, c.profile_url, ca.name AS campaign_name
       FROM sales_tasks t
       JOIN contacts c ON c.id=t.contact_id
       LEFT JOIN campaigns ca ON ca.id=c.campaign_id
      WHERE t.status='open'
      ORDER BY CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END, t.due_at, t.created_at
      LIMIT ?`,
  ).all(limit) as SalesTask[];
}

/** Priorisierte Verkaufssicht: echte Antworten zuerst, dann wartende Entwürfe und Follow-ups. */
export function salesDesk(limit = 18) {
  const rows = db.prepare(
    `SELECT c.id, c.full_name, c.headline, c.profile_url, c.status, c.lead_score, c.messaged_at, c.replied_at,
            ca.name AS campaign_name, o.stage AS outcome_stage,
            (SELECT d.id FROM drafts d WHERE d.thread_url=c.profile_url AND d.status IN ('pending','approved')
              AND d.kind IN ('message','first','followup','reaktivierung') ORDER BY d.created_at DESC LIMIT 1) AS draft_id,
            (SELECT d.status FROM drafts d WHERE d.thread_url=c.profile_url AND d.status IN ('pending','approved')
              AND d.kind IN ('message','first','followup','reaktivierung') ORDER BY d.created_at DESC LIMIT 1) AS draft_status,
            (SELECT COUNT(*) FROM sales_tasks t WHERE t.contact_id=c.id AND t.status='open') AS task_count
       FROM contacts c
       LEFT JOIN campaigns ca ON ca.id=c.campaign_id
       LEFT JOIN sales_outcomes o ON o.contact_id=c.id
      WHERE c.status IN ('accepted','messaged','replied','closed')
        AND COALESCE(o.stage,'') NOT IN ('won','lost','not_fit')
      ORDER BY CASE c.status WHEN 'replied' THEN 0 WHEN 'accepted' THEN 1 WHEN 'messaged' THEN 2 ELSE 3 END,
               CASE WHEN o.stage='meeting' THEN 0 WHEN o.stage='qualified' THEN 1 ELSE 2 END,
               COALESCE(c.replied_at,c.messaged_at,c.accepted_at,c.created_at) DESC
      LIMIT ?`,
  ).all(limit) as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const status = String(row.status);
    const draftStatus = row.draft_status ? String(row.draft_status) : null;
    let nextAction = "Nächsten Schritt planen";
    let urgency: "hot" | "ready" | "watch" = "watch";
    if (status === "replied") { nextAction = "Antworten oder Ergebnis festhalten"; urgency = "hot"; }
    else if (draftStatus === "pending") { nextAction = "Entwurf prüfen"; urgency = "ready"; }
    else if (draftStatus === "approved") { nextAction = "Wartet auf sicheren Versand"; urgency = "ready"; }
    else if (status === "accepted") { nextAction = "Erstnachricht vorbereiten"; urgency = "ready"; }
    else if (status === "messaged") { nextAction = "Follow-up im Blick behalten"; }
    if (row.outcome_stage === "meeting") { nextAction = "Termin vorbereiten"; urgency = "hot"; }
    return { ...row, nextAction, urgency };
  });
}
