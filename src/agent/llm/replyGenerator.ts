/**
 * ANTWORT-CALL (Call 2 der Pipeline). Baut den modularen Antwort-Prompt (aus State/Profil/
 * Memory/Stil) und lässt die KI Sinans nächste Nachricht schreiben.
 *
 * KI wieder als Parameter (DI): der Orchestrator wählt hier den STARKEN Kanal (Claude im
 * Vollmodus), während die Analyse auf dem günstigen laufen kann. `saubern` putzt das Format
 * (Anführungszeichen/Emoji-Overkill/Bindestrich-Floskeln) – die inhaltliche Prüfung macht später
 * der Response Validator (Phase 3).
 */
import { saubern } from "../../context.js";
import { buildReplyPrompt, type ReplyPromptInput } from "../prompt/promptBuilder.js";
import type { LlmFn } from "./analyzer.js";

export async function generateReply(input: ReplyPromptInput, llm: LlmFn): Promise<string> {
  const roh = await llm(buildReplyPrompt(input));
  return saubern(roh || "");
}
