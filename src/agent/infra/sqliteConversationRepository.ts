/**
 * SQLITE-ADAPTER des ConversationRepository (Ports & Adapters).
 *
 * Persistiert den GELERNTEN Zustand pro Lead (Stage/Profil/Memory/Scores/Status), damit der
 * Agent nach einem App-Neustart nicht bei null anfängt. Eigene Tabellen (agent_*) – der alte
 * Bot bleibt unberührt. Die DB wird hereingereicht (DI) → testbar mit einer :memory:-DB,
 * keine Kopplung an die globale App-DB. Zusätzlich eine messages-Tabelle für Audit/Learning.
 */
import type DatabaseType from "better-sqlite3";
import type { Conversation, ConvStatus } from "../domain/conversation.js";
import type { ConversationRepository } from "../application/repository.js";
import type { Stage } from "../domain/state.js";

type Row = {
  thread_url: string; teilnehmer: string; stage: string;
  profile: string; memory: string; scores: string; status: string;
};

export class SqliteConversationRepository implements ConversationRepository {
  constructor(private db: DatabaseType.Database) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_conversations (
        thread_url TEXT PRIMARY KEY,
        teilnehmer TEXT,
        stage      TEXT NOT NULL,
        profile    TEXT NOT NULL,
        memory     TEXT NOT NULL,
        scores     TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'aktiv',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS agent_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_url TEXT NOT NULL,
        sender     TEXT,
        text       TEXT NOT NULL,
        intents    TEXT,
        ts         TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_messages_thread ON agent_messages(thread_url);
      CREATE TABLE IF NOT EXISTS agent_processed (
        thread_url    TEXT PRIMARY KEY,
        incoming_hash TEXT NOT NULL,   -- Fingerabdruck der zuletzt verarbeiteten EINGEGANGENEN Nachricht
        decision      TEXT NOT NULL,   -- 'senden' | 'eskalieren' | 'nichts'
        reply_text    TEXT,            -- die erzeugte Antwort (für erneuten Sendeversuch OHNE neuen KI-Aufruf)
        sent          INTEGER NOT NULL DEFAULT 0,
        ts            TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS agent_outcomes (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_url    TEXT NOT NULL,
        teilnehmer    TEXT,
        ergebnis      TEXT NOT NULL,   -- 'gebucht' | 'verloren' | 'eskaliert'
        letzter_state TEXT,
        nachrichten   INTEGER,
        trust         INTEGER,
        interest      INTEGER,
        ts            TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  /** LEARNING: Ergebnis eines Gesprächs festhalten (Grundlage für spätere Optimierung). */
  recordOutcome(o: { threadUrl: string; teilnehmer: string; ergebnis: string; letzterState: string; nachrichten: number; trust: number; interest: number }): void {
    this.db.prepare(
      "INSERT INTO agent_outcomes(thread_url, teilnehmer, ergebnis, letzter_state, nachrichten, trust, interest) VALUES(?,?,?,?,?,?,?)",
    ).run(o.threadUrl, o.teilnehmer, o.ergebnis, o.letzterState, o.nachrichten, o.trust, o.interest);
  }

  /** Aggregat der letzten 30 Tage (fürs Learning-Dashboard/Reporting). */
  lernStatistik(): { ergebnis: string; anzahl: number; oemNachrichten: number }[] {
    return this.db.prepare(
      `SELECT ergebnis, COUNT(*) AS anzahl, ROUND(AVG(nachrichten),1) AS oemNachrichten
         FROM agent_outcomes WHERE ts >= datetime('now','-30 days') GROUP BY ergebnis ORDER BY anzahl DESC`,
    ).all() as { ergebnis: string; anzahl: number; oemNachrichten: number }[];
  }

  async load(threadUrl: string): Promise<Conversation | null> {
    const r = this.db.prepare("SELECT * FROM agent_conversations WHERE thread_url=?").get(threadUrl) as Row | undefined;
    if (!r) return null;
    return {
      threadUrl: r.thread_url,
      teilnehmer: r.teilnehmer,
      stage: r.stage as Stage,
      profile: JSON.parse(r.profile),
      memory: JSON.parse(r.memory),
      scores: JSON.parse(r.scores),
      status: r.status as ConvStatus,
    };
  }

  async save(c: Conversation): Promise<void> {
    this.db.prepare(
      `INSERT INTO agent_conversations(thread_url, teilnehmer, stage, profile, memory, scores, status, updated_at)
       VALUES(?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(thread_url) DO UPDATE SET
         teilnehmer=excluded.teilnehmer, stage=excluded.stage, profile=excluded.profile,
         memory=excluded.memory, scores=excluded.scores, status=excluded.status, updated_at=datetime('now')`,
    ).run(c.threadUrl, c.teilnehmer, c.stage, JSON.stringify(c.profile), JSON.stringify(c.memory), JSON.stringify(c.scores), c.status);
  }

  /**
   * IDEMPOTENZ-SPERRE gegen die Geld-Schleife. Merkt sich pro Thread, welche eingegangene Nachricht
   * schon durch die (teure) KI-Pipeline lief, WAS entschieden wurde und die erzeugte Antwort. So
   * wird pro NEUER Nachricht der Person genau EINMAL Claude aufgerufen. Ist der Versand nur
   * vorübergehend blockiert (Governor: Arbeitszeit/Limit), kann derselbe Text später erneut
   * gesendet werden – OHNE neuen KI-Aufruf.
   */
  verarbeitungsStand(threadUrl: string): { incomingHash: string; decision: string; replyText: string | null; sent: boolean } | null {
    const r = this.db.prepare("SELECT incoming_hash, decision, reply_text, sent FROM agent_processed WHERE thread_url=?").get(threadUrl) as
      | { incoming_hash: string; decision: string; reply_text: string | null; sent: number }
      | undefined;
    return r ? { incomingHash: r.incoming_hash, decision: r.decision, replyText: r.reply_text, sent: !!r.sent } : null;
  }
  merkeVerarbeitung(threadUrl: string, incomingHash: string, decision: string, replyText: string | null): void {
    this.db.prepare(
      `INSERT INTO agent_processed(thread_url, incoming_hash, decision, reply_text, sent, ts)
       VALUES(?,?,?,?,0,datetime('now'))
       ON CONFLICT(thread_url) DO UPDATE SET incoming_hash=excluded.incoming_hash, decision=excluded.decision, reply_text=excluded.reply_text, sent=0, ts=datetime('now')`,
    ).run(threadUrl, incomingHash, decision, replyText);
  }
  markiereGesendet(threadUrl: string): void {
    this.db.prepare("UPDATE agent_processed SET sent=1 WHERE thread_url=?").run(threadUrl);
  }

  /** Audit/Learning: eine Nachricht protokollieren (nicht Teil des Ports, adapter-spezifisch). */
  saveMessage(threadUrl: string, sender: string, text: string, intents?: string[]): void {
    this.db.prepare("INSERT INTO agent_messages(thread_url, sender, text, intents) VALUES(?,?,?,?)")
      .run(threadUrl, sender, text, intents ? JSON.stringify(intents) : null);
  }

  /** Die letzten n Nachrichten eines Threads (für Audit/Nachschau). */
  recentMessages(threadUrl: string, n = 20): { sender: string; text: string }[] {
    return this.db.prepare("SELECT sender, text FROM agent_messages WHERE thread_url=? ORDER BY id DESC LIMIT ?")
      .all(threadUrl, n).reverse() as { sender: string; text: string }[];
  }
}
