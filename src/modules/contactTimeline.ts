import { createHash } from "node:crypto";
import { db } from "../db/index.js";

export type ContactTimelineItem = {
  kind: "incoming" | "outgoing" | "draft" | "status" | "campaign" | "relationship" | "task";
  title: string;
  text: string;
  ts: string;
  source: string;
};

const exists = (table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const keyFor = (...parts: unknown[]) => createHash("sha256").update(parts.map((part) => String(part ?? "")).join("|")).digest("hex");

export function recordContactTimelineEvent(input: {
  contactId: number;
  eventType: string;
  title: string;
  detail?: string | null;
  source: string;
  sourceId?: string | number | null;
  occurredAt?: string | null;
  dedupeKey?: string;
}): boolean {
  const occurredAt = input.occurredAt || new Date().toISOString().slice(0, 19).replace("T", " ");
  const dedupe = input.dedupeKey || keyFor(input.contactId, input.eventType, input.source, input.sourceId, occurredAt, input.title);
  return db.prepare(
    `INSERT OR IGNORE INTO contact_timeline_events
       (dedupe_key,contact_id,event_type,title,detail,source,source_id,occurred_at)
     VALUES(?,?,?,?,?,?,?,?)`,
  ).run(dedupe, input.contactId, input.eventType, input.title, input.detail || null, input.source, input.sourceId == null ? null : String(input.sourceId), occurredAt).changes > 0;
}

/** Fuehrt vorhandene Statusdaten idempotent zu einer Kontaktspur zusammen. Nachrichtentexte
 * bleiben absichtlich in drafts/agent_messages und werden erst beim Lesen eingeblendet. */
export function backfillContactTimeline(contactId?: number): number {
  const contacts = db.prepare(
    `SELECT id,created_at,invited_at,accepted_at,messaged_at,replied_at,status,notes
       FROM contacts ${contactId ? "WHERE id=?" : ""}`,
  ).all(...(contactId ? [contactId] : [])) as Array<Record<string, string | number | null>>;
  let added = 0;
  for (const contact of contacts) {
    const id = Number(contact.id);
    const stages: Array<[string, string, string | null]> = [
      ["created", "Kontakt aufgenommen", contact.created_at as string],
      ["invited", "Vernetzungsanfrage gesendet", contact.invited_at as string | null],
      ["accepted", "Vernetzung angenommen", contact.accepted_at as string | null],
      ["messaged", "Erste Nachricht gesendet", contact.messaged_at as string | null],
      ["replied", "Kontakt hat geantwortet", contact.replied_at as string | null],
    ];
    for (const [eventType, title, ts] of stages) if (ts && recordContactTimelineEvent({ contactId: id, eventType, title, source: "contact", occurredAt: ts, dedupeKey: `contact:${id}:${eventType}` })) added++;
    if (contact.notes && recordContactTimelineEvent({ contactId: id, eventType: "status", title: "Kontaktnotiz", detail: String(contact.notes), source: "contact", occurredAt: String(contact.created_at), dedupeKey: `contact:${id}:note:${keyFor(contact.notes)}` })) added++;
  }

  const filter = contactId ? " WHERE contact_id=?" : "";
  if (exists("relationship_events")) {
    const rows = db.prepare(`SELECT id,contact_id,kind,reason,valid_until,source,created_at FROM relationship_events${filter}`)
      .all(...(contactId ? [contactId] : [])) as Array<Record<string, string | number | null>>;
    for (const row of rows) {
      const title = row.kind === "snoozed" ? "Kontakt zurückgestellt" : row.kind === "do_not_contact" ? "Automatische Ansprache ausgeschlossen" : row.kind === "resumed" ? "Kontakt wieder freigegeben" : "Kontaktregel geändert";
      const detail = [row.reason, row.valid_until ? `bis ${row.valid_until}` : null].filter(Boolean).join(" · ");
      if (recordContactTimelineEvent({ contactId: Number(row.contact_id), eventType: "relationship", title, detail, source: String(row.source || "relationship"), sourceId: row.id, occurredAt: String(row.created_at), dedupeKey: `relationship:${row.id}` })) added++;
    }
  }
  if (exists("campaign_targets")) {
    const rows = db.prepare(
      `SELECT t.campaign_id,t.contact_id,t.status,t.reason,t.created_at,t.updated_at,c.name
         FROM campaign_targets t JOIN campaigns c ON c.id=t.campaign_id${contactId ? " WHERE t.contact_id=?" : ""}`,
    ).all(...(contactId ? [contactId] : [])) as Array<Record<string, string | number | null>>;
    for (const row of rows) {
      const detail = [String(row.status), row.reason].filter(Boolean).join(" · ");
      if (recordContactTimelineEvent({ contactId: Number(row.contact_id), eventType: "campaign", title: `Kampagne „${row.name}“`, detail, source: "campaign", sourceId: row.campaign_id, occurredAt: String(row.updated_at || row.created_at), dedupeKey: `campaign:${row.campaign_id}:${row.contact_id}:${row.status}` })) added++;
    }
  }
  if (exists("crm_stage_events")) {
    const rows = db.prepare(`SELECT id,contact_id,stage,source,created_at FROM crm_stage_events${filter}`)
      .all(...(contactId ? [contactId] : [])) as Array<Record<string, string | number | null>>;
    for (const row of rows) if (recordContactTimelineEvent({ contactId: Number(row.contact_id), eventType: "status", title: `CRM-Stufe: ${row.stage}`, source: String(row.source), sourceId: row.id, occurredAt: String(row.created_at), dedupeKey: `crm:${row.id}` })) added++;
  }
  if (exists("sales_outcomes")) {
    const rows = db.prepare(`SELECT contact_id,stage,note,value_cents,updated_at FROM sales_outcomes${filter}`)
      .all(...(contactId ? [contactId] : [])) as Array<Record<string, string | number | null>>;
    for (const row of rows) {
      const detail = [row.note, row.value_cents ? `${Math.round(Number(row.value_cents) / 100)} €` : null].filter(Boolean).join(" · ");
      if (recordContactTimelineEvent({ contactId: Number(row.contact_id), eventType: "status", title: `Vertriebsergebnis: ${row.stage}`, detail, source: "sales", sourceId: row.contact_id, occurredAt: String(row.updated_at), dedupeKey: `sales:${row.contact_id}:${row.stage}:${row.updated_at}` })) added++;
    }
  }
  if (exists("sales_tasks")) {
    const rows = db.prepare(`SELECT id,contact_id,title,due_at,status,created_at,completed_at FROM sales_tasks${filter}`)
      .all(...(contactId ? [contactId] : [])) as Array<Record<string, string | number | null>>;
    for (const row of rows) {
      const title = row.status === "done" ? "Aufgabe erledigt" : "Aufgabe vorgemerkt";
      const detail = [row.title, row.due_at ? `fällig ${row.due_at}` : null].filter(Boolean).join(" · ");
      if (recordContactTimelineEvent({ contactId: Number(row.contact_id), eventType: "task", title, detail, source: "task", sourceId: row.id, occurredAt: String(row.completed_at || row.created_at), dedupeKey: `task:${row.id}:${row.status}` })) added++;
    }
  }
  return added;
}

function messageItems(contactId: number): ContactTimelineItem[] {
  const items: ContactTimelineItem[] = [];
  const drafts = db.prepare(
    `SELECT id,kind,incoming,draft,status,created_at,sent_at
       FROM drafts WHERE contact_id=? AND status<>'discarded' ORDER BY created_at`,
  ).all(contactId) as Array<{ id: number; kind: string; incoming: string | null; draft: string; status: string; created_at: string; sent_at: string | null }>;
  for (const row of drafts) {
    if (row.incoming?.trim() && !row.incoming.startsWith("campaign:")) items.push({ kind: "incoming", title: "Eingegangene Nachricht", text: row.incoming.trim(), ts: row.created_at, source: "Entwurfskontext" });
    if (row.status === "sent") items.push({ kind: "outgoing", title: "Nachricht gesendet", text: row.draft, ts: row.sent_at || row.created_at, source: row.kind });
    else if (["pending", "approved", "sending", "blockiert"].includes(row.status)) items.push({ kind: "draft", title: row.status === "approved" ? "Freigegebener Entwurf" : "Offener Entwurf", text: row.draft, ts: row.created_at, source: row.kind });
  }
  if (exists("agent_messages")) {
    const hasContactId = (db.prepare("PRAGMA table_info(agent_messages)").all() as Array<{ name: string }>).some((row) => row.name === "contact_id");
    if (hasContactId) {
      const rows = db.prepare("SELECT sender,text,ts FROM agent_messages WHERE contact_id=? ORDER BY ts")
        .all(contactId) as Array<{ sender: string | null; text: string; ts: string }>;
      for (const row of rows) {
        const sender = String(row.sender || "").toLowerCase();
        const outgoing = sender.includes("user") || sender.includes("self") || sender.includes("sinan");
        items.push({ kind: outgoing ? "outgoing" : "incoming", title: outgoing ? "Nachricht gesendet" : "Eingegangene Nachricht", text: row.text, ts: row.ts, source: "Gesprächsprotokoll" });
      }
    }
  }
  return items;
}

export function getUnifiedContactTimeline(contactId: number): ContactTimelineItem[] {
  backfillContactTimeline(contactId);
  const system = db.prepare(
    "SELECT event_type,title,detail,source,occurred_at FROM contact_timeline_events WHERE contact_id=? ORDER BY occurred_at",
  ).all(contactId) as Array<{ event_type: string; title: string; detail: string | null; source: string; occurred_at: string }>;
  const systemItems = system.map((row): ContactTimelineItem => ({
    kind: row.event_type === "campaign" ? "campaign" : row.event_type === "relationship" ? "relationship" : row.event_type === "task" ? "task" : "status",
    title: row.title,
    text: row.detail || "",
    ts: row.occurred_at,
    source: row.source,
  }));
  const seen = new Set<string>();
  return [...systemItems, ...messageItems(contactId)]
    .filter((item) => item.ts)
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .filter((item) => {
      const key = `${item.kind}|${item.title}|${item.text.trim()}|${item.ts.slice(0, 16)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(-160);
}
