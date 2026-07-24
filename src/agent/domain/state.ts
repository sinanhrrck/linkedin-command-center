/**
 * CONVERSATION STATE MACHINE – das Rückgrat des Agents.
 *
 * Der Bot arbeitet NICHT linear. Jede Unterhaltung hat einen Zustand mit klarem Ziel und
 * mit ERLAUBTEN / VERBOTENEN Aktionen. Der Übergang hängt von Intents + Scores ab – so kann
 * der Bot „führen" statt stur einer Sequenz zu folgen, und er kann NIE eine Stufe überspringen
 * (z.B. Nummer fragen, bevor Vertrauen da ist). Reine Logik, testbar, keine I/O.
 */
import type { IntentSet } from "./intent.js";
import { STOPP_INTENTS } from "./intent.js";
import type { Scores } from "./scores.js";

export const STAGES = [
  "connection", "icebreaker", "smalltalk", "discovery", "bedarf",
  "vertrauen", "validierung", "einwand", "call_angebot", "nummer", "termin",
  "abgeschlossen", "verloren",
] as const;
export type Stage = (typeof STAGES)[number];

export type Aktion =
  | "frage_stellen" | "spiegeln" | "story_teilen" | "validieren" | "leichter_next_step"
  | "call_anbieten" | "nummer_fragen" | "termin_bestaetigen" | "abschied" | "eskalieren";

export interface StageDef {
  ziel: string;
  erlaubt: Aktion[];
  verboten: Aktion[];
  /** Exit-Bedingungen in Klartext: wann diese Stufe verlassen wird (deine Vorgabe). Speist
   *  auch den Prompt Builder ("du bist hier fertig, wenn …"). Die harte Übergangslogik lebt
   *  zusätzlich in nextStage(); hier steht das WAS, dort das WIE. */
  exit: string[];
}

/** Schwellen, ab denen ein Angebot überhaupt erlaubt ist (Scores 0..100, Zähler absolut).
 *  Bewusst moderat: bei klarem Kaufsignal (Jobsuche/Karriere) senkt nextStage die Schwelle
 *  zusätzlich, damit der Bot dann zügig zum Angebot führt statt weiter zu fragen. */
export const SCHWELLEN = { callTrust: 50, callInterest: 50, callReadiness: 52, minAntworten: 3, minNachrichten: 4 } as const;

export const STAGE_DEF: Record<Stage, StageDef> = {
  connection:  { ziel: "Vernetzung angenommen, Gespräch eröffnen.", erlaubt: ["frage_stellen", "story_teilen"], verboten: ["call_anbieten", "nummer_fragen", "termin_bestaetigen"], exit: ["Person hat geantwortet → icebreaker/smalltalk"] },
  icebreaker:  { ziel: "Lockerer Einstieg, echtes Interesse zeigen.", erlaubt: ["frage_stellen", "spiegeln", "story_teilen"], verboten: ["call_anbieten", "nummer_fragen"], exit: ["lockerer Austausch läuft → smalltalk/discovery"] },
  smalltalk:   { ziel: "Beziehung aufwärmen, sympathisch bleiben.", erlaubt: ["frage_stellen", "spiegeln", "validieren"], verboten: ["call_anbieten", "nummer_fragen"], exit: ["genug Wärme/Rapport → discovery"] },
  discovery:   { ziel: "SCHNELL den echten Bedarf/die Orientierungsfrage erkennen – höchstens eine Frage, nicht ausfragen. Sobald ein Bedarf sichtbar ist (z.B. Jobsuche), weiter.", erlaubt: ["frage_stellen", "spiegeln", "validieren"], verboten: ["call_anbieten", "nummer_fragen", "termin_bestaetigen"], exit: ["Bedarf/Jobsuche/Unsicherheit sichtbar → bedarf", "Skepsis/Preisfrage → einwand", "Absage → verloren"] },
  bedarf:      { ziel: "Bedarf kurz spiegeln und die kostenlose Analyse als konkrete Hilfe ins Spiel bringen. Nicht weiter ausfragen.", erlaubt: ["spiegeln", "validieren", "story_teilen", "leichter_next_step"], verboten: ["nummer_fragen"], exit: ["Bedarf gespiegelt & offen → vertrauen/call_angebot", "Einwand → einwand"] },
  vertrauen:   { ziel: "Vertrauen festigen, eigene Erfahrung teilen.", erlaubt: ["story_teilen", "validieren", "spiegeln"], verboten: ["nummer_fragen"], exit: ["Trust hoch → validierung", "Einwand → einwand"] },
  validierung: { ziel: "Interesse konkret validieren (Micro-Commitment).", erlaubt: ["frage_stellen", "leichter_next_step", "validieren"], verboten: ["nummer_fragen"], exit: ["Scores über Schwelle (Trust≥55, Interest≥55, CallReadiness≥60) → call_angebot", "sonst zurück in vertrauen"] },
  einwand:     { ziel: "Einwand mit Fingerspitzengefühl auflösen. Nie diskutieren.", erlaubt: ["validieren", "spiegeln", "story_teilen"], verboten: ["call_anbieten", "nummer_fragen", "termin_bestaetigen"], exit: ["Einwand aufgelöst, positives Signal → vertrauen", "sonst zurück in discovery", "hartes Nein → verloren"] },
  call_angebot:{ ziel: "Die KOSTENLOSE Potenzialanalyse als echte Hilfe anbieten (siehe Angebot) – locker, kein Druck, kein Skript. Genau EIN klarer Vorschlag.", erlaubt: ["call_anbieten", "leichter_next_step", "validieren"], verboten: ["nummer_fragen"], exit: ["Person sagt zu / fragt nach dem Wie → nummer (Übergabe)", "zögert → zurück in vertrauen", "Einwand → einwand"] },
  nummer:      { ziel: "Zusage zur Analyse festhalten und an Sinan übergeben – er schickt den Zugangscode und macht das Auswertungsgespräch. Der Bot schließt nicht selbst ab.", erlaubt: ["leichter_next_step", "validieren", "eskalieren"], verboten: [], exit: ["Zusage/Interesse → Übergabe an den Menschen"] },
  termin:      { ziel: "Übergabe an Sinan bestätigen (Code + Auswertungsgespräch).", erlaubt: ["termin_bestaetigen", "eskalieren"], verboten: [], exit: ["Übergabe steht → abgeschlossen"] },
  abgeschlossen:{ ziel: "Termin steht – Übergabe an den Menschen.", erlaubt: ["eskalieren"], verboten: ["nummer_fragen"], exit: ["terminal – Bot fasst den Thread nicht mehr an"] },
  verloren:    { ziel: "Abschied respektieren, Tür freundlich offen lassen.", erlaubt: ["abschied"], verboten: ["frage_stellen", "call_anbieten", "nummer_fragen"], exit: ["terminal – kein Nachfassen gegen ein Nein"] },
};

const REIHENFOLGE: Stage[] = ["connection","icebreaker","smalltalk","discovery","bedarf","vertrauen","validierung","call_angebot","nummer","termin"];

/**
 * Nächster Zustand aus aktuellem Zustand + Intents + Scores.
 * Grundsätze: STOPP-Intent → verloren. Termin-Zusage/Kontakt → termin/nummer. Einwand → einwand
 * (und danach zurück, nicht raus). Sonst schrittweiser Fortschritt, gedeckelt durch die Scores –
 * Call/Nummer NUR, wenn die Schwellen erreicht sind. Kein Überspringen.
 */
export function nextStage(current: Stage, intents: IntentSet, s: Scores): Stage {
  if (current === "abgeschlossen" || current === "verloren") return current;
  if (intents.some((i) => STOPP_INTENTS.has(i))) return "verloren";
  if (intents.includes("termin_zusage")) return "termin";
  if (intents.includes("kontakt_geteilt")) return "nummer";
  if (intents.includes("skepsis") || intents.includes("preisfrage") || intents.includes("negatives_signal")) return "einwand";

  // Aus einem behandelten Einwand: zurück in die Beziehungsarbeit (nicht sofort weiterdrücken).
  if (current === "einwand") return intents.includes("positives_signal") ? "vertrauen" : "discovery";

  // KAUFSIGNAL (Jobsuche/Karriere/klares Interesse): den Trichter straffen. Smalltalk überspringen
  // und – wenn die Scores stimmen – etwas früher zum Angebot dürfen (senkt die Schwelle um 8).
  const kaufsignal = intents.includes("karriere_interesse") || intents.includes("interesse") || intents.includes("investment_interesse");
  if (kaufsignal && (current === "icebreaker" || current === "smalltalk")) return "bedarf";
  const bonus = kaufsignal ? 8 : 0;
  const darfCall =
    s.trust >= SCHWELLEN.callTrust - bonus &&
    s.interest >= SCHWELLEN.callInterest - bonus &&
    s.callReadiness >= SCHWELLEN.callReadiness - bonus;

  // Regulärer, schrittweiser Fortschritt entlang der Reihenfolge – höchstens EINE Stufe pro Zug.
  const idx = REIHENFOLGE.indexOf(current);
  const naechster = idx >= 0 && idx < REIHENFOLGE.length - 1 ? REIHENFOLGE[idx + 1] : current;

  // Vor „call_angebot"/„nummer" nur, wenn die Scores es hergeben – sonst in der Beziehungsphase bleiben.
  if ((naechster === "call_angebot" || naechster === "nummer") && !darfCall) return "vertrauen";
  return naechster;
}

/** Ist eine Aktion im aktuellen Zustand erlaubt? (für die Risk Engine) */
export function aktionErlaubt(stage: Stage, aktion: Aktion): boolean {
  const def = STAGE_DEF[stage];
  return def.erlaubt.includes(aktion) && !def.verboten.includes(aktion);
}
