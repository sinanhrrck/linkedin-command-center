/**
 * Zentraler Standpunkt für ALLE KI-Texte (DM-Entwürfe, Vernetzungsnotizen, Erstnachrichten).
 * Der INHALT (wer die Person ist, Ziel, Stil, Beispiele, Winkel) kommt jetzt aus dem
 * NUTZER-PROFIL (src/profil.ts → profil.local.json), NICHT mehr fest aus dem Code. So kann
 * jeder das Tool lokal mit seinem eigenen Profil nutzen. Hier lebt nur noch die LOGIK, die
 * aus dem Profil den Prompt-Block baut (promptKontext) und Texte säubert (saubern).
 */
import { profil } from "./profil.js";

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

/** Stil-Regeln (aus dem Profil). */
export const STIL_REGELN: string[] = profil.stilRegeln;

/** Beispiel-Nachrichten in der Stimme der Person (aus dem Profil, Few-Shot). */
export const BEISPIEL_NACHRICHTEN: string[] = profil.beispielNachrichten;

/**
 * Nachbearbeitung: Anführungszeichen weg, Gedankenstrich-Satztrenner → Komma, Emojis raus.
 * Die Emoji-Entfernung ist bewusst maschinell und nicht nur eine Prompt-Regel: die Few-Shot-
 * Beispiele stammen aus Sinans echten Nachrichten, in denen Emojis vorkamen. Selbst wenn ein
 * Modell sich davon anstecken lässt, kommt hier garantiert keins durch.
 */
export function saubern(text: string): string {
  return text
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s[–—-]\s/g, ", ") // " – "/" — "/" - " als Satztrenner → Komma
    .replace(
      /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/gu,
      "",
    )
    .replace(/:\)|:-\)|;\)|:D/g, "") // Text-Smileys
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

/** Baut den gemeinsamen Kontext-Block für Prompts. Der Name kommt aus dem Profil. */
export function promptKontext(): string {
  const name = profil.name;
  const regeln = STIL_REGELN.map((r) => `- ${r}`).join("\n");
  const beispiele = BEISPIEL_NACHRICHTEN.length
    ? `\nSo klingt ${name} (Beispiele, Stil nachahmen – NICHT Inhalt kopieren):\n${BEISPIEL_NACHRICHTEN.map((b, i) => `Beispiel ${i + 1}: ${b}`).join("\n")}\n`
    : "";
  return `Über ${name}: ${PERSONA}
Ziel der Nachricht: ${ZIEL}
${TABUS}
Stil-Regeln:
${regeln}
${beispiele}`;
}
