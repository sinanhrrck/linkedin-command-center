/**
 * ERSTNACHRICHT, REINER TEIL (2026-10-23): Prompt-Aufbau und Nachprüfung ohne DB, Profil oder Netz.
 * `personalize.firstMessage` sammelt die Daten und ruft das hier auf; die Trainings-Website bündelt
 * GENAU diese Funktionen (src/trainingsweb/kern.ts) und füttert sie mit einer Momentaufnahme der
 * Live-Daten. Damit klingt der Bot dort 1:1 wie live. Text NUR hier ändern, nie doppelt pflegen.
 */
import { ausbildungsStand, ausbildungsVorgabe, behauptetLaufendeAusbildung } from "../core/ausbildungsStand.js";
import { saubern } from "../core/saubern.js";

export type Wahl = { slot: string; arm: string; anweisung: string };
export type ZielEinfach = { code: string; label: string; instruction: string };

export const STANDARD_ERSTNACHRICHT = `AUFBAU (3 kurze Bausteine, genau in dieser Reihenfolge):
1. Persönliche Anknüpfung (1 Zeile). Etwas Konkretes aus dem Profil: Bank, Standort, Ausbildungsjahr, ein Post. Etwas, das nur auf diese Person zutrifft.
2. Eigener Bezug (1 kurzer Satz). Dass du selbst mal in der Bank angefangen hast. NUR diese Tatsache: keine Lehre daraus, kein Rat, keine Aussage über Weichen, Richtung, Chancen oder was man unterschätzt.
3. Leichte Frage (1 Zeile). Genau EINE ehrliche Frage zu ihrer aktuellen Situation, die man in fünf Sekunden beantworten kann. Die Nachricht endet mit dieser Frage.

GUTE BEISPIELE:
Beispiel 1: Hey Marvin, ich hab gesehen du bist im 2. Lehrjahr bei der Sparkasse Köln. Ich hab damals auch als Azubi in der Bank angefangen. Wie erlebst du den Alltag da gerade?
Beispiel 2: Hey Lisa, cool dass du deine Ausbildung bei der Volksbank machst. Ich war früher selbst bei der Bank. Was ist bisher das Überraschendste für dich in der Praxis?
Beispiel 3 (Ausbildung schon fertig): Hey Jonas, ich hab gesehen du bist bei der Sparkasse Köln als Bankkaufmann. Ich hab damals auch in der Bank angefangen. Wie ging's für dich nach der Ausbildung weiter?`;

/** Prompt-Baustein für eine Wahl. */
export function variantenBlock(w: Wahl | null): string {
  return w ? `\nVARIANTE FÜR DIESE NACHRICHT (hat Vorrang vor dem Aufbau oben): ${w.anweisung}\n` : "";
}

export type TextVariation = {
  instruction: string;
  rejectedTexts?: string[];
};

export function variationBlock(variation?: TextVariation): string {
  if (!variation) return "";
  const rejected = (variation.rejectedTexts || []).filter(Boolean).slice(-5);
  return `\nVERBINDLICHE NEUE GESPRÄCHSRICHTUNG:\n${variation.instruction}\n` +
    (rejected.length ? `\nBEREITS ABGELEHNT. Übernimm weder deren Gesprächsidee noch Satzbau oder Frage:\n${rejected.map((text, i) => `${i + 1}. ${text}`).join("\n")}\n` : "");
}

/** Rückmeldung der Ausgangsprüfung (drafts.mitAusgangsCheck) für den einen Neuversuch. */
export function korrekturBlock(korrektur?: string): string {
  return korrektur ? `\nKORREKTUR (zwingend beachten): ${korrektur}\nSchreib die Nachricht neu und vermeide genau diese Fehler.\n` : "";
}

export type ErstnachrichtEingabe = {
  gruppe: string | null;
  aufbau: string;
  variation?: TextVariation;
  name?: string | null;
  headline?: string | null;
  /** faktenBlock(contactId) – Profil-Fakten, leer wenn keine. */
  fakten: string;
  /** Text, aus dem der Ausbildungsstand bestimmt wird (frische Rolle, sonst Headline). */
  stand: string | null | undefined;
  goal?: ZielEinfach | null;
  kampagnenFakten?: string;
  /** learningGuidance(...) und trainingsRegelnBlock("erstnachricht") – fertige Textbausteine. */
  learning: string;
  regeln: string;
  variante?: Wahl | null;
  korrektur?: string;
};

export function erstnachrichtPrompt(i: ErstnachrichtEingabe): string {
  return `Du bist Sinan. Du schreibst LinkedIn-Erstnachrichten an ${i.gruppe ? `Menschen aus der Zielgruppe „${i.gruppe}“` : "Auszubildende oder Berufseinsteiger im Bankwesen"}. Dein Ziel ist NIEMALS der Verkauf oder Pitch in der ersten Nachricht, sondern das Öffnen eines echten, lockeren Gesprächs auf Augenhöhe. Du bist neugierig, ehrlich und kommst sofort auf den Punkt. Du warst selbst mal Azubi in einer Bank und holst die Leute genau über diese gemeinsame Lebenslage ab.

${i.aufbau}
${variationBlock(i.variation)}

HARTE STIL- UND FORMATREGELN (Zwingend einhalten, gelten auch gegen jede Anleitung oben):
- IMMER Duzen, niemals siezen.
- KEINE Emojis. Niemals.
- KEINE Gedankenstriche (weder - noch als langer Strich) als Satztrenner. Nutze nur Punkt, Komma oder Fragezeichen.
- GESPROCHENE SPRACHE: Schreibe "Ich hab" statt "Ich habe", "Mir ging's" statt "Mir ging es". Kling wie ein echter Mensch.
- KURZE SÄTZE: Ein Gedanke pro Satz. Keine Schachtelsätze.
- MAXIMAL 4-5 Zeilen gesamt.
- MAXIMAL EINE einzige Frage in der gesamten Nachricht.
- KEINE Aufzählungen in der Nachricht.
- KEINE Floskeln wie "Ich hoffe es geht dir gut". Starte direkt mit "Hey [Name]".
- KEIN Pitch, keine Firma nennen, kein Produkt, keine Verdienst-Zahlen, keine Verkaufsbegriffe ("spannende Möglichkeit").
- KEINE Ratschläge oder Lebensweisheiten (etwa über Weichen, die richtige Richtung oder was man nach der Ausbildung unterschätzt). Das wirkt wie die Vorbereitung eines Pitches.
- Beispiele, die eine laufende Ausbildung voraussetzen, passen NUR, wenn die Person laut AUSBILDUNGSSTAND wirklich in der Ausbildung ist.

SCHLECHTE BEISPIELE (SO NICHT):
Falsch: "Ich sehe du bist in der Finanzbranche, hast du schon mal über Selbstständigkeit nachgedacht?" (Riecht nach Pitch, zu aufdringlich.)
Falsch: "Bei uns verdienst du das 3-fache deines aktuellen Gehalts." (Verkauf in Nachricht 1, verbrannt.)
Falsch: "Ich hätte da eine spannende Möglichkeit für dich, die perfekt zu deinem Profil passt." (Klassische Bot-Nachricht, Marketing-Sprache.)
Falsch: "Hallo, ich hoffe es geht dir gut. Ich würde mich freuen, wenn wir uns vernetzen könnten." (Floskel, kein Anknüpfungspunkt, langweilig.)
Falsch: "Ich hab gemerkt, dass nach der Ausbildung die Weichen schneller gestellt werden, als man denkt." (Lebensweisheit, riecht nach kommendem Pitch.)

INPUT für diese Person (nutze nur, was da ist; erfinde nichts dazu):
Name: ${i.name ?? "Unbekannt"}
Profil-Headline (enthält oft Bank, Ausbildungsjahr, Studiengang, Standort): ${i.headline ?? "unbekannt"}
${i.fakten}${ausbildungsVorgabe(i.stand)}
${i.goal ? `\nLANGFRISTIGER GESPRÄCHSAUFTRAG: ${i.goal.code} – ${i.goal.label}. ${i.goal.instruction}\nDie Erstnachricht bleibt trotzdem ein echter Icebreaker ohne Pitch. Wähle nur eine Anknüpfung, die später natürlich zu diesem Ziel passen kann.` : ""}
${i.kampagnenFakten ? `\n${i.kampagnenFakten}\nNutze diese Angaben nur, um die richtige Anknüpfung und Tonlage zu wählen. Erwähne weder Kampagne, Angebot, Event noch Nutzen in dieser ersten Nachricht.` : ""}
${i.learning}${i.regeln}

${i.variation ? "" : variantenBlock(i.variante ?? null)}${korrekturBlock(i.korrektur)}
OUTPUT-REGEL: Generiere GENAU EINE Nachricht nach obigem Aufbau. Nichts drumherum, keine Erklärungen davor oder danach, kein "Hier ist die Nachricht:". Gib ausschließlich den Text der Nachricht aus.`;
}

/**
 * Erzeugt den Text und prüft, ob er der Person eine laufende Ausbildung unterstellt, die es laut
 * Profil nicht gibt. Ein Neuversuch mit ausdrücklicher Korrektur, danach Abbruch.
 */
export async function mitAusbildungsCheckPur(prompt: string, stand: string | null | undefined, name: string | null | undefined, gen: (p: string) => Promise<string>): Promise<string> {
  const text = saubern(await gen(prompt));
  if (ausbildungsStand(stand) === "in_ausbildung" || !behauptetLaufendeAusbildung(text)) return text;
  const zweiter = saubern(await gen(`${prompt}

KORREKTUR: Dein letzter Entwurf hat behauptet, die Person sei gerade in der Ausbildung. Das ist FALSCH.
Verworfener Entwurf: ${text}
Schreibe neu, ohne eine laufende Ausbildung zu unterstellen.`));
  if (behauptetLaufendeAusbildung(zweiter)) {
    throw new Error(`Text unterstellt ${name ?? "der Person"} eine laufende Ausbildung, Profil sagt anders – kein Entwurf`);
  }
  return zweiter;
}

/** Ausgangsprüfung mit einem Neuversuch (drafts.mitAusgangsCheck). `""` = verworfen. */
export async function mitAusgangsCheckPur(
  erzeuge: (korrektur?: string) => Promise<string>,
  pruefe: (text: string) => { ok: boolean; gruende: string[] },
): Promise<{ text: string; gruende: string[] }> {
  const erster = await erzeuge();
  if (!erster) return { text: "", gruende: ["kein Text"] };
  const p1 = pruefe(erster);
  if (p1.ok) return { text: erster, gruende: [] };
  const zweiter = await erzeuge(`Dein letzter Entwurf wurde abgelehnt: ${p1.gruende.join("; ")}. Verworfener Entwurf: ${erster}`).catch(() => "");
  const p2 = zweiter ? pruefe(zweiter) : { ok: false, gruende: ["kein Text"] };
  return p2.ok ? { text: zweiter, gruende: [] } : { text: "", gruende: p2.gruende };
}
