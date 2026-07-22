/**
 * SICHERHEITSSCHICHT für ausgehende Nachrichten.
 *
 * Warum das existiert: Menschen vertrauen dem Nutzer ihren LinkedIn-Namen an. Eine
 * Kauderwelsch-Nachricht ("Hbdjknhefdb34 ...") oder eine doppelt verschickte Nachricht
 * ist eine Blamage, die dieses Vertrauen sofort zerstört. Deshalb MUSS jede ausgehende
 * Nachricht durch diese Prüfung – im Zweifel wird NICHT gesendet, sondern an den Menschen
 * eskaliert. Lieber eine Nachricht zu wenig als eine peinliche zu viel.
 */

/** Fehler, der einen Versand hart abbricht, weil der Text nicht sicher ist. */
export class UnsichereNachricht extends Error {
  constructor(public grund: string) {
    super(`Unsichere Nachricht abgelehnt: ${grund}`);
    this.name = "UnsichereNachricht";
  }
}

const FEHLER_MARKER =
  /\b(undefined|null|NaN|\[object|error:|exception|traceback|api[_-]?key|prompt:|generatecontent|503|429|<[a-z]+>)\b/i;

/**
 * Prüft, ob ein Text eine plausible, menschliche Nachricht ist (kein Kauderwelsch, kein
 * Fehler-/Platzhaltertext, keine Roh-Ausgabe). Bewusst STRENG: im Zweifel ablehnen.
 * Rückgabe: { ok } oder { ok:false, grund }.
 */
export function istPlausibleNachricht(text: string): { ok: boolean; grund?: string } {
  const t = (text ?? "").trim();

  if (t.length < 12) return { ok: false, grund: "zu kurz" };
  if (t.length > 1500) return { ok: false, grund: "zu lang" };
  if (FEHLER_MARKER.test(t)) return { ok: false, grund: "Fehler-/Platzhaltertext erkannt" };

  const woerter = t.split(/\s+/).filter(Boolean);
  if (woerter.length < 3) return { ok: false, grund: "zu wenige Wörter" };

  // Der Text muss überwiegend aus Buchstaben/Satzzeichen bestehen (nicht aus Symbolen/Zahlen).
  const ohneLeer = t.replace(/\s/g, "");
  const buchstaben = (t.match(/[a-zäöüß]/gi) ?? []).length;
  if (buchstaben < ohneLeer.length * 0.5) return { ok: false, grund: "zu viele Nicht-Buchstaben" };

  // Vokal-Anteil: echtes Deutsch ~35–45 %. Tastatur-Kauderwelsch liegt weit darunter.
  const vokale = (t.match(/[aeiouäöü]/gi) ?? []).length;
  const vokalAnteil = buchstaben ? vokale / buchstaben : 0;
  if (vokalAnteil < 0.22) return { ok: false, grund: "unnatürliche Buchstabenfolge (Kauderwelsch)" };

  // Wörter mit Ziffern MITTENDRIN ("db34bhbuh") sind in echter Prosa praktisch nie.
  const zifferMix = woerter.filter((w) => /[a-zäöü]/i.test(w) && /\d/.test(w)).length;
  if (zifferMix >= 2) return { ok: false, grund: "Buchstaben-Ziffern-Mix (Kauderwelsch)" };

  // Lange Konsonantenketten (>=6) = Tastatur-Mashing.
  if (/[bcdfghjklmnpqrstvwxyzßñ]{6,}/i.test(t)) return { ok: false, grund: "lange Konsonantenkette" };

  // Mehrere längere Wörter ganz ohne Vokal = Kauderwelsch.
  const vokallos = woerter.filter((w) => w.length >= 4 && !/[aeiouäöüy]/i.test(w)).length;
  if (vokallos >= 2) return { ok: false, grund: "vokallose Wörter" };

  return { ok: true };
}
