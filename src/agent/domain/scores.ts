/**
 * LEAD-SCORES – mehrere, jeder mit eigener Bedeutung, alle 0..100.
 *
 * Bewusst DETERMINISTISCH aus dem Profil + Gesprächskontext berechnet, NICHT von der KI geraten.
 * Vorteil: erklärbar, stabil, kostenlos, und die Risk/State-Engine kann sich darauf verlassen.
 * Diese Scores – nicht das Bauchgefühl des Prompts – bestimmen den nächsten Schritt.
 */
import type { PsychProfile } from "./profile.js";

export interface Scores {
  trust: number;                 // Vertrauen: darf ich näher ran?
  interest: number;              // echtes Interesse am Thema
  callReadiness: number;         // reif für ein Telefonat?
  ghostingRisk: number;          // Risiko, dass die Person abspringt
  conversationQuality: number;   // wie lebendig ist der Dialog?
  conversionProbability: number; // grobe End-Wahrscheinlichkeit (Termin)
}

export interface ScoreKontext {
  nachrichtenGesamt: number;   // wie viele Nachrichten im Thread
  antwortenDerPerson: number;  // wie oft die Person geantwortet hat
  letzteAntwortVorH: number | null; // Stunden seit letzter Antwort der Person
  offeneNachfragen: number;    // unsere Nachrichten ohne Antwort in Folge
}

const pct = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 100);

export function computeScores(p: PsychProfile, k: ScoreKontext): Scores {
  // Trust: direktes Vertrauen minus Skepsis, gestützt durch Offenheit + gelebte Dialogtiefe.
  const dialogTiefe = Math.min(1, k.antwortenDerPerson / 5);
  const trust = 0.55 * p.trust + 0.2 * p.openness + 0.25 * dialogTiefe - 0.35 * p.skepticism;

  // Interest: die drei Interessens-Dimensionen + positive Reaktivität (lange, schnelle Antworten).
  const reaktiv = 0.5 * p.responseLength + 0.5 * (p.responseSpeedMin == null ? 0.4 : Math.max(0, 1 - p.responseSpeedMin / 240));
  // Interesse wird vom STÄRKSTEN Interessens-Signal getragen (wer nur an Geld interessiert ist,
  // soll nicht dafür bestraft werden, dass „Karriere" 0 ist), plus Reaktivität.
  const interest = 0.6 * Math.max(p.moneyInterest, p.investmentInterest, p.careerInterest) + 0.4 * reaktiv;

  // CallReadiness: braucht Vertrauen UND Interesse UND Reife. Geometrisches Mittel von Trust &
  // Interest – belohnt Balance, bestraft Schieflage (hoher Trust bei null Interesse bleibt niedrig),
  // ohne so hart zu deckeln wie ein reines Produkt. Mal Gesprächsreife.
  const reife = Math.min(1, k.antwortenDerPerson / 4);
  const tc = Math.max(0, Math.min(1, trust)), ic = Math.max(0, Math.min(1, interest));
  const callReadiness = Math.sqrt(tc * ic) * reife;

  // GhostingRisk: lange keine Antwort + viele offene Nachfragen + sinkende Reaktivität.
  const stille = k.letzteAntwortVorH == null ? 0 : Math.min(1, k.letzteAntwortVorH / 72);
  const ghostingRisk = Math.min(1, 0.5 * stille + 0.35 * Math.min(1, k.offeneNachfragen / 2) + 0.15 * (1 - reaktiv));

  // ConversationQuality: Länge des echten Austauschs + Reaktivität + etwas Humor/Extroversion.
  const conversationQuality = Math.min(1, 0.5 * dialogTiefe + 0.3 * reaktiv + 0.2 * ((p.humor + p.extroversion) / 2));

  // ConversionProbability: grobe Kombi aus CallReadiness und Qualität, gedämpft durch Ghosting.
  const conversionProbability = Math.max(0, callReadiness * 0.7 + conversationQuality * 0.3) * (1 - 0.5 * ghostingRisk);

  return {
    trust: pct(trust), interest: pct(interest), callReadiness: pct(callReadiness),
    ghostingRisk: pct(ghostingRisk), conversationQuality: pct(conversationQuality),
    conversionProbability: pct(conversionProbability),
  };
}
