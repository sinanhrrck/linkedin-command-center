/**
 * Zentraler Standpunkt für ALLE KI-Texte (DM-Entwürfe, Vernetzungsnotizen, Erstnachrichten).
 * Der INHALT (wer die Person ist, Ziel, Stil, Beispiele, Winkel) kommt jetzt aus dem
 * NUTZER-PROFIL (src/profil.ts → profil.local.json), NICHT mehr fest aus dem Code. So kann
 * jeder das Tool lokal mit seinem eigenen Profil nutzen. Hier lebt nur noch die LOGIK, die
 * aus dem Profil den Prompt-Block baut (promptKontext) und Texte säubert (saubern).
 */
import { profil, getProfil } from "./profil.js";

/** Wer die Person ist (aus dem Profil). */
export const PERSONA = profil.persona;

/** Zielgruppen für den Erstnachricht-Winkel. */
export type Zielgruppe = "azubi" | "student";

/**
 * Winkel je Zielgruppe (aus dem Profil). Der "kern" ist die generische, für JEDEN gültige
 * Leitplanke: echtes Interesse, kein Pitch, an der Headline andocken statt etwas zu erfinden.
 */
export function erstnachrichtAngle(z: Zielgruppe | null | undefined): string {
  const kern =
    "Echtes Interesse, kein Pitch, keine Werbung. Nimm Bezug auf DAS, was in der Headline der " +
    "Person steht (echter Beruf, echter Betrieb, echter Studiengang). Erfinde nichts dazu und " +
    "unterstelle keine Branche.";
  return `${z === "student" ? profil.winkel.student : profil.winkel.azubi}\n${kern}`;
}

/** Rückwärtskompatibel (alte Aufrufer): Azubi-Winkel als Standard. */
export const ERSTNACHRICHT_ANGLE = erstnachrichtAngle("azubi");

/** Was eine Nachricht erreichen soll (aus dem Profil). */
export const ZIEL = profil.ziel;

/** Harte Tabus/Grenzen (aus dem Profil). */
export const TABUS = profil.tabus;

/** DEIN konkretes Angebot (Mehrwert-Türöffner). Leer = kein Angebot, reines Kennenlernen. */
export const ANGEBOT = (profil.angebot ?? "").trim();

/** Stil-Regeln (aus dem Profil). */
export const STIL_REGELN: string[] = profil.stilRegeln;

/** Beispiel-Nachrichten in der Stimme der Person (aus dem Profil, Few-Shot). */
export const BEISPIEL_NACHRICHTEN: string[] = profil.beispielNachrichten;

// `saubern` liegt seit 2026-10-23 in core/saubern.ts (ohne Profil-Abhängigkeit), damit die
// Trainings-Website dieselbe Nachbearbeitung bündeln kann. Hier nur weitergereicht.
export { saubern } from "./core/saubern.js";

/** Baut den gemeinsamen Kontext-Block für Prompts. Der Name kommt aus dem Profil.
 *  Liest das Profil LIVE (`getProfil`), damit ein im Cockpit gespeichertes Angebot ohne
 *  Engine-Neustart wirkt. Bei unverändertem Profil ist die Ausgabe identisch zu vorher. */
export function promptKontext(): string {
  const p = getProfil();
  const name = p.name;
  const regeln = p.stilRegeln.map((r) => `- ${r}`).join("\n");
  const beispiele = p.beispielNachrichten.length
    ? `\nSo klingt ${name} (Beispiele, Stil nachahmen – NICHT Inhalt kopieren):\n${p.beispielNachrichten.map((b, i) => `Beispiel ${i + 1}: ${b}`).join("\n")}\n`
    : "";
  const angebot = (p.angebot ?? "").trim();
  const angebotBlock = angebot
    ? `\nDein Angebot (Mehrwert-Türöffner – NUR anbieten, wenn ein echter Bedarf sichtbar ist, z.B. Jobsuche/Orientierung; nie kalt reinpitchen):\n${angebot}\n`
    : "";
  return `Über ${name}: ${p.persona}
Ziel der Nachricht: ${p.ziel}
${p.tabus}
${angebotBlock}Stil-Regeln:
${regeln}
${beispiele}`;
}
