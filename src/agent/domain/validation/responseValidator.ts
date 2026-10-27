/**
 * RESPONSE VALIDATOR – prüft die generierte Antwort VOR dem Senden gegen deine Regeln.
 * Baut auf `nachrichtCheck` (Kauderwelsch/Länge) auf und ergänzt das, was einen Sales-Agent
 * ausmacht: keine Floskeln, keine Verkaufssprache, höchstens EINE Frage, keine im aktuellen
 * State verbotene Aktion (z.B. zu früh nach der Nummer fragen), keine Wiederholung.
 *
 * Ergebnis: {ok, gruende[]}. Bei !ok regeneriert der Orchestrator (Gründe an den Prompt) –
 * nach N Versuchen wird an den Menschen eskaliert. Reine Logik.
 */
import { istPlausibleNachricht } from "../../../core/nachrichtCheck.js";
import type { Stage } from "../state.js";
import { STAGE_DEF } from "../state.js";
import { istWiederholung } from "../policy/riskEngine.js";

/** ChatGPT-/Floskel-Marker, die eine Nachricht sofort unecht wirken lassen. */
export const FLOSKELN = [
  "als ki", "als sprachmodell", "ich hoffe, diese nachricht", "ich hoffe, es geht dir gut",
  "ich hoffe, es geht dir", "ich hoffe, du hattest", "zögere nicht", "zögern sie nicht",
  "stehe dir jederzeit", "stehe ich dir", "jederzeit zur verfügung", "gerne zur verfügung",
  "ich freue mich, von dir zu hören", "in diesem sinne", "abschließend", "zusammenfassend",
  "ich hoffe, das hilft", "lass es mich wissen", "melde dich gerne jederzeit",
];

/** Verkaufs-/Marketingsprache – für einen Erst-Kontakt tabu. */
export const VERKAUFSSPRACHE = [
  "exklusiv", "einzigartige gelegenheit", "einmalige chance", "mehrwert", "synergie",
  "potenzial ausschöpfen", "marktführend", "revolutionär", "no-brainer", "garantiert",
  "profitier", "unverbindliches beratungsgespräch", "attraktives angebot", "top-angebot",
  "beste entscheidung", "nicht verpassen", "jetzt zugreifen",
];

import type { Aktion } from "../state.js";

/** Textmuster, an denen man eine (evtl. verbotene) Aktion in der Antwort erkennt. */
// NUR das Erfragen der Nummer/des Kanals (NICHT das Anbieten eines Calls – das ist CALL_ANBIETEN).
const NUMMER_FRAGE = /(deine|eine|die)\s+(telefon)?nummer|telefonnummer|handynummer|ruf(e|st)?\s+(dich|ich)|schick.{0,12}nummer|gib mir\s+.{0,12}nummer|whats\s?app/i;
const CALL_ANBIETEN = /(lass uns\s+.{0,20}(telefonier|call|kurz sprechen|quatschen)|kurz\s+(telefonier|sprechen|quatschen)|hättest du\s+.{0,20}(zeit|lust).{0,20}(call|telefon|sprechen)|wollen wir\s+.{0,20}(telefonier|sprechen)|magst du\s+.{0,20}telefonier)/i;
const TERMIN_MUSTER = /(passt (dir|es)\s+.{0,30}uhr|dann machen wir\s+.{0,20}(fest|aus)|termin\s+.{0,15}(fix|bestätig|steht)|wir sagen\s+.{0,15}uhr|(montag|dienstag|mittwoch|donnerstag|freitag|morgen)\s+um\s+\d)/i;
/**
 * ANGEBOT IM TEXT (2026-10-27, Sinan: „der Bot pitcht zu schnell … das darf nicht an Nachrichten
 * festgemacht werden, sondern am Stand des Leads“). Vorher erkannte `call_anbieten` nur „lass uns
 * telefonieren“ – ein Angebot der Potenzialanalyse, eines kostenlosen Gesprächs oder ein Buchungslink
 * rutschte in JEDER Phase durch. Jetzt zählt jedes Angebot als `call_anbieten` und ist damit überall
 * verboten, wo der Lead-Stand es noch nicht hergibt (siehe STAGE_DEF: erst ab „call_angebot“).
 */
export const ANGEBOT_MUSTER = /(potenzial-?analyse|potentialanalyse|\b(die|eine|meine|unsere|so eine|diese)\s+analyse\b|\banalyse\s+(machen|ausfüllen|ausfuellen|anschauen|testen)|auswertungs(gespräch|gespraech|termin)|kostenlose[nms]?\s+(gespräch|gespraech|termin|analyse|check|beratung|call|telefonat)|beratungs(gespräch|gespraech|termin)|gehalts-?check|karriere-?check|zugangscode|buchungslink|calendly|termin\s+(aus)?(machen|vereinbaren|finden|buchen))/i;

const ANGEBOT_ODER_CALL = new RegExp(`${CALL_ANBIETEN.source}|${ANGEBOT_MUSTER.source}`, "i");
/** Enthält der Text ein Angebot (Analyse, Gespräch, Termin, Telefonat, Buchungslink)? */
export const enthaeltAngebot = (text: string) => ANGEBOT_ODER_CALL.test(text);
/** Darf in dieser Phase angeboten werden? Einzige Quelle: STAGE_DEF (Lead-Stand), nie eine Nachrichtenzahl. */
export const angebotErlaubt = (stage: Stage) => !STAGE_DEF[stage].verboten.includes("call_anbieten");

const AKTIONS_MUSTER: Partial<Record<Aktion, RegExp>> = {
  nummer_fragen: NUMMER_FRAGE,
  call_anbieten: ANGEBOT_ODER_CALL,
  termin_bestaetigen: TERMIN_MUSTER,
  frage_stellen: /\?/,
};

export interface ValidatorKontext {
  stage: Stage;
  letzteEigene: string[]; // eigene letzte Nachrichten (Wiederholungs-Check)
}

export interface ValidatorErgebnis { ok: boolean; gruende: string[] }

export function validiereAntwort(reply: string, ctx: ValidatorKontext): ValidatorErgebnis {
  const gruende: string[] = [];
  const text = (reply ?? "").trim();
  const low = text.toLowerCase();

  // 1) Grund-Plausibilität (Kauderwelsch/Länge/Fehlertext) aus der bestehenden Sicherheitsschicht.
  const plaus = istPlausibleNachricht(text);
  if (!plaus.ok) gruende.push(`unplausibel: ${plaus.grund}`);

  // 2) Länge: LinkedIn-DM soll kurz sein.
  if (text.length > 600) gruende.push("zu lang – kürzer, wie eine echte DM");

  // 3) höchstens EINE Frage.
  if ((text.match(/\?/g) || []).length > 1) gruende.push("mehr als eine Frage – auf eine reduzieren");

  // 4) keine Aufzählungen/Bullet-Listen im Chat.
  if (/(^|\n)\s*[-*•]\s+/.test(text) || /\n.*\n.*\n/.test(text)) gruende.push("wirkt wie Liste/Absätze – als eine lockere DM schreiben");

  // 5) Floskeln / ChatGPT-Ton.
  const floskel = FLOSKELN.find((f) => low.includes(f));
  if (floskel) gruende.push(`Floskel/ChatGPT-Ton: "${floskel}"`);

  // 6) Verkaufssprache.
  const verkauf = VERKAUFSSPRACHE.find((v) => low.includes(v));
  if (verkauf) gruende.push(`Verkaufssprache: "${verkauf}"`);

  // 7) passt zum State? JEDE in dieser Phase verbotene Aktion wird im Text erkannt & blockiert
  //    (zu früh nach Nummer fragen, Call anbieten, Termin bestätigen, oder in "verloren" nachfragen).
  for (const aktion of STAGE_DEF[ctx.stage].verboten) {
    const rx = AKTIONS_MUSTER[aktion];
    if (rx && rx.test(text)) gruende.push(`Aktion "${aktion}" ist in Phase "${ctx.stage}" verboten (passt nicht zum State)`);
  }

  // 8) nicht jede Nachricht mit einer Frage beenden (deine Humanizer-Regel).
  if (text.endsWith("?") && ctx.letzteEigene.length >= 2 && ctx.letzteEigene.slice(-2).every((m) => m.trim().endsWith("?")))
    gruende.push("schon wieder mit einer Frage beenden – variieren, nicht jede Nachricht als Frage");

  // 9) Wiederholung einer der letzten eigenen Nachrichten.
  if (istWiederholung(text, ctx.letzteEigene)) gruende.push("wiederholt (fast) eine frühere Nachricht");

  return { ok: gruende.length === 0, gruende };
}
