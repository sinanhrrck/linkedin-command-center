import { db } from "../db/index.js";
import { canonicalProfileUrl, isLinkedInProfileUrl } from "../core/profileUrl.js";

export type IdentityType = "profile_url" | "thread_url" | "external_url";
export type ContactIdentity = {
  id: number;
  profile_url: string;
  full_name: string | null;
  method: "identity" | "profile" | "unique_name";
  confidence: "confirmed" | "inferred";
};

const tableExists = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const columnExists = (table: string, column: string) => tableExists(table)
  && (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);

export function identityType(value: string): IdentityType {
  const raw = String(value || "").trim();
  if (isLinkedInProfileUrl(raw)) return "profile_url";
  if (/linkedin\.com\/messaging\/thread\//i.test(raw)) return "thread_url";
  return "external_url";
}

export function normalizeIdentity(value: string, type = identityType(value)): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (type === "profile_url") return canonicalProfileUrl(raw);
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^([a-z]{2}\.)?linkedin\.com$/, "www.linkedin.com");
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol.toLowerCase()}//${host}${path}`;
  } catch {
    return raw.split("?")[0].split("#")[0].replace(/\/+$/, "");
  }
}

function rememberConflict(type: IdentityType, value: string, participant: string, candidates: number[], reason: string): void {
  const normalized = normalizeIdentity(value, type);
  if (!normalized) return;
  db.prepare(
    `INSERT INTO contact_identity_conflicts(identity_type,identity_value,normalized_value,participant,candidate_contact_ids,reason)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(identity_type,normalized_value) WHERE status='open' DO UPDATE SET
       identity_value=excluded.identity_value,participant=excluded.participant,
       candidate_contact_ids=excluded.candidate_contact_ids,reason=excluded.reason,last_seen_at=datetime('now')`,
  ).run(type, value, normalized, participant || null, JSON.stringify(candidates), reason);
}

/** Verknuepft einen technischen Schluessel genau einmal. Ein Konflikt wird sichtbar gespeichert;
 * bestehende Identitaeten werden niemals still auf einen anderen Kontakt umgebogen. */
export function linkContactIdentity(input: {
  contactId: number;
  value: string;
  type?: IdentityType;
  confidence?: "confirmed" | "inferred";
  source?: string;
  participant?: string;
}): boolean {
  const type = input.type ?? identityType(input.value);
  const normalized = normalizeIdentity(input.value, type);
  if (!normalized) return false;
  const existing = db.prepare(
    "SELECT contact_id FROM contact_identities WHERE identity_type=? AND normalized_value=?",
  ).get(type, normalized) as { contact_id: number } | undefined;
  if (existing && existing.contact_id !== input.contactId) {
    rememberConflict(type, input.value, input.participant || "", [existing.contact_id, input.contactId], "Technischer Schlüssel gehört bereits zu einem anderen Kontakt");
    return false;
  }
  db.prepare(
    `INSERT INTO contact_identities(contact_id,identity_type,identity_value,normalized_value,confidence,source)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(identity_type,normalized_value) DO UPDATE SET
       identity_value=excluded.identity_value,last_seen_at=datetime('now'),
       confidence=CASE WHEN contact_identities.confidence='confirmed' THEN 'confirmed' ELSE excluded.confidence END`,
  ).run(input.contactId, type, input.value, normalized, input.confidence || "confirmed", input.source || "system");
  db.prepare("UPDATE contact_identity_conflicts SET status='resolved' WHERE identity_type=? AND normalized_value=? AND status='open'")
    .run(type, normalized);
  if (columnExists("drafts", "contact_id")) {
    db.prepare("UPDATE drafts SET contact_id=? WHERE contact_id IS NULL AND (thread_url=? OR thread_url=?)")
      .run(input.contactId, input.value, normalized);
  }
  if (columnExists("conversations", "contact_id")) {
    db.prepare("UPDATE conversations SET contact_id=? WHERE contact_id IS NULL AND (thread_url=? OR thread_url=?)")
      .run(input.contactId, input.value, normalized);
  }
  if (columnExists("agent_conversations", "contact_id")) {
    db.prepare("UPDATE agent_conversations SET contact_id=? WHERE contact_id IS NULL AND (thread_url=? OR thread_url=?)")
      .run(input.contactId, input.value, normalized);
  }
  if (columnExists("agent_messages", "contact_id")) {
    db.prepare("UPDATE agent_messages SET contact_id=? WHERE contact_id IS NULL AND (thread_url=? OR thread_url=?)")
      .run(input.contactId, input.value, normalized);
  }
  return true;
}

/** Zentrale Kontaktaufloesung. URL-/Thread-Identitaeten gewinnen; ein Name darf nur dann als
 * Altbestands-Fallback dienen, wenn er in der gesamten Kontaktbasis eindeutig ist. */
export function resolveContactIdentity(value: string, participant = "", source = "runtime"): ContactIdentity | undefined {
  const type = identityType(value);
  const normalized = normalizeIdentity(value, type);
  if (normalized) {
    const byIdentity = db.prepare(
      `SELECT c.id,c.profile_url,c.full_name,i.confidence
         FROM contact_identities i JOIN contacts c ON c.id=i.contact_id
        WHERE i.identity_type=? AND i.normalized_value=? LIMIT 1`,
    ).get(type, normalized) as Omit<ContactIdentity, "method"> | undefined;
    if (byIdentity) {
      db.prepare("UPDATE contact_identities SET last_seen_at=datetime('now') WHERE identity_type=? AND normalized_value=?").run(type, normalized);
      return { ...byIdentity, method: "identity" };
    }
  }

  if (type === "profile_url" && normalized) {
    const byProfile = db.prepare(
      "SELECT id,profile_url,full_name FROM contacts WHERE profile_url=? OR normalized_url=? LIMIT 1",
    ).get(normalized, normalized) as { id: number; profile_url: string; full_name: string | null } | undefined;
    if (byProfile) {
      linkContactIdentity({ contactId: byProfile.id, value: normalized, type: "profile_url", confidence: "confirmed", source, participant });
      return { ...byProfile, method: "profile", confidence: "confirmed" };
    }
  }

  const name = participant.trim();
  if (!name) return undefined;
  const matches = db.prepare(
    "SELECT id,profile_url,full_name FROM contacts WHERE lower(trim(full_name))=lower(trim(?)) ORDER BY id LIMIT 3",
  ).all(name) as Array<{ id: number; profile_url: string; full_name: string | null }>;
  if (matches.length !== 1) {
    if (normalized) rememberConflict(type, value, name, matches.map((row) => row.id), matches.length ? "Name ist nicht eindeutig" : "Kein passender Kontakt gefunden");
    return undefined;
  }
  const contact = matches[0];
  if (normalized) linkContactIdentity({ contactId: contact.id, value, type, confidence: "inferred", source, participant: name });
  return { ...contact, method: "unique_name", confidence: "inferred" };
}

function bindStoredRow(table: "drafts" | "conversations" | "agent_conversations", rowId: number | string, threadUrl: string, participant: string): boolean {
  const contact = resolveContactIdentity(threadUrl, participant, `history:${table}`);
  if (!contact || !columnExists(table, "contact_id")) return false;
  if (table === "drafts") db.prepare("UPDATE drafts SET contact_id=? WHERE id=? AND contact_id IS NULL").run(contact.id, rowId);
  else db.prepare(`UPDATE ${table} SET contact_id=? WHERE thread_url=? AND contact_id IS NULL`).run(contact.id, rowId);
  return true;
}

export function backfillContactIdentities(): { profiles: number; threads: number; unresolved: number } {
  for (const table of ["agent_conversations", "agent_messages"] as const) {
    if (tableExists(table) && !columnExists(table, "contact_id")) {
      try { db.exec(`ALTER TABLE ${table} ADD COLUMN contact_id INTEGER`); } catch { /* anderer Prozess war schneller */ }
    }
  }
  const contacts = db.prepare("SELECT id,profile_url,full_name FROM contacts").all() as Array<{ id: number; profile_url: string; full_name: string | null }>;
  let profiles = 0;
  for (const contact of contacts) {
    if (linkContactIdentity({ contactId: contact.id, value: contact.profile_url, type: "profile_url", confidence: "confirmed", source: "contacts", participant: contact.full_name || "" })) profiles++;
  }

  let threads = 0;
  const drafts = db.prepare("SELECT id,thread_url,participant FROM drafts WHERE thread_url IS NOT NULL AND trim(thread_url)<>'' ORDER BY id")
    .all() as Array<{ id: number; thread_url: string; participant: string | null }>;
  for (const row of drafts) {
    if (identityType(row.thread_url) === "external_url") continue;
    if (bindStoredRow("drafts", row.id, row.thread_url, row.participant || "")) threads++;
  }

  if (tableExists("conversations")) {
    const rows = db.prepare("SELECT thread_url,participant FROM conversations").all() as Array<{ thread_url: string; participant: string | null }>;
    for (const row of rows) if (bindStoredRow("conversations", row.thread_url, row.thread_url, row.participant || "")) threads++;
  }
  if (tableExists("agent_conversations")) {
    const rows = db.prepare("SELECT thread_url,teilnehmer FROM agent_conversations").all() as Array<{ thread_url: string; teilnehmer: string | null }>;
    for (const row of rows) if (bindStoredRow("agent_conversations", row.thread_url, row.thread_url, row.teilnehmer || "")) threads++;
  }
  if (tableExists("agent_messages") && columnExists("agent_messages", "contact_id")) {
    db.exec(`UPDATE agent_messages SET contact_id=(
      SELECT i.contact_id FROM contact_identities i
       WHERE i.identity_type='thread_url' AND i.normalized_value=replace(rtrim(agent_messages.thread_url,'/'),'https://de.linkedin.com','https://www.linkedin.com')
       LIMIT 1
    ) WHERE contact_id IS NULL`);
  }
  const unresolved = (db.prepare("SELECT COUNT(*) n FROM contact_identity_conflicts WHERE status='open'").get() as { n: number }).n;
  return { profiles, threads, unresolved };
}

export function contactIdentityHealth() {
  const row = db.prepare(
    `SELECT COUNT(DISTINCT CASE WHEN identity_type='profile_url' THEN contact_id END) contacts_linked,
            COUNT(DISTINCT CASE WHEN identity_type='thread_url' THEN normalized_value END) threads_linked
       FROM contact_identities`,
  ).get() as { contacts_linked: number; threads_linked: number };
  const conflicts = db.prepare(
    `SELECT COUNT(*) unresolved,
            SUM(CASE WHEN candidate_contact_ids IS NOT NULL AND candidate_contact_ids NOT IN ('','[]') THEN 1 ELSE 0 END) ambiguous,
            SUM(CASE WHEN candidate_contact_ids IS NULL OR candidate_contact_ids IN ('','[]') THEN 1 ELSE 0 END) orphaned
       FROM contact_identity_conflicts WHERE status='open'`,
  ).get() as { unresolved: number; ambiguous: number | null; orphaned: number | null };
  return { ...row, unresolved: conflicts.unresolved, ambiguous: conflicts.ambiguous || 0, orphaned: conflicts.orphaned || 0 };
}

export function resolveIdentityConflict(conflictId: number, contactId: number): boolean {
  const conflict = db.prepare(
    `SELECT id,identity_type,identity_value,participant,candidate_contact_ids
       FROM contact_identity_conflicts WHERE id=? AND status='open'`,
  ).get(conflictId) as { id: number; identity_type: IdentityType; identity_value: string; participant: string | null; candidate_contact_ids: string | null } | undefined;
  if (!conflict || !db.prepare("SELECT 1 FROM contacts WHERE id=?").get(contactId)) return false;
  let candidates: number[] = [];
  try { candidates = JSON.parse(conflict.candidate_contact_ids || "[]") as number[]; } catch { /* ungueltiger Altwert */ }
  if (candidates.length && !candidates.includes(contactId)) return false;
  const linked = linkContactIdentity({
    contactId,
    value: conflict.identity_value,
    type: conflict.identity_type,
    confidence: "confirmed",
    source: "manual_resolution",
    participant: conflict.participant || "",
  });
  if (linked) db.prepare("UPDATE contact_identity_conflicts SET status='resolved',last_seen_at=datetime('now') WHERE id=?").run(conflictId);
  return linked;
}
