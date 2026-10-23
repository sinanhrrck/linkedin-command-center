import { config } from "../../config.js";
import { generateText } from "../../core/textLlm.js";
import { generateClaude, claudeAvailable } from "../../core/claude.js";
import { vertriebswissen } from "../../core/vertriebswissen.js";

/**
 * KI-Kanäle für den Agent. WICHTIG (Fix 2026-07-24): BEIDE Schritte (Analyse UND Antwort) laufen
 * über Claude, sobald ein bezahlter Key konfiguriert ist. Vorher nutzte die Analyse immer das
 * kostenlose Gemini (~20 Aufrufe/Tag, geteilt mit Erstnachrichten) → nach wenigen Gesprächen war
 * das Kontingent leer und der Agent konnte NICHTS mehr analysieren = "der Agent macht nichts".
 * Der Voll-Auto-Agent ist ohnehin der bezahlte Pfad; ohne Claude-Key fällt beides auf Gemini zurück.
 */
const claudeAn = () => config.llm.autopilotProvider === "claude" && claudeAvailable();
// Vertriebswissen als gecachter System-Block – für Analyse UND Antwort derselbe Text, damit der
// Cache zwischen beiden Aufrufen trifft. Es ändert keine Regel des Agenten (core/vertriebswissen.ts).
const wissen = () => vertriebswissen("gespraech") || undefined;
export const analyzeLlm = (p: string) => (claudeAn() ? generateClaude(p, undefined, wissen()) : generateText(p, undefined, wissen()));
export const replyLlm = (p: string) => (claudeAn() ? generateClaude(p, undefined, wissen()) : generateText(p, undefined, wissen()));
