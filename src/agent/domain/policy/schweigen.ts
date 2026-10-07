/**
 * SCHWEIGEN – wann die beste Antwort KEINE Antwort ist (2026-10-07).
 *
 * Auslöser: Sinan stellt den Bot auf Voll-Automatik und will sich nicht mehr kümmern. Bis hierhin
 * hat der Agent auf JEDE eingehende Nachricht reagiert – auch auf Recruiter, Software-Verkäufer,
 * Abwesenheitsnotizen und ein freundliches „Danke, dir auch“. Ein Mensch antwortet darauf nicht.
 *
 * Reine Logik, keine I/O. Zwei Stufen:
 *  - DAUERHAFT: der Thread wird stummgeschaltet (Tabelle `stumm`), der Agent fasst ihn nie wieder an.
 *    Gründe: ausdrücklicher Kontakt-Stopp, automatische Nachricht, fremdes Angebot.
 *  - EINMALIG: auf DIESE Nachricht nichts schreiben, Gespräch bleibt offen. Gründe: freundlicher
 *    Schlusspunkt, reine Kurz-Reaktion ohne Frage.
 * Die deterministischen Muster greifen auch bei KI-Ausfall; die KI-Intents ergänzen sie.
 */
import type { IntentSet } from "../intent.js";
import { CHANCEN_INTENTS } from "../intent.js";
import type { Stage } from "../state.js";

export type SchweigeQuelle = "kontaktverbot" | "automatisch" | "fremdes_angebot" | "gespraechsende" | "reaktion";
export interface Schweigen {
  art: "dauerhaft" | "einmalig";
  quelle: SchweigeQuelle;
  grund: string; // Klartext fürs Log, Telegram und die Kontaktspur
}

/** Ausdrücklicher Wunsch, nicht mehr angeschrieben zu werden – darauf kommt KEIN Abschiedsgruß mehr. */
const KONTAKTVERBOT =
  /(?:nicht mehr|nie wieder|nicht weiter)\s+(?:kontaktier|anschreib|anzuschreib|schreib|meld|belästig)|lass(?:en sie|t)?\s+mich\s+(?:bitte\s+)?in ruhe|keine weiteren nachrichten|h(?:ö|oe)r(?:en sie)?\s+(?:bitte\s+)?auf,?\s+mir zu schreiben|stop(?:p)?\s+(?:messaging|contacting)\s+me|do not contact me|unsubscribe me/i;

/** Marker automatischer oder massenhafter Nachrichten. */
const AUTOMATISCH =
  /\b(?:abwesenheitsnotiz|automatische (?:antwort|nachricht|benachrichtigung)|out of (?:the )?office|auto-?reply|automated (?:message|reply)|this is an automated|gesponsert|sponsored|inmail|newsletter|unsubscribe|abmelden k(?:ö|oe)nnen|wurde(?:st)? zur gruppe hinzugef(?:ü|ue)gt|ich bin (?:bis|vom) .{0,40}(?:nicht erreichbar|im urlaub|außer haus|ausser haus))\b/i;

/** Nur eine kurze Reaktion ohne Inhalt: Emoji, „ok“, „danke“, „dir auch“. */
const NUR_REAKTION =
  /^(?:[\s\p{Extended_Pictographic}\p{P}]*|(?:ok(?:ay|i)?|danke(?: dir| ihnen| sch(?:ö|oe)n| sehr| gleichfalls)?|dir auch|ihnen auch|gerne|gern|alles klar|passt|top|super|perfekt|gleichfalls|ebenso|ebenfalls|vielen dank|dankesch(?:ö|oe)n|cool|nice|jo|jap|yes|ja|klar|okay dann|mach ich|machen wir)[\s!.…\p{Extended_Pictographic}]*)$/iu;

/** Phasen, in denen schon ein echtes Gespräch läuft. Ein „fremdes Angebot“ ist hier eher ein
 *  Themenwechsel eines echten Leads als Spam → an den Menschen, nicht stummschalten. */
const SPAETE_PHASEN: ReadonlySet<Stage> = new Set(["bedarf", "vertrauen", "validierung", "einwand", "call_angebot", "nummer", "termin"]);
export const istSpaetePhase = (s: Stage): boolean => SPAETE_PHASEN.has(s);

const normal = (t: string): string => String(t || "").replace(/\s+/g, " ").trim();

/**
 * Stufe 1 – VOR jeder anderen Entscheidung: Gibt es einen Grund, diesen Thread dauerhaft ruhen zu
 * lassen? Läuft bewusst vor der Termin-/Kontakt-Übergabe: die Telefonnummer eines Verkäufers ist
 * kein gebuchter Lead.
 */
export function dauerhaftSchweigen(intents: IntentSet, letzteNachricht: string): Schweigen | null {
  const text = normal(letzteNachricht);
  if (KONTAKTVERBOT.test(text)) return { art: "dauerhaft", quelle: "kontaktverbot", grund: "Person möchte nicht mehr angeschrieben werden" };
  if (AUTOMATISCH.test(text) || intents.includes("automatische_nachricht")) {
    return { art: "dauerhaft", quelle: "automatisch", grund: "Automatische oder Massen-Nachricht, kein Gespräch" };
  }
  if (intents.includes("fremdes_angebot")) {
    return { art: "dauerhaft", quelle: "fremdes_angebot", grund: "Person will selbst etwas verkaufen oder anbieten" };
  }
  return null;
}

/**
 * Stufe 2 – NACH Termin-/Kontakt-Prüfung: Ist das Gespräch an einem natürlichen Ende, bei dem eine
 * weitere Nachricht nur aufdringlich wäre? Nie, wenn eine Chance, Frage oder ein Einwand drinsteckt.
 */
export function einmaligSchweigen(intents: IntentSet, letzteNachricht: string, ctx: { eigeneNachrichten: number }): Schweigen | null {
  const offen =
    intents.some((i) => CHANCEN_INTENTS.has(i)) ||
    intents.includes("termin_zusage") || intents.includes("kontakt_geteilt") ||
    intents.includes("preisfrage") || intents.includes("skepsis");
  if (offen) return null;
  const text = normal(letzteNachricht);
  if (text.includes("?")) return null; // eine Frage verdient immer eine Antwort
  if (intents.includes("gespraechsende")) {
    return { art: "einmalig", quelle: "gespraechsende", grund: "Freundlicher Schlusspunkt ohne Frage – eine weitere Nachricht wäre aufdringlich" };
  }
  if (ctx.eigeneNachrichten > 0 && text.length <= 40 && NUR_REAKTION.test(text)) {
    return { art: "einmalig", quelle: "reaktion", grund: "Nur eine kurze Reaktion ohne Frage – keine Antwort nötig" };
  }
  return null;
}
