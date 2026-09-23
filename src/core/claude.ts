import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

/**
 * Bezahlter KI-Kanal (Anthropic/Claude). Bewusst getrennt vom Gemini-Free-Tier.
 * NUR der Voll-Autopilot (converseStep) nutzt diesen Kanal – so bleibt das Guthaben
 * geschont, solange du im Manuell/Halb-Modus testest.
 *
 * Wird kein ANTHROPIC_API_KEY gesetzt, ist der Client null und der Aufrufer fällt
 * automatisch auf Gemini zurück (siehe personalize.generateAutopilot).
 */
const client = config.llm.anthropicKey ? new Anthropic({ apiKey: config.llm.anthropicKey }) : null;

/** Steht der bezahlte Claude-Kanal bereit? (Key vorhanden) */
export function claudeAvailable(): boolean {
  return client !== null;
}

/**
 * Ein Prompt → Text über Claude. Sparsam einsetzen (kostet echtes Geld).
 * Kein Thinking (kurze Chat-Antwort, spart Tokens); der Prompt fordert reines JSON,
 * das der Aufrufer robust herausschneidet.
 */
export async function generateClaude(prompt: string, maxTokens = 1024): Promise<string> {
  if (!client) throw new Error("ANTHROPIC_API_KEY fehlt – Claude-Kanal nicht verfügbar");
  const res = await client.messages.create({
    model: config.llm.model,
    // 1024 reicht für eine Nachricht; Sammel-Antworten (z. B. 20 Lead-Bewertungen als JSON)
    // brauchen mehr, sonst wird mitten im Array abgeschnitten (real 2026-09-23).
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  const block = res.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text.trim() : "";
}
