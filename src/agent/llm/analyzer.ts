/**
 * ANALYSE-CALL (Call 1 der Pipeline). Liest den Verlauf, liefert den AnalysisResult-Vertrag.
 *
 * Die KI-Funktion wird HEREINGEREICHT (Dependency Injection) – so kann der Orchestrator den
 * günstigen Kanal (Gemini) wählen, und Tests laufen mit einer Fake-KI ohne echten Verbrauch.
 * Defensiv: alles, was die KI liefert, wird gegen die Domäne validiert (kein Halluzinations-Leck).
 */
import type { AnalysisResult } from "../domain/analysis.js";
import { leereAnalyse } from "../domain/analysis.js";
import { saeubereIntents } from "../domain/intent.js";
import type { ProfileObservation } from "../domain/profile.js";
import { buildAnalysisPrompt } from "../prompt/promptBuilder.js";

export type Nachricht = { sender: string; text: string };
export type LlmFn = (prompt: string) => Promise<string>;

const clamp01 = (x: unknown): number | null =>
  typeof x === "number" && isFinite(x) ? Math.max(0, Math.min(1, x)) : null;

/** Rohe KI-Signale defensiv in eine ProfileObservation überführen (nur Zahlen/Bool durchlassen). */
function saeubereSignale(roh: unknown): ProfileObservation {
  const s = (roh ?? {}) as Record<string, unknown>;
  const out: ProfileObservation = {};
  for (const d of ["trust","skepticism","moneyInterest","careerInterest","investmentInterest","humor","extroversion","openness","financialKnowledge"] as const) {
    const v = clamp01(s[d]);
    if (v !== null) out[d] = v;
  }
  if (typeof s.responseLength === "number") out.responseLength = Math.max(0, s.responseLength);
  if (typeof s.responseSpeedMin === "number") out.responseSpeedMin = Math.max(0, s.responseSpeedMin);
  if (typeof s.emojiUsage === "boolean") out.emojiUsage = s.emojiUsage;
  return out;
}

function alsText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.toLowerCase() !== "null" ? t : null;
}

/** Führt die Analyse aus. Bei KI-/Parsing-Fehler: leere Analyse → Orchestrator eskaliert. */
export async function analyze(messages: Nachricht[], teilnehmer: string, llm: LlmFn): Promise<AnalysisResult> {
  const transcript = messages.map((m) => `${m.sender || "?"}: ${m.text}`).join("\n");
  try {
    const raw = await llm(buildAnalysisPrompt(transcript, teilnehmer));
    const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const p = JSON.parse(json) as Record<string, unknown>;
    const f = (p.fakten ?? {}) as Record<string, unknown>;
    return {
      intents: saeubereIntents(p.intents),
      signale: saeubereSignale(p.signale),
      fakten: {
        alter: typeof f.alter === "number" ? f.alter : null,
        studiumOderAusbildung: alsText(f.studiumOderAusbildung),
        beruf: alsText(f.beruf),
        ziele: alsText(f.ziele),
        einwaende: alsText(f.einwaende),
        themen: alsText(f.themen),
      },
      kontakt: alsText(p.kontakt),
      zusammenfassung: alsText(p.zusammenfassung) ?? "",
    };
  } catch {
    return leereAnalyse();
  }
}
