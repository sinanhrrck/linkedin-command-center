import { db } from "../db/index.js";

/**
 * Aktive Lehren aus dem Training (Tabelle `sim_regeln`, status='aktiv'). Eigenes Modul OHNE weitere
 * Abhängigkeiten, weil es in ausrichtung.ts (Gesprächs-Prompts) und personalize.ts (Erstnachricht)
 * eingelesen wird – training.ts selbst importiert personalize und würde sonst einen Zyklus bauen.
 *
 * Drei Arten: `gespraech`/`erstnachricht` sind Regeln (Anweisungen), `beispiel` sind Nachrichten, die
 * ein Mensch auf der Trainingsseite als Sinan geschrieben hat – sie zeigen den Ton, nicht den Inhalt.
 * Ohne aktive Einträge liefert der Block "" → Prompts byte-gleich zu vorher.
 */
export type RegelBereich = "gespraech" | "erstnachricht" | "beispiel";
export const MAX_AKTIVE_REGELN = 20;
export const MAX_AKTIVE_BEISPIELE = 8;

export function aktiveTrainingsRegeln(bereich: RegelBereich): string[] {
  return (db.prepare(
    "SELECT regel FROM sim_regeln WHERE status='aktiv' AND bereich=? ORDER BY entschieden_at, id LIMIT ?",
  ).all(bereich, bereich === "beispiel" ? MAX_AKTIVE_BEISPIELE : MAX_AKTIVE_REGELN) as { regel: string }[]).map((r) => r.regel);
}

export function trainingsRegelnBlock(bereich: "gespraech" | "erstnachricht"): string {
  const regeln = aktiveTrainingsRegeln(bereich);
  const beispiele = bereich === "gespraech" ? aktiveTrainingsRegeln("beispiel") : [];
  if (!regeln.length && !beispiele.length) return "";
  return `${regeln.length ? `
# LEHREN AUS TRAININGS-CHATS (von Sinan freigegeben, immer einhalten)
${regeln.map((r) => `- ${r}`).join("\n")}
` : ""}${beispiele.length ? `
# SO KLINGT EIN MENSCH IN SOLCHEN CHATS (von Sinan freigegeben; Ton und Satzbau nachahmen, Inhalt NICHT kopieren)
${beispiele.map((b, i) => `Beispiel ${i + 1}: ${b}`).join("\n")}
` : ""}`;
}
