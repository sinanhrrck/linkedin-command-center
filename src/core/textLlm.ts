import { generate } from "./gemini.js";
import { generateClaude, claudeAvailable } from "./claude.js";
import { config } from "../config.js";
import { events } from "./events.js";

/**
 * ZENTRALER Text-Kanal für alle Entwürfe (Notiz, Erstnachricht, Follow-up, DM-Antwort).
 *
 * Reihenfolge: Gemini (GRATIS) zuerst. Nur wenn Gemini ausfällt, springt Claude (BEZAHLT)
 * ein – und NUR mit vorheriger Telegram-Meldung, damit Sinan weiß, wann sein Guthaben
 * angefasst wird. Grund für die Existenz: Gemini lieferte am 2026-07-16 durchgehend 503
 * (Google-seitiger Ausfall), der Bot stand still, obwohl ein bezahlter Key bereitlag.
 *
 * Der Autopilot (converseStep) nutzt diesen Weg NICHT – der geht direkt zu Claude
 * (siehe personalize.generateAutopilot), weil er im Voll-Modus ohnehin bezahlt läuft.
 */

/** Seit wann klemmt Gemini? null = läuft. Für die "wieder da"-Meldung. */
let geminiKaputtSeit: number | null = null;
/** Wann wurde zuletzt gemeldet? Verhindert Meldungs-Spam bei jedem einzelnen Aufruf. */
let letzteMeldung = 0;
const MELDE_ABSTAND_MS = 60 * 60 * 1000; // höchstens 1 Umschalt-Meldung pro Stunde

/** Fehlermeldung auf eine lesbare Kurzform bringen (z.B. "503 Service Unavailable"). */
function kurzerGrund(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  const code = m.match(/\[(\d{3}) ([^\]\]]+)\]/) ?? m.match(/(\d{3}) (Service Unavailable|Too Many Requests)/);
  if (code) return `${code[1]} ${code[2]}`;
  if (/429|quota|rate/i.test(m)) return "Tageslimit erreicht (429)";
  return m.split("\n")[0].slice(0, 70);
}

/**
 * Prompt → Text. Gratis wenn möglich, bezahlt nur im Notfall.
 * Wirft, wenn beide Kanäle ausfallen – der Aufrufer entscheidet dann (Entwurf/Retry).
 */
export async function generateText(prompt: string): Promise<string> {
  try {
    const text = await generate(prompt);
    // Gemini ist wieder da → einmalig Entwarnung geben (Guthaben wird wieder geschont).
    if (geminiKaputtSeit !== null) {
      const minuten = Math.round((Date.now() - geminiKaputtSeit) / 60000);
      geminiKaputtSeit = null;
      letzteMeldung = 0;
      events.emit("llm:zurueck", { minuten });
    }
    return text;
  } catch (e) {
    // Kein Claude verfügbar oder Fallback abgeschaltet → Fehler durchreichen wie bisher.
    if (!config.llm.fallbackToClaude || !claudeAvailable()) throw e;

    if (geminiKaputtSeit === null) geminiKaputtSeit = Date.now();
    // MELDUNG VOR dem bezahlten Aufruf – Sinans ausdrücklicher Wunsch: er will wissen,
    // dass jetzt Geld fließt, bevor es fließt. events.emit ist synchron, die Meldung ist
    // also raus, bevor Claude überhaupt angefragt wird.
    if (Date.now() - letzteMeldung > MELDE_ABSTAND_MS) {
      letzteMeldung = Date.now();
      events.emit("llm:fallback", { grund: kurzerGrund(e), modell: config.llm.model });
    }
    console.warn(`[llm] Gemini aus (${kurzerGrund(e)}) → weiche auf Claude aus (kostenpflichtig).`);
    return generateClaude(prompt);
  }
}
