import { createHash } from "node:crypto";
import { db } from "../db/index.js";

export type ConversationIntent = "later" | "busy" | "not_interested" | "do_not_contact" | "interested" | "meeting" | "question" | "neutral";

export type ConversationMemory = {
  contact_id: number;
  intent: ConversationIntent;
  last_statement: string | null;
  commitment: string | null;
  open_point: string | null;
  next_contact_at: string | null;
  source: string;
  source_message_at: string;
  version: number;
  updated_at: string;
};

/**
 * Was WIR dieser Person bereits geschickt haben. Das Gedächtnis kannte bisher nur EINGEHENDE
 * Nachrichten – deshalb meldete der Prüfbereich „Kein früherer Gesprächskontext“, obwohl die
 * Person Minuten zuvor eine Erstnachricht bekommen hatte, und die Kampagne begrüßte sie erneut
 * mit „danke fürs Vernetzen“ (Sinan 2026-08-17). Ein Erstkontakt ist nur einer, wenn wirklich
 * noch nichts rausging.
 */
export type OutboundHistory = {
  count: number;
  lastAt: string | null;
  lastKind: string | null;
  lastText: string | null;
};

export type DraftContextEvidence = {
  contactId: number;
  memoryVersion: number;
  intent: ConversationIntent;
  lastStatement: string | null;
  commitment: string | null;
  openPoint: string | null;
  nextContactAt: string | null;
  sourceMessageAt: string;
  capturedAt: string;
  outbound: OutboundHistory;
};

const sqlTime = (date: Date) => date.toISOString().slice(0, 19).replace("T", " ");
const clean = (value: string, max = 600) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
const addDays = (date: Date, days: number) => { const next = new Date(date); next.setDate(next.getDate() + days); next.setHours(9, 0, 0, 0); return next; };

function nextContact(message: string, now: Date): { at: string | null; commitment: string | null } {
  const text = message.toLocaleLowerCase("de-DE");
  if (/\bwinter\b/.test(text)) {
    const year = now.getMonth() < 11 ? now.getFullYear() : now.getFullYear() + 1;
    return { at: sqlTime(new Date(year, 11, 1, 9, 0, 0)), commitment: `Im Winter ${year} erneut melden` };
  }
  if (/\bn(?:ä|ae)chste[rs]?\s+woche\b/.test(text)) return { at: sqlTime(addDays(now, 7)), commitment: "Nächste Woche erneut melden" };
  if (/\bn(?:ä|ae)chste[ns]?\s+monat\b/.test(text)) return { at: sqlTime(new Date(now.getFullYear(), now.getMonth() + 1, 1, 9, 0, 0)), commitment: "Nächsten Monat erneut melden" };
  const months = ["januar", "februar", "märz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"];
  const namedMonth = text.match(/\b(?:im|ab)\s+(januar|februar|m(?:ä|ae)rz|april|mai|juni|juli|august|september|oktober|november|dezember)\b/);
  if (namedMonth) {
    const normalized = namedMonth[1].replace("ae", "ä");
    const month = months.indexOf(normalized);
    if (month >= 0) {
      const year = month >= now.getMonth() ? now.getFullYear() : now.getFullYear() + 1;
      const label = months[month][0].toUpperCase() + months[month].slice(1);
      return { at: sqlTime(new Date(year, month, 1, 9, 0, 0)), commitment: `Im ${label} ${year} erneut melden` };
    }
  }
  if (/\bnach (?:der|meiner) (?:pr(?:ü|ue)fung|klausur|examen)\b/.test(text)) return { at: sqlTime(addDays(now, 45)), commitment: "Nach der Prüfung erneut melden" };
  if (/\b(?:sp(?:ä|ae)ter|keine zeit|passt (?:gerade|aktuell) nicht|zur(?:ü|ue)ckkommen|melde dich)\b/.test(text)) return { at: sqlTime(addDays(now, 30)), commitment: "Später erneut melden" };
  return { at: null, commitment: null };
}

export function interpretConversationMemory(message: string, now = new Date()) {
  const statement = clean(message);
  if (/^(?:diese\s+)?nachricht wurde gel(?:ö|oe)scht\.?$/i.test(statement))
    return { intent: "neutral" as const, lastStatement: null, commitment: null, openPoint: null, nextContactAt: null };
  const text = statement.toLocaleLowerCase("de-DE");
  const timing = nextContact(statement, now);
  let intent: ConversationIntent = "neutral";
  if (/(?:nicht mehr|nie wieder).*(?:kontaktieren|anschreiben|melden)|keine weiteren nachrichten|in ruhe/.test(text)) intent = "do_not_contact";
  else if ((/\bkein(?:e[sn]?)?\s+interesse\b|\bnicht interessiert\b|\b(?:habe|hab) ich (?:das )?bereits (?:gemacht|getan)\b/.test(text)) && !/\b(?:aktuell|derzeit|momentan|vorerst)\b/.test(text)) intent = "not_interested";
  else if (timing.at) intent = /keine zeit|besch(?:ä|ae)ftigt|stress|pr(?:ü|ue)fung|klausur|examen/.test(text) ? "busy" : "later";
  else if (/\btermin|kalender|telefon|zoom|teams|treffen|gespr(?:ä|ae)ch vereinbaren\b/.test(text)) intent = "meeting";
  else if (/\binteressant|interessiert|interesse|gerne|klingt gut|mehr erfahren\b/.test(text)) intent = "interested";
  else if (/\?$|^(?:hey\s+\w+[!,]?\s*)?(?:wie|was|wann|wo|welche[rs]?|kannst du|können sie)\b/.test(text)) intent = "question";
  const openPoint = intent === "question" ? statement : /\b(?:schick|sende|informationen|details|link)\b/.test(text) ? statement : null;
  return { intent, lastStatement: statement || null, commitment: timing.commitment, openPoint, nextContactAt: timing.at };
}

export function rememberConversationMessage(contactId: number, message: string, source = "conversation", occurredAt = new Date()): ConversationMemory | null {
  if (!Number.isInteger(contactId) || contactId <= 0) return null;
  const parsed = interpretConversationMemory(message, occurredAt);
  if (!parsed.lastStatement) return null;
  const timestamp = sqlTime(occurredAt);
  const dedupe = createHash("sha256").update(`${contactId}|${timestamp}|${parsed.lastStatement}`).digest("hex");
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO conversation_memory_events
       (dedupe_key,contact_id,intent,statement,commitment,open_point,next_contact_at,source,source_message_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(dedupe, contactId, parsed.intent, parsed.lastStatement, parsed.commitment, parsed.openPoint, parsed.nextContactAt, source, timestamp);
    db.prepare(
      `INSERT INTO conversation_memories
       (contact_id,intent,last_statement,commitment,open_point,next_contact_at,source,source_message_at)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(contact_id) DO UPDATE SET
         intent=excluded.intent,last_statement=excluded.last_statement,commitment=excluded.commitment,
         open_point=excluded.open_point,next_contact_at=excluded.next_contact_at,source=excluded.source,
         source_message_at=excluded.source_message_at,version=conversation_memories.version+1,updated_at=datetime('now')
       WHERE excluded.source_message_at>conversation_memories.source_message_at`,
    ).run(contactId, parsed.intent, parsed.lastStatement, parsed.commitment, parsed.openPoint, parsed.nextContactAt, source, timestamp);
    return getConversationMemory(contactId);
  });
  return tx();
}

export function getConversationMemory(contactId: number): ConversationMemory | null {
  return (db.prepare("SELECT * FROM conversation_memories WHERE contact_id=?").get(contactId) as ConversationMemory | undefined) || null;
}

const OUTBOUND_LABEL: Record<string, string> = {
  first: "Erstnachricht", followup: "Follow-up", message: "Antwort im Chat",
  reaktivierung: "Reaktivierung", event: "Event-Einladung", comment: "Kommentar",
};

/** Alles, was NACHWEISLICH rausgegangen ist: gesendete Entwürfe plus `contacts.messaged_at`
 * (der Halb-Automatik-Versand setzt den Zeitstempel direkt, ohne Entwurf). */
export function outboundHistory(contactId: number): OutboundHistory {
  const leer: OutboundHistory = { count: 0, lastAt: null, lastKind: null, lastText: null };
  if (!Number.isInteger(contactId) || contactId <= 0) return leer;
  const gesendet = db.prepare(
    `SELECT COUNT(*) n FROM drafts WHERE contact_id=? AND status='sent' AND kind<>'comment'`,
  ).get(contactId) as { n: number };
  const letzter = db.prepare(
    `SELECT kind,draft,COALESCE(sent_at,created_at) at FROM drafts
      WHERE contact_id=? AND status='sent' AND kind<>'comment'
      ORDER BY COALESCE(sent_at,created_at) DESC,id DESC LIMIT 1`,
  ).get(contactId) as { kind: string; draft: string; at: string } | undefined;
  const messagedAt = (db.prepare("SELECT messaged_at FROM contacts WHERE id=?").get(contactId) as { messaged_at: string | null } | undefined)?.messaged_at ?? null;
  if (!gesendet.n && !messagedAt) return leer;
  // Der Zeitstempel darf nie älter aussehen, als er ist: der jüngste Beleg gewinnt. Den Wortlaut
  // gibt es nur, wenn er auch zum jüngsten Beleg gehört – sonst zeigt der Prüfbereich einen
  // veralteten Text als „letzte Nachricht“ an.
  const ausEntwurf = letzter?.at ?? null;
  const neuerStempel = messagedAt && (!ausEntwurf || messagedAt > ausEntwurf);
  return {
    count: Math.max(gesendet.n, messagedAt ? 1 : 0),
    lastAt: neuerStempel ? messagedAt : ausEntwurf,
    lastKind: neuerStempel ? "Nachricht" : (letzter ? OUTBOUND_LABEL[letzter.kind] ?? letzter.kind : null),
    lastText: neuerStempel || !letzter ? null : clean(letzter.draft, 300),
  };
}

export function captureDraftContext(contactId: number): DraftContextEvidence | null {
  const memory = getConversationMemory(contactId);
  const outbound = outboundHistory(contactId);
  // Kein Gedächtnis UND noch nie etwas gesendet = echter Erstkontakt, es gibt nichts zu belegen.
  if (!memory && !outbound.count) return null;
  return {
    contactId, memoryVersion: memory?.version ?? 0, intent: memory?.intent ?? "neutral",
    lastStatement: memory?.last_statement ?? null, commitment: memory?.commitment ?? null,
    openPoint: memory?.open_point ?? null, nextContactAt: memory?.next_contact_at ?? null,
    sourceMessageAt: memory?.source_message_at ?? outbound.lastAt ?? sqlTime(new Date()),
    capturedAt: sqlTime(new Date()), outbound,
  };
}

export function validateProactiveContext(contactId: number, now = new Date()): { ok: true; evidence: DraftContextEvidence | null } | { ok: false; reason: string; evidence: DraftContextEvidence } {
  const evidence = captureDraftContext(contactId);
  if (!evidence) return { ok: true, evidence: null };
  if (evidence.intent === "do_not_contact") return { ok: false, reason: "Kontakt hat ausdrücklich um keine weiteren Nachrichten gebeten", evidence };
  if (evidence.intent === "not_interested") return { ok: false, reason: "Kontakt hat kein Interesse geäußert", evidence };
  if (["later", "busy"].includes(evidence.intent)) {
    if (!evidence.nextContactAt) return { ok: false, reason: "Kontakt möchte später angesprochen werden – Zeitpunkt muss manuell geklärt werden", evidence };
    if (new Date(evidence.nextContactAt.replace(" ", "T")).getTime() > now.getTime())
      return { ok: false, reason: `${evidence.commitment || "Später erneut melden"} – bis dahin keine Kampagnennachricht`, evidence };
  }
  return { ok: true, evidence };
}

export function attachDraftContext(draftId: number, contactId: number): { ok: boolean; reason?: string } {
  const validation = validateProactiveContext(contactId);
  const evidence = validation.evidence;
  db.prepare("UPDATE drafts SET context_evidence_json=?,context_validation=?,context_memory_version=? WHERE id=?")
    .run(evidence ? JSON.stringify(evidence) : null, validation.ok ? "ok" : "blocked", evidence?.memoryVersion ?? null, draftId);
  return validation.ok ? { ok: true } : { ok: false, reason: validation.reason };
}

export function backfillConversationMemories(): { checked: number; remembered: number } {
  const rows = db.prepare(
    `SELECT contact_id,incoming,created_at FROM drafts
      WHERE contact_id IS NOT NULL AND incoming IS NOT NULL AND trim(incoming)<>'' AND incoming NOT LIKE 'campaign:%'
      ORDER BY created_at,id`,
  ).all() as Array<{ contact_id: number; incoming: string; created_at: string }>;
  let remembered = 0;
  for (const row of rows) if (rememberConversationMessage(row.contact_id, row.incoming, "history_backfill", new Date(row.created_at.replace(" ", "T")))) remembered++;
  return { checked: rows.length, remembered };
}

export function backfillDraftContexts(): { checked: number; blocked: number } {
  const drafts = db.prepare(
    `SELECT id,contact_id,incoming FROM drafts
      WHERE contact_id IS NOT NULL AND kind IN ('first','followup','reaktivierung','event')
        AND status IN ('pending','approved')`,
  ).all() as Array<{ id: number; contact_id: number; incoming: string | null }>;
  let blocked = 0;
  for (const draft of drafts) {
    const result = attachDraftContext(draft.id, draft.contact_id);
    if (result.ok) continue;
    blocked++;
    db.prepare("UPDATE drafts SET status='blockiert',blockiert_grund=?,context_validation='blocked' WHERE id=?")
      .run(result.reason, draft.id);
    const campaignId = Number(String(draft.incoming || "").replace(/^campaign:/, ""));
    if (Number.isInteger(campaignId) && campaignId > 0) db.prepare(
      "UPDATE campaign_targets SET status='snoozed',reason=?,updated_at=datetime('now') WHERE campaign_id=? AND contact_id=? AND status NOT IN ('sent','completed','excluded')",
    ).run(result.reason, campaignId, draft.contact_id);
  }
  return { checked: drafts.length, blocked };
}
