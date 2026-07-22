/**
 * RISK ENGINE – die Gesprächs-Sicherheit (getrennt vom safetyGovernor, der die Konto-Sicherheit
 * macht). Setzt deine harten Verbote um: NIE zu früh pitchen, NIE zu früh nach der Nummer fragen,
 * NIE denselben Satz wiederholen, NIE mehrfach hintereinander schreiben.
 *
 * Reine Logik – gibt {ok} oder {ok:false, grund} zurück. Der Orchestrator handelt danach
 * (Aktion herabstufen, regenerieren oder gar nicht senden).
 */
import type { Aktion } from "../state.js";
import { SCHWELLEN } from "../state.js";
import type { Scores } from "../scores.js";

export interface RiskKontext {
  antwortenDerPerson: number;       // Y: wie oft hat die Person geantwortet
  nachrichtenGesamt: number;        // X: Nachrichten im Thread
  offeneNachfragen: number;         // unsere Nachrichten ohne Antwort in Folge
  letzteEigene: string[];           // unsere letzten Nachrichten (für Wiederholungs-Check)
}

export interface RiskUrteil { ok: boolean; grund?: string }
const OK: RiskUrteil = { ok: true };

/** Nummer/Termin-Kanal nur, wenn ALLE Bedingungen erfüllt sind (deine Vorgabe). */
export function darfNachNummerFragen(s: Scores, k: RiskKontext): RiskUrteil {
  if (s.trust < SCHWELLEN.callTrust) return { ok: false, grund: `Vertrauen zu niedrig (${s.trust}<${SCHWELLEN.callTrust})` };
  if (s.interest < SCHWELLEN.callInterest) return { ok: false, grund: `Interesse zu niedrig (${s.interest}<${SCHWELLEN.callInterest})` };
  if (s.callReadiness < SCHWELLEN.callReadiness) return { ok: false, grund: `CallReadiness zu niedrig (${s.callReadiness}<${SCHWELLEN.callReadiness})` };
  if (k.antwortenDerPerson < SCHWELLEN.minAntworten) return { ok: false, grund: `zu wenige Antworten (${k.antwortenDerPerson}<${SCHWELLEN.minAntworten})` };
  if (k.offeneNachfragen > 0) return { ok: false, grund: "keine positive Dynamik (offene Nachfrage)" };
  return OK;
}

/** Darf diese Aktion JETZT ausgeführt werden? Kombiniert Schwellen + Dynamik. */
export function pruefeAktion(aktion: Aktion, s: Scores, k: RiskKontext): RiskUrteil {
  if (aktion === "nummer_fragen" || aktion === "termin_bestaetigen") return darfNachNummerFragen(s, k);
  if (aktion === "call_anbieten") {
    // Call anbieten ist weicher als Nummer fragen, aber nicht bei kaltem Lead.
    if (s.callReadiness < SCHWELLEN.callReadiness - 15) return { ok: false, grund: "noch nicht reif für ein Call-Angebot" };
  }
  return OK;
}

/** Wortmenge (normalisiert) für einen groben Ähnlichkeitsvergleich. */
function wortMenge(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^\wäöüß ]/g, "").split(/\s+/).filter((w) => w.length > 2));
}
function aehnlichkeit(a: string, b: string): number {
  const A = wortMenge(a), B = wortMenge(b);
  if (!A.size || !B.size) return 0;
  let schnitt = 0;
  for (const w of A) if (B.has(w)) schnitt++;
  return schnitt / new Set([...A, ...B]).size; // Jaccard
}

/** Wiederholt die geplante Nachricht (fast) eine der letzten? (deine Vorgabe: nie derselbe Satz) */
export function istWiederholung(reply: string, letzteEigene: string[]): boolean {
  const r = reply.trim().toLowerCase();
  return letzteEigene.some((e) => {
    const x = e.trim().toLowerCase();
    return x === r || aehnlichkeit(reply, e) >= 0.8;
  });
}

/** Schreiben wir gerade ins Leere? (mehrfach hintereinander ohne Antwort → nicht nachlegen) */
export function zuVieleUnbeantwortet(k: RiskKontext, maxOhneAntwort = 1): RiskUrteil {
  if (k.offeneNachfragen >= maxOhneAntwort) return { ok: false, grund: `${k.offeneNachfragen} Nachricht(en) ohne Antwort – nicht nachlegen` };
  return OK;
}
