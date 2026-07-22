/**
 * CONVERSATION – das Aggregat, das der Agent pro Lead persistiert.
 *
 * Bewusst NUR der gelernte Zustand: Stage, Profil, Memory, Scores, Status. Alles Zählbare
 * (wie viele Nachrichten, wie viele Antworten, unsere letzten Nachrichten) leitet der
 * Orchestrator aus dem VERLAUF ab (eine Wahrheitsquelle = die messages), nicht doppelt gespeichert.
 */
import type { Stage } from "./state.js";
import type { PsychProfile } from "./profile.js";
import { leeresProfil } from "./profile.js";
import type { ConversationMemory } from "./memory.js";
import { leeresMemory } from "./memory.js";
import type { Scores } from "./scores.js";

export type ConvStatus = "aktiv" | "eskaliert" | "gebucht" | "verloren";

export interface Conversation {
  threadUrl: string;
  teilnehmer: string;
  stage: Stage;
  profile: PsychProfile;
  memory: ConversationMemory;
  scores: Scores;
  status: ConvStatus;
}

const nullScores: Scores = { trust: 0, interest: 0, callReadiness: 0, ghostingRisk: 0, conversationQuality: 0, conversionProbability: 0 };

export function neueConversation(threadUrl: string, teilnehmer: string, name: string | null = null): Conversation {
  return {
    threadUrl, teilnehmer,
    stage: "connection",
    profile: leeresProfil(),
    memory: leeresMemory(name ?? teilnehmer ?? null),
    scores: nullScores,
    status: "aktiv",
  };
}
