/**
 * TRIGGER ENGINE – reagiert auf psychologische Trigger (deine Vorgabe: nicht jede Person gleich
 * behandeln). Übersetzt Profil + Intents + Scores in STRUKTURIERTE Verhaltens-Flags, die sowohl
 * den Prompt (Stil) als auch die Entscheidungslogik (z.B. Ghosting → behutsam) steuern. Reine Logik.
 */
import type { PsychProfile } from "../profile.js";
import type { IntentSet } from "../intent.js";
import type { Scores } from "../scores.js";

export interface Triggers {
  keinVerkaufston: boolean;    // Skepsis hoch → keine Verkaufssprache
  tieferQualifizieren: boolean;// Interesse hoch → mehr in die Tiefe
  ultraKurz: boolean;          // Zeitmangel/knapper Stil → extrem kurz
  lockererStil: boolean;       // Humor/Ironie → locker
  sachlicherStil: boolean;     // analytisch/kundig → sachlich
  behutsamReEngage: boolean;   // Ghosting-Risiko → sanft, kein Druck
}

export function deriveTriggers(p: PsychProfile, intents: IntentSet, s: Scores): Triggers {
  const knapp = p.responseLength > 0 && p.responseLength < 0.25;
  return {
    keinVerkaufston: p.skepticism > 0.5 || intents.some((i) => i === "skepsis" || i === "preisfrage" || i === "negatives_signal"),
    tieferQualifizieren: s.interest >= 55 && s.trust >= 40,
    ultraKurz: intents.includes("zeitmangel") || knapp,
    lockererStil: p.humor > 0.5 || intents.includes("ironie"),
    sachlicherStil: p.financialKnowledge > 0.6 || (p.humor < 0.3 && p.extroversion < 0.4),
    behutsamReEngage: s.ghostingRisk > 50,
  };
}

/** Trigger als Prompt-Hinweise (ergänzt stilHinweise; der Orchestrator hängt sie an). */
export function triggerHinweise(t: Triggers): string[] {
  const h: string[] = [];
  if (t.keinVerkaufston) h.push("Kein Verkaufston – ruhig, ehrlich, auf Augenhöhe.");
  if (t.ultraKurz) h.push("Fass dich extrem kurz – ein, zwei Sätze.");
  if (t.lockererStil) h.push("Locker und mit einem Augenzwinkern.");
  if (t.sachlicherStil) h.push("Sachlich und konkret, kein Smalltalk-Überschuss.");
  if (t.tieferQualifizieren) h.push("Interesse ist da – geh eine Ebene tiefer, ohne zu pitchen.");
  if (t.behutsamReEngage) h.push("Die Person zieht sich evtl. zurück – sanft, ohne Druck, leicht zu beantworten.");
  return h;
}
