import { getState, setState } from "../db/index.js";
import { events } from "./events.js";

/**
 * LINKEDIN-SUCHLIMIT (2026-09-25). Gratis-Konten haben ein monatliches Kontingent für
 * Personensuchen ("commercial use limit"). Ist es erschöpft, liefert LinkedIn weiterhin eine
 * Seite aus – nur ohne brauchbare Treffer: Seite 1 zeigt drei echte Profile und darunter den
 * Hinweistext, ab Seite 2 heißen ALLE Treffer "LinkedIn Mitglied" und tragen KEINEN
 * /in/-Link mehr. `scrapeSearch` findet dann null Anker, `feedTick` wertet das als "Ende der
 * Ergebnisse" und springt zurück auf Seite 1 – ein endloses Pendel zwischen Seite 1 und 2.
 * Live gemessen am 2026-09-25: 22 der 37 Seitenabrufe des Tages gingen in Suchen, Ertrag
 * war EIN Kontakt.
 *
 * Deshalb: Hinweistext erkennen, den Feed bis zum Monatsanfang stilllegen, einmal Bescheid
 * sagen. Das Limit hängt am KONTO, nicht an der Suchanfrage – weitere Quellen helfen nicht.
 * Betroffen ist NUR die Personensuche; Profilaufrufe, Annahmen und Postfach laufen weiter.
 *
 * WICHTIG fürs Debuggen: Das Schadensbild ("0 Profile gefunden") sieht exakt wie ein
 * gebrochener Selektor aus. Erst den Seitentext prüfen, dann den Selektor verdächtigen.
 */

/** Sätze, mit denen LinkedIn das erschöpfte Kontingent ankündigt (deutsche + englische UI). */
const MARKER = [
  "limit für profilsuchen erreicht",
  "monatliche limit für profilsuchen",
  "monatlichen limit für profilsuchen",
  "commercial use limit",
  "reached the monthly limit",
  "monthly limit for profile searches",
];

const SCHLUESSEL = "such_limit_bis";

/** Erkennt den Hinweis im Seitentext. Rein, damit testbar. */
export function istSuchlimitText(text: string): boolean {
  const t = String(text || "").toLowerCase().replace(/\s+/g, " ");
  return MARKER.some((m) => t.includes(m));
}

/** Lokales ISO-Datum. Bewusst NICHT toISOString – das rechnet in UTC und kippt abends den Tag. */
export function isoTag(zeit = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${zeit.getFullYear()}-${p(zeit.getMonth() + 1)}-${p(zeit.getDate())}`;
}

/** Erster Tag des Folgemonats – dann setzt LinkedIn das Kontingent zurück. Rein. */
export function naechsterMonatsanfang(zeit = new Date()): string {
  return isoTag(new Date(zeit.getFullYear(), zeit.getMonth() + 1, 1));
}

/**
 * Bis wann die Suche pausiert, oder null. Ein abgelaufener Vermerk wird beim Lesen
 * aufgeräumt – so braucht es keinen eigenen Cron, der zum Monatsersten aufräumt.
 */
export function suchlimitBis(jetzt = new Date()): string | null {
  const bis = getState(SCHLUESSEL);
  if (!bis) return null;
  if (isoTag(jetzt) >= bis) {
    setState(SCHLUESSEL, "");
    console.info("[feed] LinkedIn-Suchlimit zurückgesetzt – die Lead-Suche läuft wieder.");
    return null;
  }
  return bis;
}

/**
 * Vermerkt das erreichte Limit und meldet es GENAU EINMAL (ein bestehender Vermerk wird nicht
 * verlängert – sonst schöbe jeder weitere Treffer das Ende vor sich her und die Meldung käme
 * bei jedem Lauf erneut).
 */
export function markiereSuchlimit(jetzt = new Date()): void {
  if (suchlimitBis(jetzt)) return;
  const bis = naechsterMonatsanfang(jetzt);
  setState(SCHLUESSEL, bis);
  console.warn(`[feed] LinkedIn-Suchlimit erreicht – Lead-Suche pausiert bis ${bis}.`);
  events.emit("feed:suchlimit", { bis });
}
