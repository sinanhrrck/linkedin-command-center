import { createHash } from "node:crypto";
import { db } from "../db/index.js";
import { resolveContactIdentity } from "./contactIdentity.js";
import { rememberConversationMessage } from "./conversationMemory.js";

export type ProactiveKind = "connect" | "first" | "followup" | "reaktivierung" | "event" | "campaign";
export type RelationshipDecision = { ok: true } | { ok: false; reason: string; until?: string | null };

type ContactPolicyRow = {
  id: number;
  profile_url: string;
  full_name: string | null;
  status: string;
  automation_status: string | null;
  snoozed_until: string | null;
  snooze_label: string | null;
  snooze_reason: string | null;
  do_not_contact: number | null;
  last_meaningful_contact_at: string | null;
};

export type RelationshipSignal =
  | { kind: "snoozed"; until: string; label: string; reason: string }
  | { kind: "do_not_contact"; reason: string };

const sqlTime = (date: Date) => date.toISOString().slice(0, 19).replace("T", " ");
const addDays = (now: Date, days: number) => {
  const result = new Date(now);
  result.setDate(result.getDate() + days);
  result.setHours(9, 0, 0, 0);
  return result;
};

/** Konservative, deterministische Erkennung. Die KI darf ergänzen, aber diese Schutzsignale
 * funktionieren auch bei API-Ausfall und führen nie selbst zu einem Versand. */
export function interpretRelationshipSignal(message: string, now = new Date()): RelationshipSignal | null {
  const raw = String(message || "").replace(/\s+/g, " ").trim();
  const text = raw.toLocaleLowerCase("de-DE");
  if (!text) return null;

  const permanent = /(?:bitte\s+)?(?:nicht mehr|nie wieder)\s+(?:kontaktieren|anschreiben|melden)|lass(?:en sie|t)?\s+mich\s+(?:bitte\s+)?in ruhe|keine weiteren nachrichten/.test(text);
  const noInterest = /\bkein(?:e[sn]?)?\s+interesse\b|\bnicht interessiert\b/.test(text);
  const temporary = /\b(?:aktuell|derzeit|im moment|momentan|vorerst|zurzeit|jetzt)\b/.test(text);
  if (permanent || (noInterest && !temporary)) {
    return { kind: "do_not_contact", reason: permanent ? "Kontakt wünscht keine weiteren Nachrichten" : "Kein Interesse" };
  }

  const asksForLater = /\b(?:später|spaeter|keine zeit|nicht die zeit|passt (?:gerade|aktuell) nicht|zurückkommen|zurueckkommen|melde dich|melden sie sich|prüfung|pruefung|klausur|examen)\b/.test(text);
  if (!asksForLater && !(noInterest && temporary)) return null;

  let until = addDays(now, 30);
  let label = "in 30 Tagen";
  let reason = /prüf|pruef|klausur|examen/.test(text) ? "Prüfung oder intensive Vorbereitung" : "Kontakt möchte aktuell nicht angesprochen werden";

  if (/\bwinter\b/.test(text)) {
    const year = now.getMonth() < 11 ? now.getFullYear() : now.getFullYear() + 1;
    until = new Date(year, 11, 1, 9, 0, 0, 0);
    label = `Winter ${year}`;
  } else if (/\bnächste[rs]?\s+woche\b|\bnaechste[rs]?\s+woche\b/.test(text)) {
    until = addDays(now, 7);
    label = "nächste Woche";
  } else if (/\bnächste[ns]?\s+monat\b|\bnaechste[ns]?\s+monat\b/.test(text)) {
    until = new Date(now.getFullYear(), now.getMonth() + 1, 1, 9, 0, 0, 0);
    label = "nächsten Monat";
  } else if (/\bnach (?:der|meiner) (?:prüfung|pruefung|klausur|examen)\b/.test(text)) {
    until = addDays(now, 45);
    label = "nach der Prüfung";
  }

  return { kind: "snoozed", until: sqlTime(until), label, reason };
}

export function resolveContact(target: string, participant = ""): ContactPolicyRow | undefined {
  const identity = resolveContactIdentity(target, participant, "relationship_policy");
  if (!identity) return undefined;
  return db.prepare(
    `SELECT id,profile_url,full_name,status,automation_status,snoozed_until,snooze_label,snooze_reason,
            do_not_contact,last_meaningful_contact_at
       FROM contacts WHERE id=?`,
  ).get(identity.id) as ContactPolicyRow | undefined;
}

export function proactiveDecision(contactId: number, _kind: ProactiveKind, now = new Date()): RelationshipDecision {
  const contact = db.prepare(
    `SELECT id,profile_url,full_name,status,automation_status,snoozed_until,snooze_label,snooze_reason,
            do_not_contact,last_meaningful_contact_at
       FROM contacts WHERE id=?`,
  ).get(contactId) as ContactPolicyRow | undefined;
  if (!contact) return { ok: false, reason: "Kontakt ist nicht mehr vorhanden" };
  if (contact.do_not_contact || contact.automation_status === "excluded")
    return { ok: false, reason: contact.snooze_reason || "Kontakt dauerhaft von automatischer Ansprache ausgeschlossen" };
  if (contact.automation_status === "manual")
    return { ok: false, reason: "Kontakt darf nur manuell angeschrieben werden" };
  if (contact.snoozed_until && new Date(contact.snoozed_until.replace(" ", "T")).getTime() > now.getTime()) {
    const bis = contact.snooze_label || new Date(contact.snoozed_until.replace(" ", "T")).toLocaleDateString("de-DE");
    return { ok: false, reason: `${contact.snooze_reason || "Wiedervorlage"} – wartet bis ${bis}`, until: contact.snoozed_until };
  }
  if (contact.automation_status === "paused")
    return { ok: false, reason: `${contact.snooze_reason || "Wiedervorlage"} – ist fällig und muss vor neuer Ansprache geprüft werden`, until: contact.snoozed_until };
  return { ok: true };
}

export function proactiveDecisionForTarget(target: string, participant: string, kind: ProactiveKind, now = new Date()): RelationshipDecision {
  const contact = resolveContact(target, participant);
  return contact ? proactiveDecision(contact.id, kind, now) : { ok: false, reason: "Kontakt konnte nicht eindeutig zugeordnet werden" };
}

function rememberEvent(contactId: number, signal: RelationshipSignal, source: string, message: string): boolean {
  const key = createHash("sha256").update(`${contactId}|${signal.kind}|${signal.kind === "snoozed" ? signal.until : ""}|${message.trim()}`).digest("hex");
  return db.prepare(
    `INSERT OR IGNORE INTO relationship_events(dedupe_key,contact_id,kind,reason,valid_until,source)
     VALUES(?,?,?,?,?,?)`,
  ).run(key, contactId, signal.kind, signal.reason, signal.kind === "snoozed" ? signal.until : null, source).changes > 0;
}

/** Speichert ein Beziehungssignal und entfernt proaktive Arbeit sofort aus allen offenen Queues.
 * Antwortentwürfe (kind='message') bleiben bestehen, damit eine höfliche Bestätigung möglich ist. */
export function applyRelationshipSignal(contactId: number, signal: RelationshipSignal, source = "conversation", message = ""): boolean {
  const contact = db.prepare("SELECT profile_url,full_name FROM contacts WHERE id=?").get(contactId) as
    { profile_url: string; full_name: string | null } | undefined;
  if (!contact) return false;
  const tx = db.transaction(() => {
    if (signal.kind === "do_not_contact") {
      db.prepare(
        `UPDATE contacts SET automation_status='excluded',do_not_contact=1,snoozed_until=NULL,
             snooze_label=NULL,snooze_reason=? WHERE id=?`,
      ).run(signal.reason, contactId);
    } else {
      db.prepare(
        `UPDATE contacts SET automation_status='paused',snoozed_until=?,snooze_label=?,snooze_reason=?,
             do_not_contact=0 WHERE id=?`,
      ).run(signal.until, signal.label, signal.reason, contactId);
    }
    db.prepare(
      `UPDATE campaign_targets SET status=? ,updated_at=datetime('now')
        WHERE contact_id=? AND status NOT IN ('sent','completed','excluded')`,
    ).run(signal.kind === "do_not_contact" ? "excluded" : "snoozed", contactId);
    db.prepare(
      `UPDATE drafts SET status='discarded',rejection_reason=?,blockiert_grund=?
        WHERE status IN ('pending','approved','blockiert')
          AND kind IN ('first','followup','reaktivierung','event')
          AND (thread_url=? OR participant=?)`,
    ).run(`relationship_${signal.kind}`, signal.reason, contact.profile_url, contact.full_name);
    return rememberEvent(contactId, signal, source, message);
  });
  return tx();
}

export function observeRelationshipMessage(contactId: number, message: string, now = new Date()): RelationshipSignal | null {
  db.prepare("UPDATE contacts SET last_meaningful_contact_at=? WHERE id=?").run(sqlTime(now), contactId);
  rememberConversationMessage(contactId, message, "conversation", now);
  const signal = interpretRelationshipSignal(message, now);
  if (signal) applyRelationshipSignal(contactId, signal, "conversation", message);
  return signal;
}

/** Einmaliger, idempotenter Schutz für bestehende Gespräche. Pro Kontakt wird ausschließlich die
 * jüngste gespeicherte eingehende Nachricht betrachtet; ein älteres „später“ darf eine danach
 * wieder aufgenommene Unterhaltung nicht erneut pausieren. */
export function backfillRelationshipSignals(): number {
  const rows = db.prepare(
    `SELECT d.incoming,d.created_at,d.contact_id,d.thread_url,d.participant
       FROM drafts d
      WHERE d.incoming IS NOT NULL AND trim(d.incoming)<>'' AND d.incoming NOT LIKE 'campaign:%'
        AND d.kind IN ('message','pitchidee')
      ORDER BY d.created_at DESC,d.id DESC`,
  ).all() as Array<{ incoming: string; created_at: string; contact_id: number | null; thread_url: string; participant: string | null }>;
  const seen = new Set<number>();
  let applied = 0;
  for (const row of rows) {
    const contactId = row.contact_id ?? resolveContactIdentity(row.thread_url, row.participant || "", "relationship_backfill")?.id;
    if (!contactId || seen.has(contactId)) continue;
    seen.add(contactId);
    const signal = interpretRelationshipSignal(row.incoming, new Date(row.created_at.replace(" ", "T")));
    if (!signal) continue;
    if (applyRelationshipSignal(contactId, signal, "history_backfill", row.incoming)) applied++;
  }
  return applied;
}

export function blockDraftForRelationship(draftId: number, reason: string): void {
  db.prepare(
    `UPDATE drafts SET status='blockiert',blockiert_grund=?,rejection_reason='relationship_policy'
      WHERE id=? AND status='sending'`,
  ).run(reason, draftId);
}

export function setRelationshipPolicy(input: {
  contactId: number;
  action: "pause" | "resume" | "exclude" | "manual";
  until?: string;
  reason?: string;
}): boolean {
  const contactId = Number(input.contactId);
  if (!Number.isInteger(contactId) || contactId <= 0 || !db.prepare("SELECT 1 FROM contacts WHERE id=?").get(contactId)) return false;
  const reason = String(input.reason || "").replace(/\s+/g, " ").trim().slice(0, 240);
  if (input.action === "exclude") {
    applyRelationshipSignal(contactId, { kind: "do_not_contact", reason: reason || "Manuell dauerhaft ausgeschlossen" }, "manual", `${Date.now()}`);
    return true;
  }
  if (input.action === "pause") {
    const date = new Date(String(input.until || ""));
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new Error("Bitte wähle ein zukünftiges Datum.");
    date.setHours(9, 0, 0, 0);
    applyRelationshipSignal(contactId, {
      kind: "snoozed",
      until: sqlTime(date),
      label: date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }),
      reason: reason || "Manuell zurückgestellt",
    }, "manual", `${Date.now()}`);
    return true;
  }
  const status = input.action === "manual" ? "manual" : "active";
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE contacts SET automation_status=?,do_not_contact=0,snoozed_until=NULL,snooze_label=NULL,
                           snooze_reason=? WHERE id=?`,
    ).run(status, input.action === "manual" ? reason || "Nur manuelle Ansprache" : null, contactId);
    if (input.action === "resume") {
      db.prepare(
        `UPDATE campaign_targets SET status=CASE route WHEN 'network' THEN 'queued' ELSE 'awaiting_connection' END,
                                     updated_at=datetime('now')
          WHERE contact_id=? AND status='snoozed'`,
      ).run(contactId);
    }
    const signalText = `${contactId}|${input.action}|${Date.now()}`;
    const key = createHash("sha256").update(signalText).digest("hex");
    db.prepare(
      "INSERT INTO relationship_events(dedupe_key,contact_id,kind,reason,source) VALUES(?,?,?,?, 'manual')",
    ).run(key, contactId, input.action === "resume" ? "resumed" : "manual", reason || null);
  });
  tx();
  return true;
}
