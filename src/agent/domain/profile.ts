/**
 * PSYCHOLOGISCHES PROFIL eines Leads – wächst über den Gesprächsverlauf.
 *
 * Grundregel (deine Vorgabe): NICHT raten. Eine Dimension bewegt sich nur, wenn die Analyse
 * ein TATSÄCHLICHES Signal geliefert hat. Der Analyse-Call gibt pro Nachricht eine
 * `ProfileObservation` zurück (jede Dimension 0..1 ODER null = "kein Signal"). `updateProfile`
 * glättet den bekannten Wert Richtung Beobachtung (exponentiell) – so zählt jede neue Nachricht,
 * ohne dass ein einzelner Ausreißer alles umwirft. Reine Logik, keine I/O.
 */

/** Alle Werte 0..1 (Anteil/Stärke), außer wo anders vermerkt. */
export interface PsychProfile {
  moneyInterest: number;
  careerInterest: number;
  investmentInterest: number;
  trust: number;
  skepticism: number;
  humor: number;
  extroversion: number;
  openness: number;
  financialKnowledge: number;
  responseLength: number;      // ø Antwortlänge, normalisiert 0..1 (kurz→lang)
  responseSpeedMin: number | null; // ø Minuten bis Antwort (Rohwert, null bis messbar)
  emojiUsage: boolean;
  /** Aus wie vielen Nachrichten das Profil gespeist ist = Konfidenz. */
  beobachtungen: number;
}

/** Was die Analyse pro eingehender Nachricht an Signalen liefert. null = kein Signal. */
export type ProfileObservation = Partial<Record<
  "moneyInterest" | "careerInterest" | "investmentInterest" | "trust" | "skepticism" |
  "humor" | "extroversion" | "openness" | "financialKnowledge",
  number | null
>> & {
  responseLength?: number | null;   // Zeichenzahl der eingehenden Nachricht
  responseSpeedMin?: number | null;
  emojiUsage?: boolean | null;
};

export function leeresProfil(): PsychProfile {
  return {
    moneyInterest: 0, careerInterest: 0, investmentInterest: 0, trust: 0, skepticism: 0,
    humor: 0, extroversion: 0, openness: 0, financialKnowledge: 0,
    responseLength: 0, responseSpeedMin: null, emojiUsage: false, beobachtungen: 0,
  };
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Aktualisiert das Profil aus einer Beobachtung. Glättungsfaktor α sinkt mit der Konfidenz:
 * die ersten Nachrichten prägen stark, später wird das Profil träge (stabil). Dimensionen ohne
 * Signal (null/undefined) bleiben UNVERÄNDERT – kein Raten.
 */
export function updateProfile(p: PsychProfile, obs: ProfileObservation): PsychProfile {
  const next: PsychProfile = { ...p };
  const alpha = Math.max(0.25, 1 / (p.beobachtungen + 2)); // 0.5, 0.33, 0.25 … nie unter 0.25

  const dims = ["moneyInterest","careerInterest","investmentInterest","trust","skepticism","humor","extroversion","openness","financialKnowledge"] as const;
  for (const d of dims) {
    const v = obs[d];
    if (typeof v === "number") next[d] = clamp01(p[d] * (1 - alpha) + clamp01(v) * alpha);
  }

  // responseLength: rohe Zeichenzahl → normalisiert (0 Zeichen→0, ~400+→1), dann glätten.
  if (typeof obs.responseLength === "number") {
    const norm = clamp01(obs.responseLength / 400);
    next.responseLength = clamp01(p.responseLength * (1 - alpha) + norm * alpha);
  }
  if (typeof obs.responseSpeedMin === "number") {
    next.responseSpeedMin = p.responseSpeedMin == null ? obs.responseSpeedMin
      : p.responseSpeedMin * (1 - alpha) + obs.responseSpeedMin * alpha;
  }
  if (typeof obs.emojiUsage === "boolean") next.emojiUsage = obs.emojiUsage || p.emojiUsage;

  next.beobachtungen = p.beobachtungen + 1;
  return next;
}
