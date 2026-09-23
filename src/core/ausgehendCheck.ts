import { istPlausibleNachricht } from "./nachrichtCheck.js";
import { FLOSKELN, VERKAUFSSPRACHE } from "../agent/domain/validation/responseValidator.js";

/**
 * PRÜFUNG AUSGEHENDER NACHRICHTEN (2026-09-23).
 *
 * Bisher bekam nur der Gesprächsagent eine echte Qualitätsprüfung. Erstnachricht, Nachfassung
 * und Reaktivierung liefen nur durch `istPlausibleNachricht` (Kauderwelsch-Schutz) – eine
 * Nachricht mit drei Fragen, einem erfundenen Link oder falschem Vornamen ging durch. Mit dem
 * neuen, vertrieblicheren Playbook steigt das Risiko, dass die KI übertreibt; genau das fängt
 * diese Prüfung ab. Reine Funktion, keine KI, keine Kosten.
 */

export type AusgehendKontext = {
  kind: "first" | "followup" | "reaktivierung";
  /** Letzte Nachfassung = Schlussstrich: keine Frage, sehr kurz. */
  abschied?: boolean;
  /** Vorname des Empfängers, um eine falsche Anrede zu erkennen. */
  vorname?: string | null;
  /** Links, die im Text stehen dürfen. Für diese Arten derzeit keine. */
  erlaubteLinks?: string[];
};

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}]/u;
const PLATZHALTER = /\[[^\]]{1,30}\]|\{\{[^}]*\}\}|\{[a-z_]+\}|<\s*(name|vorname|datum)\s*>/i;
const LINK = /https?:\/\/[^\s)]+/gi;

export function pruefeAusgehend(text: string, ctx: AusgehendKontext): { ok: boolean; gruende: string[] } {
  const t = String(text || "").trim();
  const gruende: string[] = [];
  const basis = istPlausibleNachricht(t);
  if (!basis.ok) gruende.push(basis.grund || "unbrauchbarer Text");

  if (EMOJI.test(t)) gruende.push("enthält ein Emoji");
  if (/\s[–—-]\s/.test(t)) gruende.push("Gedankenstrich als Satztrenner");
  const fragen = (t.match(/\?/g) || []).length;
  if (ctx.abschied && fragen > 0) gruende.push("der Schlussstrich darf keine Frage stellen");
  else if (fragen > 1) gruende.push(`${fragen} Fragen statt höchstens einer`);
  const max = ctx.abschied ? 260 : 480;
  if (t.length > max) gruende.push(`zu lang (${t.length} statt höchstens ${max} Zeichen)`);
  if (PLATZHALTER.test(t)) gruende.push("ungefüllter Platzhalter");

  const low = t.toLowerCase();
  const floskel = FLOSKELN.find((f) => low.includes(f));
  if (floskel) gruende.push(`Floskel „${floskel}“`);
  const verkauf = VERKAUFSSPRACHE.find((v) => low.includes(v));
  if (verkauf) gruende.push(`Verkaufssprache „${verkauf}“`);

  const erlaubt = new Set((ctx.erlaubteLinks || []).map((l) => l.replace(/\/$/, "")));
  for (const link of t.match(LINK) || []) {
    if (!erlaubt.has(link.replace(/[.,!?]+$/, "").replace(/\/$/, ""))) gruende.push(`Link, der nicht hinterlegt ist: ${link}`);
  }

  // Falsche Anrede: „Hey Jonas“ an Max ist schlimmer als gar keine Anrede.
  const vorname = String(ctx.vorname || "").trim().split(/\s+/)[0];
  const anrede = t.match(/^(hey|hi|hallo|servus|moin)\s+([A-ZÄÖÜ][\wäöüß-]+)/i);
  if (vorname && anrede && anrede[2].toLowerCase() !== vorname.toLowerCase()) {
    gruende.push(`falscher Name in der Anrede („${anrede[2]}“ statt „${vorname}“)`);
  }
  return { ok: gruende.length === 0, gruende };
}
