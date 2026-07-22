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
    `);
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
