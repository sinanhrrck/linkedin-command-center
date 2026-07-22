/**
 * ANALYSE-VERTRAG – das Ergebnis des ersten LLM-Calls (Analyse), Eingang der Pipeline.
 *
 * Trennt sauber: die KI LIEST und extrahiert (dieser Vertrag), die DOMÄNE ENTSCHEIDET
 * (State/Scores/Risk, alles deterministisch). Der zweite LLM-Call (Antwort) bekommt später
 * NUR das domänenseitig Beschlossene (Ziel + Stil + Kontext) – kein Monster-Prompt.
 */
import type { IntentSet } from "./intent.js";
import type { ProfileObservation } from "./profile.js";

/** Fakten, die die Analyse aus der Nachricht zieht → fließen ins Gedächtnis (Memory). */
export interface ExtrahierteFakten {
  alter?: number | null;
  studiumOderAusbildung?: string | null;
  beruf?: string | null;
  ziele?: string | null;
  einwaende?: string | null;
  themen?: string | null; // worüber gerade gesprochen wird
}

/** Genau das, was der Analyse-Call zurückgeben MUSS (strukturiert, validierbar). */
export interface AnalysisResult {
  intents: IntentSet;                 // mehrere gleichzeitig möglich
  signale: ProfileObservation;        // Profil-Beobachtungen (0..1 je Dimension, null = kein Signal)
  fakten: ExtrahierteFakten;          // fürs Memory
  kontakt: string | null;             // genannte Telefonnummer/E-Mail, sonst null
  zusammenfassung: string;            // 1–2 Sätze: worum geht es gerade
}

/** Fällt die Analyse aus (KI-Fehler), eskaliert der Orchestrator an den Menschen. */
export function leereAnalyse(): AnalysisResult {
  return { intents: [], signale: {}, fakten: {}, kontakt: null, zusammenfassung: "" };
}
