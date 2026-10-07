/**
 * ANTWORT-RISIKO (2026-10-07) – wie viel kann eine einzelne Agent-Antwort anrichten?
 *
 * Grundlage der Stufe „Gespräche vorsichtig“: der Agent sendet zuerst nur risikoarme Antworten
 * selbst und legt den Rest als Entwurf vor. Mit jeder unveränderten Freigabe wächst das Vertrauen
 * (modules/agentVertrauen.ts) und mehr Risiko-Klassen werden autonom. Reine Logik, testbar.
 */
import type { Stage } from "../state.js";
import type { IntentSet } from "../intent.js";

export type Risiko = "niedrig" | "mittel" | "hoch";
export const RISIKO_REIHENFOLGE: Risiko[] = ["niedrig", "mittel", "hoch"];

const HOCH_STAGES: ReadonlySet<Stage> = new Set(["einwand", "call_angebot", "nummer", "termin", "verloren", "abgeschlossen"]);
const MITTEL_STAGES: ReadonlySet<Stage> = new Set(["bedarf", "vertrauen", "validierung"]);

export function antwortRisiko(stage: Stage, intents: IntentSet): Risiko {
  // Einwände, Preisfragen, Abwehr und alles rund ums Angebot/den Termin: hier entscheidet der Ton
  // über den Lead. Erst, wenn Sinan viele solcher Antworten unverändert durchgewinkt hat.
  if (HOCH_STAGES.has(stage)) return "hoch";
  if (intents.some((i) => i === "skepsis" || i === "preisfrage" || i === "negatives_signal" || i === "ablehnung" || i === "bereits_kunde")) return "hoch";
  // Bedarfs- und Vertrauensphase: die Brücke zum Angebot wird gebaut – vertrieblich, aber noch kein Pitch.
  if (MITTEL_STAGES.has(stage)) return "mittel";
  if (intents.some((i) => i === "interesse" || i === "karriere_interesse" || i === "investment_interesse")) return "mittel";
  // Eröffnung, Smalltalk, erste Fragen: freundlich, kurz, kaum Schadenspotenzial.
  return "niedrig";
}

/** Klartext fürs Cockpit. */
export const RISIKO_LABEL: Record<Risiko, string> = {
  niedrig: "Eröffnung und Smalltalk",
  mittel: "Bedarf und Vertrauensaufbau",
  hoch: "Einwände, Angebot und Termin",
};
