import { db } from "../db/index.js";

type TimelineKind = "incoming" | "outgoing" | "draft" | "system";

export type ConversationTimelineItem = {
  kind: TimelineKind;
  text: string;
  ts: string;
  source: "protokoll" | "entwurf" | "status";
};

const tableExists = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/**
 * Verbindet die getrennten, lokal gespeicherten Gesprächssignale zu einer Kontaktansicht.
 * Wichtig: Entwürfe sind als solche markiert. Nur der vom Agenten gespeicherte Verlauf wird
 * als protokollierte Nachricht gezeigt – die Ansicht behauptet nie einen vollständigen
 * LinkedIn-Chat, wenn dieser lokal nicht vorhanden ist.
 */
export function getConversationWorkspace(contactId: number) {
  if (!Number.isInteger(contactId) || contactId <= 0) throw new Error("Kontakt fehlt.");
  const contact = db.prepare(
    `SELECT c.id, c.full_name, c.headline, c.profile_url, c.status, c.messaged_at, c.replied_at,
            ca.name AS campaign_name, o.stage AS outcome_stage, o.note AS outcome_note
       FROM contacts c
       LEFT JOIN campaigns ca ON ca.id=c.campaign_id
       LEFT JOIN sales_outcomes o ON o.contact_id=c.id
      WHERE c.id=?`,
  ).get(contactId) as Record<string, string | number | null> | undefined;
  if (!contact) throw new Error("Kontakt nicht gefunden.");

  const threadUrls = new Set<string>();
  if (typeof contact.profile_url === "string" && contact.profile_url) threadUrls.add(contact.profile_url);
  const name = String(contact.full_name ?? "");

  // Der neue Agent und der ältere Autopilot speichern die echte Thread-URL getrennt.
  // Beides wird nur einbezogen, wenn der Teilnehmer zum Kontakt passt.
  for (const table of ["agent_conversations", "conversations"]) {
    if (!tableExists(table)) continue;
    const column = table === "agent_conversations" ? "teilnehmer" : "participant";
    const rows = db.prepare(`SELECT thread_url FROM ${table} WHERE ${column}=?`).all(name) as { thread_url: string }[];
    rows.forEach((row) => { if (row.thread_url) threadUrls.add(row.thread_url); });
  }

  const urls = [...threadUrls];
  const placeHolders = urls.map(() => "?").join(",");
  const drafts = urls.length
    ? db.prepare(
      `SELECT id, incoming, draft, status, created_at, sent_at
         FROM drafts
        WHERE thread_url IN (${placeHolders}) OR participant=?
        ORDER BY created_at ASC LIMIT 60`,
    ).all(...urls, name) as Array<{ id: number; incoming: string | null; draft: string; status: string; created_at: string; sent_at: string | null }>
    : [];

  const timeline: ConversationTimelineItem[] = [];
  for (const draft of drafts) {
    if (draft.incoming?.trim()) timeline.push({ kind: "incoming", text: draft.incoming.trim(), ts: draft.created_at, source: "entwurf" });
    const sent = draft.status === "sent";
    timeline.push({ kind: sent ? "outgoing" : "draft", text: draft.draft, ts: sent && draft.sent_at ? draft.sent_at : draft.created_at, source: "entwurf" });
  }

  if (urls.length && tableExists("agent_messages")) {
    const messages = db.prepare(
      `SELECT sender, text, ts FROM agent_messages WHERE thread_url IN (${placeHolders}) ORDER BY ts ASC LIMIT 80`,
    ).all(...urls) as Array<{ sender: string | null; text: string; ts: string }>;
    for (const message of messages) {
      const sender = (message.sender ?? "").toLowerCase();
      timeline.push({
        kind: sender.includes("user") || sender.includes("self") || sender.includes("sinan") ? "outgoing" : "incoming",
        text: message.text,
        ts: message.ts,
        source: "protokoll",
      });
    }
  }

  // Mehrere Komponenten können dasselbe Ereignis protokollieren. Für die Arbeitsansicht
  // genügt eine Fassung je Text/Zeitpunkt; der Rohverlauf bleibt unverändert in SQLite.
  const seen = new Set<string>();
  const cleanTimeline = timeline
    .filter((item) => item.text.trim())
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .filter((item) => {
      const key = `${item.ts}|${item.text.trim()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(-80);

  const tasks = db.prepare(
    "SELECT id, title, due_at, status FROM sales_tasks WHERE contact_id=? ORDER BY status, COALESCE(due_at,'9999-12-31'), created_at",
  ).all(contactId);

  return { contact, timeline: cleanTimeline, tasks, threadCount: urls.length };
}
