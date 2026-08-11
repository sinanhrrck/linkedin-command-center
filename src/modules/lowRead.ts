import { createHash } from "node:crypto";
import { db, getState, setState } from "../db/index.js";
import { leseStand } from "../core/leseBudget.js";

const hash = (value: string) => createHash("sha256").update(value.trim().toLowerCase()).digest("hex").slice(0, 24);

export function recordReadSaving(kind: "thread_cache" | "profile_retry" | "schedule", count = 1): void {
  if (count <= 0) return;
  db.prepare(
    `INSERT INTO read_savings(day,kind,count) VALUES(date('now','localtime'),?,?)
     ON CONFLICT(day,kind) DO UPDATE SET count=count+excluded.count`,
  ).run(kind, Math.round(count));
}

/** Öffnet neue/veränderte Chats sofort; unveränderte Vorschauen höchstens alle 90 Minuten. */
export function shouldOpenConversation(participant: string, snippet: string, unread: boolean, theirTurn: boolean | null, allowSkip = true) {
  const participantKey = hash(participant || "unbekannt");
  const snippetHash = hash(`${snippet}|${unread ? 1 : 0}|${theirTurn === null ? "?" : theirTurn ? 1 : 0}`);
  const cached = db.prepare(
    `SELECT thread_url,snippet_hash,last_opened_at,
            CASE WHEN thread_url IS NOT NULL AND EXISTS(
              SELECT 1 FROM drafts d WHERE d.thread_url=inbox_scan_cache.thread_url
                AND d.status IN ('pending','approved','sending')
            ) THEN 1 ELSE 0 END has_open_draft
       FROM inbox_scan_cache WHERE participant_key=?`,
  ).get(participantKey) as { thread_url: string | null; snippet_hash: string; last_opened_at: string; has_open_draft: number } | undefined;
  const same = cached?.snippet_hash === snippetHash;
  const recent = !!cached && (db.prepare("SELECT ? >= datetime('now','-90 minutes') ok").get(cached.last_opened_at) as { ok: number }).ok === 1;
  const open = !allowSkip || !same || (!recent && !cached?.has_open_draft);
  if (!open) {
    recordReadSaving("thread_cache");
    db.prepare("UPDATE inbox_scan_cache SET last_seen_at=datetime('now') WHERE participant_key=?").run(participantKey);
  }
  return { open, participantKey, snippetHash };
}

export function rememberConversationPreview(participantKey: string, snippetHash: string, threadUrl: string, theirTurn: boolean): void {
  db.prepare(
    `INSERT INTO inbox_scan_cache(participant_key,snippet_hash,thread_url,their_turn,last_opened_at,last_seen_at)
     VALUES(?,?,?,?,datetime('now'),datetime('now'))
     ON CONFLICT(participant_key) DO UPDATE SET snippet_hash=excluded.snippet_hash,
       thread_url=excluded.thread_url,their_turn=excluded.their_turn,last_opened_at=datetime('now'),last_seen_at=datetime('now')`,
  ).run(participantKey, snippetHash, threadUrl, theirTurn ? 1 : 0);
}

/** Verhindert, dass ein Profil ohne Vernetzen-Knopf alle zwölf Minuten erneut geöffnet wird. */
export function deferProfile(profileUrl: string, reason: string, days = 7): void {
  db.prepare("UPDATE contacts SET retry_after=datetime('now',?),retry_reason=? WHERE profile_url=?")
    .run(`+${Math.max(1, days)} days`, reason.slice(0, 120), profileUrl);
}

export function readSavingsToday() {
  const rows = db.prepare("SELECT kind,count FROM read_savings WHERE day=date('now','localtime')").all() as Array<{ kind: string; count: number }>;
  const byKind = Object.fromEntries(rows.map((row) => [row.kind, row.count]));
  return { total: rows.reduce((sum, row) => sum + row.count, 0), byKind };
}

/** Persistenter Takt über Neustarts: häufiges App-Öffnen löst nicht jedes Mal alle Leseläufe aus. */
export async function runReadJobWhenDue<T>(key: string, minutes: number, job: () => Promise<T>): Promise<T | null> {
  const stateKey = `low_read_last_${key}`;
  const last = getState(stateKey);
  if (last && Date.now() - new Date(last).getTime() < minutes * 60_000) {
    recordReadSaving("schedule");
    return null;
  }
  // Ein erreichtes Tagesbudget ist ein geplanter Wartezustand, kein fehlgeschlagener Job.
  // Den Job gar nicht erst starten: So entstehen weder rote Fehler noch unnötige Browserstarts.
  if (leseStand().erschoepft) {
    recordReadSaving("schedule");
    return null;
  }
  const result = await job();
  setState(stateKey, new Date().toISOString());
  return result;
}
