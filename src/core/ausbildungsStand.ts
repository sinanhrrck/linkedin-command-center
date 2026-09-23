/**
 * AUSBILDUNGSSTAND AUS DER HEADLINE (2026-09-23)
 *
 * Auslöser: Der Erstnachricht-Prompt ging pauschal von Azubis aus. Bei Headlines wie
 * „Bankkaufmann bei Sparkasse Darmstadt" schrieb die KI dann „cool dass du deine Ausbildung
 * bei der Sparkasse Darmstadt machst" – real in 17 von 43 offenen Entwürfen, zwei davon
 * schon verschickt. „Bankkaufmann/-frau" ist aber der ABSCHLUSS, kein Azubi-Titel.
 *
 * Deshalb entscheidet hier fester Code, nicht die KI, ob jemand in der Ausbildung ist. Die
 * KI bekommt das Ergebnis als harte Vorgabe, und `behauptetLaufendeAusbildung` fängt Texte
 * ab, die sich trotzdem darüber hinwegsetzen.
 */

export type AusbildungsStand = "in_ausbildung" | "nicht_in_ausbildung" | "unklar";

/** Ausdrücklich abgeschlossen – schlägt jedes Azubi-Stichwort in derselben Headline. */
const ABGESCHLOSSEN = /abgeschlossen|ausgelernt|ehemalige?r?\s+(azubi|auszubildende)|ex[- ]azubi|former\s+apprentice/i;
const IN_AUSBILDUNG = /auszubild|azubi|\bin\s+ausbildung|ausbildung\s+(zum|zur|als|bei)|ausbildungs|lehrjahr|lehrling|\bdual(e|er|es)?\s+stud|\bdh?bw\b|trainee|apprentice/i;
/** Berufs- oder Studienbezeichnungen, die KEINE laufende Ausbildung bedeuten. */
const ANDERE_ROLLE = /bank\s?kauf(mann|frau|leute)|kaufmann|kauffrau|berater(in)?|betreuer(in)?|referent(in)?|spezialist(in)?|specialist|manager(in)?|analyst(in)?|sachbearbeiter(in)?|leiter(in)?|consultant|advisor|assistent(in)?|werkstudent(in)?|student(in)?|studium|studiert|bachelor|master|b\.\s?(a|sc)\.?|m\.\s?(a|sc)\.?|fachwirt(in)?|betriebswirt(in)?|finanzwirt(in)?/i;

export function ausbildungsStand(headline: string | null | undefined): AusbildungsStand {
  const h = String(headline || "");
  if (!h.trim()) return "unklar";
  if (ABGESCHLOSSEN.test(h)) return "nicht_in_ausbildung";
  if (IN_AUSBILDUNG.test(h)) return "in_ausbildung";
  if (ANDERE_ROLLE.test(h)) return "nicht_in_ausbildung";
  return "unklar";
}

/** Harte Vorgabe für den Prompt. */
export function ausbildungsVorgabe(headline: string | null | undefined): string {
  switch (ausbildungsStand(headline)) {
    case "in_ausbildung":
      return "AUSBILDUNGSSTAND (fest geprüft): Laut Profil ist die Person gerade in der Ausbildung. Darauf darfst du Bezug nehmen.";
    case "nicht_in_ausbildung":
      return `AUSBILDUNGSSTAND (fest geprüft, NICHT verhandelbar): Die Person ist NICHT in der Ausbildung. Eine Headline wie "Bankkaufmann bei X" oder "Bankkauffrau bei X" ist der fertige ABSCHLUSS, kein Azubi-Titel.
Schreibe NIEMALS, dass die Person eine Ausbildung macht, Azubi ist oder in einem Lehrjahr steckt. Kein "deine Ausbildung", kein "wie läuft die Ausbildung".
Sprich sie auf ihre JETZIGE Rolle an, zum Beispiel wie es nach der Ausbildung weiterging oder wie sie ihren Job gerade erlebt.`;
    default:
      return `AUSBILDUNGSSTAND (fest geprüft): Aus dem Profil geht NICHT hervor, ob die Person noch in der Ausbildung ist. Behaupte es nicht. Formuliere so, dass der Text in beiden Fällen stimmt (z. B. "wie erlebst du die Bank gerade?").`;
  }
}

/**
 * Behauptet der Text, der EMPFÄNGER sei gerade in der Ausbildung? Sinans eigene Geschichte
 * („ich hab damals als Azubi angefangen") und Rückblicke („nach deiner Ausbildung") sind erlaubt.
 */
export function behauptetLaufendeAusbildung(text: string): boolean {
  const t = String(text || "").replace(/\s+/g, " ");
  const muster = [
    /\b(machst|absolvierst|beginnst|startest)\b[^.!?]{0,50}\b(ausbildung|lehre)\b/i,
    /(?<!\b(nach|seit|vor|aus|während|mit)\s)\bdeine[rnms]?\s+(aktuellen?\s+|jetzigen?\s+)?(ausbildung|lehre|azubi)/i,
    /\blehrjahr/i,
    /\b(du bist|bist du)\b[^.!?]{0,40}\b(azubi|auszubildende[rn]?|in der ausbildung)\b/i,
    /\b(gerade|aktuell|momentan|noch)\b[^.!?]{0,25}\bin der ausbildung\b/i,
    /\bbei dir\b[^.!?]{0,30}\bin der ausbildung\b/i,
    /\bals azubi\b[^.!?]{0,30}\b(bei|in) (der|dem|deiner)\b/i,
  ];
  // Sätze in Ich-Form über Sinans eigene Zeit fallen raus.
  const saetze = t.split(/(?<=[.!?])\s+/).filter((s) => !/^\s*ich\b/i.test(s) || /\bdu\b|\bdeine?/i.test(s));
  return saetze.some((s) => muster.some((m) => m.test(s)));
}
