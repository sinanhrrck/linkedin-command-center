import { generateClaude, claudeAvailable } from "./claude.js";

/**
 * ZENTRALER Text-Kanal für alle Entwürfe (Notiz, Erstnachricht, Follow-up, DM-Antwort).
 *
 * NUR NOCH CLAUDE (Sinans Vorgabe 2026-07-26): Gemini ist aus dem Bot entfernt. Das
 * Gemini-Free-Limit (~20/Tag) hatte die Pipeline gedrosselt und stille Aussetzer verursacht.
 * Mit dem günstigen Haiku-Modell ist Claude für alle Texte die verlässliche, einheitliche Wahl.
 */

/**
 * Prompt → Text. NUR NOCH CLAUDE (Sinans Vorgabe 2026-07-26: Gemini komplett raus).
 *
 * Grund: das Gemini-Free-Limit (~20/Tag) hat die ganze Pipeline gedrosselt und zu stillen
 * Aussetzern geführt (Follow-ups/Erstnachrichten entstanden nicht). Mit dem günstigen Haiku
 * (config.llm.model, ~1-2 Cent/Nachricht) ist Claude für ALLE Texte die verlässliche Wahl.
 * Gemini-Code bleibt im Repo (gemini.ts) für Tests, wird hier aber nicht mehr aufgerufen.
 * Wirft, wenn kein Claude-Key gesetzt ist – der Aufrufer entscheidet dann (Entwurf/Retry).
 */
type TextGenerator = (prompt: string) => Promise<string>;
let testGenerator: TextGenerator | null = null;

/**
 * NUR FÜR TESTS: ersetzt den KI-Kanal durch eine feste Antwort. Ohne diesen Haken müssten
 * Tests, die die Entwurfs-Pipeline durchlaufen, entweder echte (kostenpflichtige) Aufrufe
 * machen oder sich auf einen stillen Fallback verlassen. Genau so ein Fallback hat am
 * 17.08.2026 unbearbeitete Vorlagen an echte Kontakte durchgelassen.
 */
export function setTextGeneratorForTests(fn: TextGenerator | null): void {
  testGenerator = fn;
}

export async function generateText(prompt: string): Promise<string> {
  if (testGenerator) return testGenerator(prompt);
  if (!claudeAvailable())
    throw new Error("Kein ANTHROPIC_API_KEY gesetzt – Textgenerierung braucht jetzt Claude (Gemini wurde entfernt).");
  return generateClaude(prompt);
}
