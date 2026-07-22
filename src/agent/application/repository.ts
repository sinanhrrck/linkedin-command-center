/**
 * CONVERSATION REPOSITORY – die Persistenz-Grenze (Ports & Adapters).
 *
 * Die Application-Schicht kennt nur dieses Interface, nicht SQLite. Dadurch bleibt der
 * Orchestrator testbar (In-Memory) und die DB-Anbindung ist austauschbar. Der SQLite-Adapter
 * (neue Tabellen agent_conversations/agent_messages) folgt beim Umschalten in Phase 5.
 */
import type { Conversation } from "../domain/conversation.js";

export interface ConversationRepository {
  load(threadUrl: string): Promise<Conversation | null>;
  save(c: Conversation): Promise<void>;
}

/** Einfache In-Memory-Umsetzung – für Tests und den Trockenlauf. */
export class InMemoryConversationRepository implements ConversationRepository {
  private store = new Map<string, Conversation>();
  async load(threadUrl: string): Promise<Conversation | null> {
    return this.store.get(threadUrl) ?? null;
  }
  async save(c: Conversation): Promise<void> {
    this.store.set(c.threadUrl, structuredClone(c));
  }
}
