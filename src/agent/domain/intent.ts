/**
 * INTENT-TAXONOMIE des neuen Sales-Agents.
 *
 * Anders als der alte `converseStep` (genau EIN Intent aus 6) erlaubt der neue Kern
 * MEHRERE Intents gleichzeitig – eine Nachricht kann „interesse + skepsis + ironie" sein.
 * Reine Daten/Typen, keine Logik mit Nebenwirkungen (Domänenschicht, testbar).
 */

/** Alle erkennbaren Intents. Mehrere gleichzeitig möglich (siehe IntentSet). */
export const INTENTS = [
  "interesse",            // echtes Interesse am Thema/Weg
  "karriere_interesse",   // Interesse an Job/Perspektive/Ausbildungsweg
  "investment_interesse", // Interesse an Geldanlage/Finanzen
  "skepsis",              // Zweifel, Vorsicht ("was willst du verkaufen?")
  "ironie",               // Spott/Sarkasmus – Ton, nicht Inhalt
  "smalltalk",            // lockeres Geplänkel ohne Richtung
  "ablehnung",            // freundliches oder klares Nein / Abschied
  "zeitmangel",           // "keine Zeit", "melde mich später", kurze Antworten
  "preisfrage",           // "was kostet das?", Konditionen
  "bereits_kunde",        // hat schon Berater/Produkt
  "offene_frage",         // stellt eine echte Frage, will Antwort
  "positives_signal",     // Zustimmung, Neugier, Öffnung
  "negatives_signal",     // Abwehr, Desinteresse, Reibung
  "termin_zusage",        // sagt Ja zu Telefonat/Termin
  "kontakt_geteilt",      // nennt Telefonnummer/E-Mail von sich aus
  // SCHWEIGE-INTENTS (2026-10-07): Fälle, in denen die beste Antwort KEINE Antwort ist.
  "fremdes_angebot",      // die Person will SINAN etwas verkaufen/anbieten (Recruiting, Dienstleistung, Software, Kooperation)
  "automatische_nachricht", // Massen-/Vorlagen-/Auto-Nachricht (Abwesenheit, Newsletter, Sponsored, Gruppen-Einladung)
  "gespraechsende",       // freundlicher Schlusspunkt ohne Frage ("Danke dir, alles Gute") – nichts mehr nötig
] as const;

export type Intent = (typeof INTENTS)[number];

/** Eine Nachricht kann mehrere Intents tragen. Leeres Set = nichts Klares erkannt. */
export type IntentSet = Intent[];

export function istGueltigerIntent(x: string): x is Intent {
  return (INTENTS as readonly string[]).includes(x);
}

/** Filtert eine rohe LLM-Liste auf gültige Intents (defensiv gegen Halluzination). */
export function saeubereIntents(roh: unknown): IntentSet {
  if (!Array.isArray(roh)) return [];
  return Array.from(new Set(roh.filter((x): x is Intent => typeof x === "string" && istGueltigerIntent(x))));
}

/** Harte Stopp-Intents: sobald einer davon da ist, wird NICHT weiterverkauft. */
export const STOPP_INTENTS: ReadonlySet<Intent> = new Set(["ablehnung", "bereits_kunde"]);

/** Intents, bei denen der Bot DAUERHAFT schweigt: hier ist niemand, mit dem ein Gespräch Sinn ergibt. */
export const SCHWEIGE_INTENTS: ReadonlySet<Intent> = new Set(["fremdes_angebot", "automatische_nachricht"]);

/** Intents, die „die Tür geht auf" bedeuten (Bedarf/Chance-Signal). */
export const CHANCEN_INTENTS: ReadonlySet<Intent> = new Set([
  "interesse", "karriere_interesse", "investment_interesse", "positives_signal", "offene_frage",
]);
