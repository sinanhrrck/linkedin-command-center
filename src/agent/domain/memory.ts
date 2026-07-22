/**
 * CONVERSATION MEMORY – das wachsende Gedächtnis eines Leads.
 *
 * Nicht nur der Chatverlauf: eine verdichtete, fortgeschriebene Zusammenfassung, damit die KI
 * NIE den Kontext verliert (deine Vorgabe). Wird nach jeder Nachricht aus den `ExtrahierteFakten`
 * der Analyse aktualisiert. Reine Logik, keine I/O – wird später als JSON pro Conversation
 * persistiert und in den Antwort-Prompt injiziert.
 */
import type { ExtrahierteFakten } from "./analysis.js";

export interface ConversationMemory {
  name: string | null;
  alter: number | null;
  studiumOderAusbildung: string | null;
  beruf: string | null;
  ziele: string[];
  einwaende: string[];
  interessen: string[];
  letzteThemen: string[];   // rollierend, die letzten Gesprächsthemen
  zusammenfassung: string;  // laufende 1–3-Satz-Zusammenfassung des Gesprächs
}

export function leeresMemory(name: string | null = null): ConversationMemory {
  return { name, alter: null, studiumOderAusbildung: null, beruf: null, ziele: [], einwaende: [], interessen: [], letzteThemen: [], zusammenfassung: "" };
}

/** Fügt einen Wert hinzu, ohne Duplikate, und deckelt die Liste (jüngste behalten). */
function ergaenze(liste: string[], wert: string | null | undefined, max: number): string[] {
  const v = (wert ?? "").trim();
  if (!v) return liste;
  const ohne = liste.filter((x) => x.toLowerCase() !== v.toLowerCase());
  return [...ohne, v].slice(-max);
}

/**
 * Schreibt das Gedächtnis fort: Skalare (Name/Alter/…) nur setzen, wenn die Analyse einen Wert
 * liefert (bestehende NICHT mit null überschreiben). Listen wachsen dedupliziert. Die
 * Zusammenfassung wird durch die jeweils neueste ersetzt (die Analyse fasst kumulativ zusammen).
 */
export function updateMemory(m: ConversationMemory, fakten: ExtrahierteFakten, zusammenfassung: string): ConversationMemory {
  return {
    name: m.name, // Name kommt aus dem Kontakt, nicht aus der Analyse
    alter: typeof fakten.alter === "number" ? fakten.alter : m.alter,
    studiumOderAusbildung: fakten.studiumOderAusbildung?.trim() || m.studiumOderAusbildung,
    beruf: fakten.beruf?.trim() || m.beruf,
    ziele: ergaenze(m.ziele, fakten.ziele, 5),
    einwaende: ergaenze(m.einwaende, fakten.einwaende, 5),
    interessen: ergaenze(m.interessen, fakten.themen, 6), // Themen fließen als Interessen ein
    letzteThemen: ergaenze(m.letzteThemen, fakten.themen, 4),
    zusammenfassung: (zusammenfassung ?? "").trim() || m.zusammenfassung,
  };
}

/** Kompakte Darstellung fürs Prompt (nur gefüllte Felder, kurz). */
export function memoryAlsText(m: ConversationMemory): string {
  const teile: string[] = [];
  if (m.name) teile.push(`Name: ${m.name}`);
  if (m.alter) teile.push(`Alter: ${m.alter}`);
  if (m.studiumOderAusbildung) teile.push(`Ausbildung/Studium: ${m.studiumOderAusbildung}`);
  if (m.beruf) teile.push(`Beruf: ${m.beruf}`);
  if (m.ziele.length) teile.push(`Ziele: ${m.ziele.join(", ")}`);
  if (m.interessen.length) teile.push(`Interessen: ${m.interessen.join(", ")}`);
  if (m.einwaende.length) teile.push(`Einwände: ${m.einwaende.join(", ")}`);
  if (m.letzteThemen.length) teile.push(`Zuletzt: ${m.letzteThemen.join(", ")}`);
  if (m.zusammenfassung) teile.push(`Kurz: ${m.zusammenfassung}`);
  return teile.join("\n");
}
