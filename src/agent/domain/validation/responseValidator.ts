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
const FLOSKELN = [
  "als ki", "als sprachmodell", "ich hoffe, diese nachricht", "ich hoffe, es geht dir gut",
  "ich hoffe, es geht dir", "ich hoffe, du hattest", "zögere nicht", "zögern sie nicht",
  "stehe dir jederzeit", "stehe ich dir", "jederzeit zur verfügung", "gerne zur verfügung",
  "ich freue mich, von dir zu hören", "in diesem sinne", "abschließend", "zusammenfassend",
  "ich hoffe, das hilft", "lass es mich wissen", "melde dich gerne jederzeit",
];

/** Verkaufs-/Marketingsprache – für einen Erst-Kontakt tabu. */
const VERKAUFSSPRACHE = [
  "exklusiv", "einzigartige gelegenheit", "einmalige chance", "mehrwert", "synergie",
  "potenzial ausschöpfen", "marktführend", "revolutionär", "no-brainer", "garantiert",
  "profitier", "unverbindliches beratungsgespräch", "attraktives angebot", "top-angebot",
  "beste entscheidung", "nicht verpassen", "jetzt zugreifen",
];

/** Frage nach Telefon/Nummer/Call im Text erkannt? */
const NUMMER_FRAGE = /(deine|eine)\s+(telefon)?nummer|telefonnummer|handynummer|ruf(e|st)?\s+(dich|ich)|kurz\s+telefonier|per\s+telefon|am\s+telefon|schick.{0,12}nummer|whats\s?app/i;

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

  // 7) im aktuellen State verbotene Nummer-Frage.
  if (STAGE_DEF[ctx.stage].verboten.includes("nummer_fragen") && NUMMER_FRAGE.test(text))
    gruende.push(`fragt nach Nummer/Call – in Phase "${ctx.stage}" verboten (zu früh)`);

  // 8) Wiederholung einer der letzten eigenen Nachrichten.
  if (istWiederholung(text, ctx.letzteEigene)) gruende.push("wiederholt (fast) eine frühere Nachricht");

  return { ok: gruende.length === 0, gruende };
}
