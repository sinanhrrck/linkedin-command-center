import { db, getState, setState } from "../db/index.js";
import { generateText } from "../core/textLlm.js";
import { bericht } from "./berichte.js";
import { variantenStatistik } from "./varianten.js";
import { followupPlan } from "./playbook.js";
import { leadMagnete } from "./angebot.js";
import { getProfil } from "../profil.js";

/**
 * KI-WOCHENANALYSE (2026-09-23): einmal pro Woche liest die KI, was passiert ist – Zahlen der
 * Vorwoche, welche Stile wirken, warum Sinan Entwürfe abgelehnt hat, was Leute wirklich
 * geantwortet haben – und gibt DREI konkrete, umsetzbare Verbesserungen mit dem Ort im Cockpit.
 *
 * Gespeichert wird nur das Ergebnis (State `ki_wochenanalyse`), damit Cockpit und Telegram
 * dasselbe zeigen und kein zweiter KI-Aufruf nötig ist. Antworttexte gehen gekürzt und ohne
 * Namen in den Prompt – die KI braucht den Inhalt, nicht die Person.
 */

export type Empfehlung = { titel: string; warum: string; wo: string };
export type WochenAnalyse = { at: string; zeitraum: string; kurzfazit: string; empfehlungen: Empfehlung[] };

const vorTagen = (t: number) => new Date(Date.now() - t * 86_400_000);
const isoTag = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }); // YYYY-MM-DD

export function letzteAnalyse(): WochenAnalyse | null {
  try { return JSON.parse(getState("ki_wochenanalyse") || "null"); } catch { return null; }
}

function analyseDaten(): string {
  const woche = bericht("woche", isoTag(vorTagen(7)));
  const ablehnungen = db.prepare(
    `SELECT reason, COUNT(*) n FROM draft_feedback WHERE created_at >= datetime('now','-14 days') GROUP BY reason ORDER BY n DESC`,
  ).all() as { reason: string; n: number }[];
  const wuensche = (db.prepare(
    `SELECT instruction FROM draft_feedback WHERE created_at >= datetime('now','-14 days') AND TRIM(COALESCE(instruction,''))<>'' ORDER BY id DESC LIMIT 8`,
  ).all() as { instruction: string }[]).map((r) => `- ${r.instruction.slice(0, 160)}`);
  // Echte Antworten (Inhalt ohne Namen): eingehende Nachrichten der letzten 14 Tage.
  const antworten = (db.prepare(
    `SELECT incoming, intent FROM drafts WHERE kind='message' AND TRIM(COALESCE(incoming,''))<>'' AND incoming NOT LIKE 'campaign:%'
       AND created_at >= datetime('now','-14 days') ORDER BY id DESC LIMIT 15`,
  ).all() as { incoming: string; intent: string | null }[]).map((r) => `- [${r.intent || "?"}] ${r.incoming.replace(/\s+/g, " ").slice(0, 200)}`);
  const unveraendert = db.prepare(
    `SELECT kind, SUM(CASE WHEN ki_original IS NOT NULL AND TRIM(draft)=TRIM(ki_original) THEN 1 ELSE 0 END) u, COUNT(*) n
       FROM drafts WHERE status IN ('approved','sent') AND COALESCE(freigabe_quelle,'mensch')='mensch' AND created_at >= datetime('now','-14 days') GROUP BY kind`,
  ).all() as { kind: string; u: number; n: number }[];
  const varianten = variantenStatistik().map((s) => `${s.slot}: ${s.arme.map((a) => `${a.titel} ${a.gesendet} gesendet / ${a.reif} ausgewertet / ${a.positiv} positiv`).join(" | ")}`);
  return `WOCHENBERICHT:
${woche.text}

WAS WIRKT (Varianten-Test):
${varianten.join("\n")}

ABLEHNUNGSGRÜNDE (14 Tage): ${ablehnungen.map((a) => `${a.reason} ${a.n}×`).join(", ") || "keine"}
${wuensche.length ? `EIGENE ÄNDERUNGSWÜNSCHE:\n${wuensche.join("\n")}` : ""}
UNVERÄNDERT GENEHMIGT (14 Tage): ${unveraendert.map((r) => `${r.kind} ${r.u}/${r.n}`).join(", ") || "keine Daten"}

ECHTE ANTWORTEN (Auszug, ohne Namen):
${antworten.join("\n") || "- keine"}

EINSTELLUNGEN: Nachfass-Plan ${followupPlan().map((s) => `${s.nachTagen}T ${s.zweck}`).join(" → ")}. Aktive Angebote: ${leadMagnete().map((m) => m.titel).join(", ") || "keine"}. Belege: ${(getProfil().beweise || []).length}.`;
}

export async function kiWochenanalyse(): Promise<WochenAnalyse> {
  const daten = analyseDaten();
  const prompt = `Du bist ein erfahrener Vertriebscoach (Denkweise wie Alex Hormozi: Engpass finden, einen Hebel nach dem anderen, messbar). Analysiere die letzte Woche von ${getProfil().name}s LinkedIn-Akquise.

${daten}

AUFGABE:
- Finde den größten Engpass im Trichter (Annahme, Antwort, positive Antwort, Termin) und begründe ihn mit den Zahlen oben.
- Gib GENAU 3 konkrete Verbesserungen, jede mit Ort im Cockpit ("wo", z. B. "Einstellungen → Dein Angebot", "Einstellungen → Nachfass-Plan", "Heute → Schnellprüfung", "Auswertung → Was wirkt", "Einstellungen → Lead-Quellen").
- Nur Hebel, die das Tool bietet. NIEMALS Limits, Lese-Budget oder Arbeitszeiten erhöhen (Kontosperre-Risiko).
- Wenn Daten fehlen oder zu wenig sind: sag das ehrlich im Kurzfazit und empfiehl, was man tun kann, um mehr zu lernen.
- Deutsch, per Du, knapp.

Antworte AUSSCHLIESSLICH mit JSON:
{"kurzfazit":"2 Sätze","empfehlungen":[{"titel":"…","warum":"1–2 Sätze mit Bezug auf die Zahlen","wo":"…"}]}`;
  const roh = await generateText(prompt);
  const s = roh.indexOf("{"), e = roh.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error("Die KI hat keine verwertbare Analyse geliefert.");
  const x = JSON.parse(roh.slice(s, e + 1)) as { kurzfazit?: unknown; empfehlungen?: unknown };
  const empfehlungen = (Array.isArray(x.empfehlungen) ? x.empfehlungen : []).slice(0, 3).map((r) => {
    const o = (r || {}) as Record<string, unknown>;
    return { titel: String(o.titel ?? "").slice(0, 120), warum: String(o.warum ?? "").slice(0, 400), wo: String(o.wo ?? "").slice(0, 80) };
  }).filter((r) => r.titel);
  if (!empfehlungen.length) throw new Error("Die KI hat keine Empfehlungen geliefert.");
  const analyse: WochenAnalyse = {
    at: new Date().toISOString(),
    zeitraum: `${isoTag(vorTagen(14))} bis ${isoTag(new Date())}`,
    kurzfazit: String(x.kurzfazit ?? "").slice(0, 500),
    empfehlungen,
  };
  setState("ki_wochenanalyse", JSON.stringify(analyse));
  return analyse;
}

export function analyseAlsText(a: WochenAnalyse): string {
  return `🧠 KI-Wochenanalyse\n${a.kurzfazit}\n\n${a.empfehlungen.map((r, i) => `${i + 1}. ${r.titel}\n   ${r.warum}\n   → ${r.wo}`).join("\n\n")}`;
}
