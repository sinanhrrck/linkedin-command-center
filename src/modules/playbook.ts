import { getState, setState } from "../db/index.js";

/**
 * NACHFASS-PLAYBOOK (2026-09-23, Sinan: „vertrieblicher, Follow-ups einstellbar“).
 *
 * Vorher gab es genau zwei feste Follow-ups (4 und 7 Tage), und das erste war ein reines
 * „wollte nochmal nachfragen“ – ohne jeden Grund zu antworten. Hormozi: jede Nachfassung
 * braucht einen EIGENEN Anlass, der der Person etwas bringt. Deshalb hat jede Stufe einen
 * ZWECK, und die letzte ist immer ein ehrlicher Schlussstrich.
 *
 * Harte Grenzen, die keine Einstellung aushebelt:
 *  - höchstens 3 Nachfassungen nach der ersten Nachricht (Report-Risiko, Ruf),
 *  - mindestens 2 Tage Abstand, höchstens 30,
 *  - die letzte Stufe ist immer `abschied` – wer dann nicht antwortet, hört nichts mehr.
 */

export type Zweck = "wert" | "beweis" | "anknuepfen" | "abschied";
export type NachfassStufe = { nachTagen: number; zweck: Zweck };

export const ZWECKE: Zweck[] = ["wert", "beweis", "anknuepfen", "abschied"];
export const MAX_STUFEN = 3;

/** Entspricht dem bisherigen Verhalten (4 Tage, dann 7 Tage), nur mit Anlass statt Nachfragen. */
export const STANDARD_PLAN: NachfassStufe[] = [{ nachTagen: 4, zweck: "wert" }, { nachTagen: 7, zweck: "abschied" }];
export const DREI_STUFEN_PLAN: NachfassStufe[] = [{ nachTagen: 3, zweck: "wert" }, { nachTagen: 5, zweck: "beweis" }, { nachTagen: 7, zweck: "abschied" }];

/** Macht aus beliebiger Eingabe einen erlaubten Plan. Wirft nie – im Zweifel der Standard. */
export function normalisierePlan(roh: unknown): NachfassStufe[] {
  const liste = Array.isArray(roh) ? roh : [];
  const plan = liste.slice(0, MAX_STUFEN).map((s) => {
    const x = (s || {}) as Record<string, unknown>;
    const tage = Math.round(Number(x.nachTagen));
    return {
      nachTagen: Number.isFinite(tage) ? Math.min(30, Math.max(2, tage)) : 4,
      zweck: (ZWECKE as string[]).includes(String(x.zweck)) ? x.zweck as Zweck : "wert",
    };
  });
  if (!plan.length) return STANDARD_PLAN.map((s) => ({ ...s }));
  plan[plan.length - 1].zweck = "abschied";
  // Ein Abschied mitten in der Kette wäre gelogen („ich meld mich nicht mehr“ – und dann doch).
  for (let i = 0; i < plan.length - 1; i++) if (plan[i].zweck === "abschied") plan[i].zweck = "anknuepfen";
  return plan;
}

export function followupPlan(): NachfassStufe[] {
  try { return normalisierePlan(JSON.parse(getState("followup_plan") || "null")); }
  catch { return normalisierePlan(null); }
}

export function speichereFollowupPlan(roh: unknown): NachfassStufe[] {
  const plan = normalisierePlan(roh);
  setState("followup_plan", JSON.stringify(plan));
  return plan;
}

/** Zweck einer Stufe (1-basiert). Jenseits des Plans gibt es keine Stufe – dann Abschied. */
export function zweckFuer(stufe: number, plan = followupPlan()): Zweck {
  return plan[stufe - 1]?.zweck ?? "abschied";
}

/** Anweisung je Zweck für den Prompt. */
export const ZWECK_ANWEISUNG: Record<Zweck, string> = {
  wert: `ZWECK DIESER NACHFASSUNG: WERT GEBEN.
Bring EINEN konkreten, nützlichen Gedanken für die Lage der Person (etwas, das viele in ihrer Situation unterschätzen oder zu spät merken). Ein Satz, ehrlich, ohne Belehrung.
Dann, falls unten ein Angebot steht: nenn es BEIM NAMEN, sag in einem halben Satz, was die Person davon hat, und ende mit der leichten Frage des Angebots (fast wörtlich). Steht kein Angebot da: ende mit einer Frage, die in fünf Sekunden beantwortet ist.
Die Nachricht endet IMMER mit genau einer Frage.
VERBOTEN: "wollte nochmal nachfragen", "vermutlich untergegangen", die erste Nachricht wiederholen, Vorwürfe, vage Teaser wie "ich hab da was für dich" ohne zu sagen, was es ist.`,
  beweis: `ZWECK DIESER NACHFASSUNG: EINE ECHTE GESCHICHTE.
Erzähl in ein bis zwei Sätzen EINE kurze, echte Erfahrung aus den Belegen unten (nichts dazuerfinden, keine Zahlen ergänzen). Stehen dort keine Belege, erzähl nur, was im Profil über dich steht.
Dann, falls unten ein Angebot steht: beim Namen nennen und mit seiner leichten Frage enden. Sonst mit einer leichten Frage enden.`,
  anknuepfen: `ZWECK DIESER NACHFASSUNG: LOCKER ANKNÜPFEN.
Kein Druck, kein Vorwurf. Knüpf leicht an das Thema an und mach es der Person so leicht wie möglich zu antworten.`,
  abschied: `ZWECK DIESER NACHFASSUNG: EHRLICHER SCHLUSSSTRICH (die letzte Nachricht).
Ein bis zwei Sätze. Sag ehrlich, dass du dich nicht mehr meldest. Die Tür bleibt offen: falls es irgendwann passt, reicht ein kurzes Wort. KEINE Frage, kein "schade", kein Vorwurf, kein Angebot.`,
};
