/**
 * AGENT-VERTRAUEN (2026-10-07) – „erst zurückhaltend, mit jeder Freigabe freier“.
 *
 * Sinans Vorgabe: ein vorsichtiger Modus, in dem der Agent zunächst wenig selbst sendet, und je
 * mehr Sinan unverändert freigibt, desto weniger landet bei ihm. Dasselbe Prinzip wie die
 * Freigabe-Automatik für Erstnachrichten (modules/freigabe.ts `vertrauen`): gezählt werden NUR
 * Sinans eigene Entscheidungen über Agent-Entwürfe (Freigabe unverändert, Freigabe mit Änderung,
 * Ablehnung). Was der Agent selbst sendet, erzeugt kein Vertrauen – sonst würde er sich selbst
 * hochstufen.
 *
 * Stufen (Entscheidungen der letzten 60 Tage):
 *  0  alles zur Freigabe                       – Start
 *  1  Eröffnung/Smalltalk autonom              – ≥10 Entscheidungen, ≥80 % unverändert
 *  2  + Bedarf/Vertrauensaufbau                – ≥25, ≥80 %
 *  3  alles autonom (= „Gespräche automatisch“) – ≥50, ≥85 %
 * VETO: sind von den letzten 10 Entscheidungen mindestens 3 Ablehnungen, geht es eine Stufe
 * zurück – Sinan ist gerade unzufrieden, der Agent soll wieder mehr vorlegen.
 */
import { db } from "../db/index.js";
import type { Risiko } from "../agent/domain/policy/risiko.js";
import { RISIKO_REIHENFOLGE } from "../agent/domain/policy/risiko.js";

/** Entwürfe, die der Agent zur Freigabe vorgelegt hat (nicht: Eskalationen ohne Text, Sendefehler). */
export const AGENT_ENTWURF_INTENTS = ["agent-vorsichtig", "agent-schatten"] as const;

export const AGENT_STUFEN: ReadonlyArray<{ stufe: number; min: number; quote: number; autonom: Risiko[] }> = [
  { stufe: 0, min: 0, quote: 0, autonom: [] },
  { stufe: 1, min: 10, quote: 0.8, autonom: ["niedrig"] },
  { stufe: 2, min: 25, quote: 0.8, autonom: ["niedrig", "mittel"] },
  { stufe: 3, min: 50, quote: 0.85, autonom: ["niedrig", "mittel", "hoch"] },
];
export const VETO = { fenster: 10, ablehnungen: 3 } as const;
const TAGE = 60;

export interface AgentVertrauen {
  entscheidungen: number;
  unveraendert: number;
  geaendert: number;
  abgelehnt: number;
  quote: number;            // unverändert ÷ Entscheidungen
  stufe: number;            // wirksame Stufe (nach Veto)
  verdient: number;         // Stufe nach Zahlen, vor Veto
  veto: boolean;
  autonom: Risiko[];
  naechste: { stufe: number; fehlen: number; quote: number } | null;
}

type Row = { status: string; draft: string; ki_original: string | null; rejection_reason: string | null };

function entscheidungen(): Row[] {
  const platz = AGENT_ENTWURF_INTENTS.map(() => "?").join(",");
  return db.prepare(
    `SELECT status, draft, ki_original, rejection_reason
       FROM drafts
      WHERE intent IN (${platz})
        AND kind='message' AND COALESCE(phase,'message')='message'
        AND COALESCE(freigabe_quelle,'mensch')='mensch'
        AND ki_original IS NOT NULL AND TRIM(ki_original)<>''
        AND created_at >= datetime('now', ?)
        AND (status IN ('approved','sent')
             OR (status='discarded' AND COALESCE(rejection_reason,'') NOT IN ('stumm','expired')
                 AND COALESCE(rejection_reason,'') NOT LIKE 'relationship_%'))
      ORDER BY COALESCE(freigegeben_at, created_at) DESC, id DESC`,
  ).all(...AGENT_ENTWURF_INTENTS, `-${TAGE} days`) as Row[];
}

export function agentVertrauen(): AgentVertrauen {
  const rows = entscheidungen();
  const abgelehnt = rows.filter((r) => r.status === "discarded").length;
  const unveraendert = rows.filter((r) => r.status !== "discarded" && r.draft.trim() === (r.ki_original ?? "").trim()).length;
  const geaendert = rows.length - abgelehnt - unveraendert;
  const quote = rows.length ? unveraendert / rows.length : 0;

  let verdient = 0;
  for (const s of AGENT_STUFEN) if (rows.length >= s.min && quote >= s.quote) verdient = s.stufe;
  const juengste = rows.slice(0, VETO.fenster);
  const veto = juengste.filter((r) => r.status === "discarded").length >= VETO.ablehnungen;
  const stufe = veto ? Math.max(0, verdient - 1) : verdient;

  const folge = AGENT_STUFEN.find((s) => s.stufe === verdient + 1) ?? null;
  const naechste = folge ? { stufe: folge.stufe, fehlen: Math.max(0, folge.min - rows.length), quote: folge.quote } : null;
  return {
    entscheidungen: rows.length, unveraendert, geaendert, abgelehnt, quote,
    stufe, verdient, veto,
    autonom: AGENT_STUFEN[stufe].autonom,
    naechste,
  };
}

/** Darf der Agent eine Antwort dieses Risikos in der Stufe „vorsichtig“ selbst senden? */
export function darfAutonom(risiko: Risiko, v: AgentVertrauen = agentVertrauen()): boolean {
  return v.autonom.includes(risiko);
}

/** Für Cockpit/Telegram: was gerade von selbst geht, in Klartext. */
export function autonomText(v: AgentVertrauen): string {
  if (!v.autonom.length) return "Noch nichts – jede Antwort kommt zur Freigabe";
  if (v.autonom.length === RISIKO_REIHENFOLGE.length) return "Alles – wie „Gespräche automatisch“";
  return v.autonom.includes("mittel") ? "Eröffnung, Smalltalk, Bedarf und Vertrauensaufbau" : "Eröffnung und Smalltalk";
}
