import { getState, setState } from "../db/index.js";
import { promptKontext } from "../context.js";
import { trainingsRegelnBlock } from "./trainingsRegeln.js";

/**
 * AUSRICHTUNG (2026-10-23, Sinan: „Der Bot soll per Knopfdruck komplett auf AEC umgebaut werden“).
 *
 * EIN Schalter `standard` ↔ `aec` (State `ausrichtung`). Bei `aec` führt JEDES Gespräch – auch jedes
 * laufende – nur noch zur kostenlosen Potenzialanalyse (AEC) mit Auswertungsgespräch. Kein
 * Finanz-Beratungstermin, kein Vertriebspartner-/Nebenverdienst-Weg.
 *
 * Bewusst NUR eine Laufzeit-Weiche, keine Änderung an profil.local.json, Zielgruppen oder Kampagnen:
 * Zurückschalten stellt dadurch den alten Stand exakt wieder her, ohne dass irgendetwas gesichert
 * werden muss. Erstnachricht, Nachfassen, Reaktivierung und Lead-Suche bleiben unberührt (Sinans
 * Vorgabe) – die Weiche greift nur dort, wo auf eine Nachricht der Person geantwortet wird.
 */

export const AUSRICHTUNGEN = ["standard", "aec"] as const;
export type Ausrichtung = (typeof AUSRICHTUNGEN)[number];

export const istAusrichtung = (v: unknown): v is Ausrichtung =>
  typeof v === "string" && (AUSRICHTUNGEN as readonly string[]).includes(v);

export function getAusrichtung(): Ausrichtung {
  const v = getState("ausrichtung");
  return istAusrichtung(v) ? v : "standard";
}

export function setAusrichtung(a: Ausrichtung): void {
  setState("ausrichtung", a);
}

export const aecAktiv = (): boolean => getAusrichtung() === "aec";

/**
 * Prompt-Baustein für Gesprächsantworten. Leer im Standard → Prompts byte-gleich zu vorher.
 * Steht HINTER dem Profil-Kontext und erklärt ausdrücklich seinen Vorrang, weil „Ziel der Nachricht“
 * im Profil weiterhin zwei Wege (Analyse ODER Finanzberatung) beschreibt.
 */
export function ausrichtungsBlock(a: Ausrichtung = getAusrichtung()): string {
  if (a !== "aec") return "";
  return `
# AUSRICHTUNG: AEC (hat Vorrang vor "Ziel der Nachricht" und "Dein Angebot" oben)
Jedes Gespräch hat gerade genau EIN Ziel: die kostenlose Potenzialanalyse (intern "AEC") mit anschließendem Auswertungsgespräch.
- Der Person gegenüber heißt sie "Potenzialanalyse", nie "AEC".
- Biete KEIN Finanz- oder Beratungsgespräch an, keinen Gehalts-Check, keine Zusammenarbeit, keinen Nebenverdienst, keine Vertriebspartnerschaft. Keine Rechnung mit Stundenlohn oder Verdienst.
- Bringt die Person Geld- oder Finanzfragen ein: kurz und ehrlich darauf eingehen, im Chat nichts beraten, keinen eigenen Finanztermin anbieten. Passt es natürlich, schlag den Bogen zur Analyse (Klarheit über die eigenen Stärken und den eigenen Weg); sonst bleib einfach im Gespräch.
- Das Timing bleibt: erst verdienen, dann anbieten. Ohne Signal kein Angebot.
- Sagt die Person ja: Zusage festhalten und einen Termin fürs Auswertungsgespräch klären. Den Zugangscode schickt Sinan selbst.
`;
}

/**
 * Profil-Kontext + Ausrichtung + freigegebene Trainings-Lehren. Für ALLE Antworten in Gesprächen,
 * nie für Erstkontakt/Nachfassen. Echte Gespräche und der Trainings-Simulator lesen dieselbe Funktion
 * – so trainiert man genau den Bot, der auch live antwortet.
 */
export function gespraechsKontext(): string {
  return promptKontext() + ausrichtungsBlock() + trainingsRegelnBlock("gespraech");
}
