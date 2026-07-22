/**
 * HUMANIZER – macht eine Nachricht deterministisch „menschlicher", ohne den Inhalt zu verfälschen.
 *
 * Bewusst KONSERVATIV: harte Stilverstöße fängt der Validator (→ Regenerierung). Der Humanizer
 * macht nur sichere Aufräum-Schritte, die eine KI-Nachricht wie eine echte DM wirken lassen:
 * Grußformeln/Signaturen weg, keine Listen-Bindestriche, keine Doppel-Leerzeilen, nicht mit
 * einem förmlichen Gruß enden. Reine Logik.
 */

// Anreden/Grußformeln, die eine LinkedIn-DM steif machen (am Anfang oder Ende).
const GRUSS_START = /^(hallo|guten (morgen|tag|abend)|sehr geehrte[r]?)\b[^\n,!]*[,!]?\s*/i;
const GRUSS_ENDE = /\s*(beste grüße|viele grüße|liebe grüße|mit freundlichen grüßen|lg|vg|mfg|dein[e]? sinan|gruß,?\s*sinan)\b.*$/i;

export function humanize(text: string): string {
  let t = (text ?? "").replace(/\r/g, "").trim();

  // umschließende Anführungszeichen weg (falls die KI die Nachricht "gequotet" hat)
  t = t.replace(/^["'„»]+/, "").replace(/["'“«]+$/, "").trim();

  // steife Grußformeln am Anfang/Ende entfernen (LinkedIn-DMs fangen mittendrin an)
  t = t.replace(GRUSS_START, "").replace(GRUSS_ENDE, "").trim();

  // Listen-Bindestriche/Bullets in Fließtext auflösen
  t = t.replace(/(^|\n)\s*[-*•]\s+/g, "$1").trim();

  // Doppel-Leerzeilen und Mehrfach-Spaces glätten (eine lockere DM, kein Brief)
  t = t.replace(/\n{2,}/g, "\n").replace(/[ \t]{2,}/g, " ").trim();

  // Leerzeichen vor Satzzeichen weg
  t = t.replace(/\s+([,.!?])/g, "$1").trim();

  return t;
}
