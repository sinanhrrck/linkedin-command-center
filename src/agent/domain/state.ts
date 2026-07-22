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
}

/** Schwellen (0..100), ab denen ein Angebot/Call überhaupt erlaubt ist. */
export const SCHWELLEN = { callTrust: 55, callInterest: 55, callReadiness: 60, minAntworten: 4 } as const;

export const STAGE_DEF: Record<Stage, StageDef> = {
  connection:  { ziel: "Vernetzung angenommen, Gespräch eröffnen.", erlaubt: ["frage_stellen", "story_teilen"], verboten: ["call_anbieten", "nummer_fragen", "termin_bestaetigen"] },
  icebreaker:  { ziel: "Lockerer Einstieg, echtes Interesse zeigen.", erlaubt: ["frage_stellen", "spiegeln", "story_teilen"], verboten: ["call_anbieten", "nummer_fragen"] },
  smalltalk:   { ziel: "Beziehung aufwärmen, sympathisch bleiben.", erlaubt: ["frage_stellen", "spiegeln", "validieren"], verboten: ["call_anbieten", "nummer_fragen"] },
  discovery:   { ziel: "Situation/Motivation/Ambitionen verstehen. NICHT verkaufen.", erlaubt: ["frage_stellen", "spiegeln", "validieren"], verboten: ["call_anbieten", "nummer_fragen", "termin_bestaetigen"] },
  bedarf:      { ziel: "Bedarf/Problem herausarbeiten und vertiefen.", erlaubt: ["frage_stellen", "spiegeln", "validieren", "story_teilen"], verboten: ["nummer_fragen"] },
  vertrauen:   { ziel: "Vertrauen festigen, eigene Erfahrung teilen.", erlaubt: ["story_teilen", "validieren", "spiegeln"], verboten: ["nummer_fragen"] },
  validierung: { ziel: "Interesse konkret validieren (Micro-Commitment).", erlaubt: ["frage_stellen", "leichter_next_step", "validieren"], verboten: ["nummer_fragen"] },
  einwand:     { ziel: "Einwand mit Fingerspitzengefühl auflösen. Nie diskutieren.", erlaubt: ["validieren", "spiegeln", "story_teilen"], verboten: ["call_anbieten", "nummer_fragen", "termin_bestaetigen"] },
  call_angebot:{ ziel: "Ein Telefonat sinnvoll erscheinen lassen (kein Pitch).", erlaubt: ["call_anbieten", "leichter_next_step", "validieren"], verboten: ["nummer_fragen"] },
  nummer:      { ziel: "Nummer/Termin-Kanal erhalten – erst wenn die Tür offen ist.", erlaubt: ["nummer_fragen", "call_anbieten"], verboten: [] },
  termin:      { ziel: "Termin fix bestätigen.", erlaubt: ["termin_bestaetigen"], verboten: [] },
  abgeschlossen:{ ziel: "Termin steht – Übergabe an den Menschen.", erlaubt: ["eskalieren"], verboten: ["nummer_fragen"] },
  verloren:    { ziel: "Abschied respektieren, Tür freundlich offen lassen.", erlaubt: ["abschied"], verboten: ["frage_stellen", "call_anbieten", "nummer_fragen"] },
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

  const darfCall = s.trust >= SCHWELLEN.callTrust && s.interest >= SCHWELLEN.callInterest && s.callReadiness >= SCHWELLEN.callReadiness;

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
