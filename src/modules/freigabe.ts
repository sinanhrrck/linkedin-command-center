import { zgBedingung } from "../core/zielgruppenRegel.js";
import { db, getState, setState } from "../db/index.js";
import { approveDraft, getDraft } from "./drafts.js";
import { pruefeAusgehend } from "../core/ausgehendCheck.js";
import { erlaubteLinks } from "./angebot.js";
import { followupPlan } from "./playbook.js";
import { events } from "../core/events.js";

/**
 * FREIGABE-STAU ABBAUEN (2026-09-23, Phase 3).
 *
 * Gemessen: 126 Entwürfe warteten auf Sinan, während der Bot 598 Leads in der Schlange hatte.
 * Nicht der Bot war der Engpass, sondern die Einzelprüfung. Drei Hebel, alle ohne den
 * Versandweg anzufassen – gesendet wird weiterhin nur über sendApprovedDrafts → Governor:
 *  1. VERFALL: Eine Nachfassung, die 10 Tage ungeprüft liegt, passt nicht mehr zum Zeitpunkt.
 *     Sie verfällt ('expired') und wird bei Fälligkeit frisch geschrieben, statt den Stapel
 *     dauerhaft aufzublähen. Kein Lernsignal, kein Ablehnungsgrund.
 *  2. SAMMEL-FREIGABE: mehrere Entwürfe mit einem Klick, jeder einzeln durch approveDraft
 *     (inkl. Kontextprüfung) – eine Sperre bei einem blockiert nicht die anderen.
 *  3. AUTOMATISCHE FREIGABE (Opt-in, Standard AUS): nur für eingeschaltete Arten, nach einer
 *     Karenzzeit, nur mit bestandener Ausgangsprüfung, gedeckelt pro Tag – und erst, wenn Sinan
 *     diese Art vorher oft genug UNVERÄNDERT genehmigt hat („verdientes Vertrauen“).
 */

export const VERFALL_TAGE = 10;

export function lasseAlteNachfassungenVerfallen(tage = VERFALL_TAGE): number {
  return db.prepare(
    `UPDATE drafts SET status='expired'
      WHERE status='pending' AND kind='followup' AND COALESCE(phase,'message')='message'
        AND created_at < datetime('now', ?)`,
  ).run(`-${tage} days`).changes;
}

export function approveMany(ids: unknown): { ok: number[]; blockiert: { id: number; grund: string }[] } {
  const liste = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 50);
  const ok: number[] = [];
  const blockiert: { id: number; grund: string }[] = [];
  for (const id of liste) {
    const d = getDraft(id);
    if (!d || d.status !== "pending") { blockiert.push({ id, grund: "nicht mehr offen" }); continue; }
    if (approveDraft(id)) ok.push(id);
    else blockiert.push({ id, grund: getDraft(id)?.blockiert_grund || "kann nicht freigegeben werden" });
  }
  return { ok, blockiert };
}

// ---------------------------------------------------------------------------------------------
// Automatische Freigabe
// ---------------------------------------------------------------------------------------------

export type AutoFreigabe = { followup: boolean; first: boolean; tagesCap: number; karenzMin: number };
export const AUTO_STANDARD: AutoFreigabe = { followup: false, first: false, tagesCap: 10, karenzMin: 60 };
export const AUTO_ARTEN = ["followup", "first"] as const;
/** Ab so vielen eigenen Entscheidungen und dieser Quote unverändert genehmigter Texte. */
export const VERTRAUEN = { minEntscheidungen: 10, minQuote: 0.8, tage: 60 } as const;

export function autoFreigabeEinstellung(): AutoFreigabe {
  try {
    const roh = JSON.parse(getState("auto_freigabe") || "{}") as Partial<AutoFreigabe>;
    return normalisiereAuto(roh);
  } catch { return { ...AUTO_STANDARD }; }
}

function normalisiereAuto(roh: Partial<AutoFreigabe>): AutoFreigabe {
  const zahl = (v: unknown, min: number, max: number, std: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : std;
  };
  return {
    followup: roh.followup === true,
    first: roh.first === true,
    tagesCap: zahl(roh.tagesCap, 1, 30, AUTO_STANDARD.tagesCap),
    karenzMin: zahl(roh.karenzMin, 15, 1440, AUTO_STANDARD.karenzMin),
  };
}

export function speichereAutoFreigabe(roh: unknown): AutoFreigabe {
  const e = normalisiereAuto((roh || {}) as Partial<AutoFreigabe>);
  setState("auto_freigabe", JSON.stringify(e));
  return e;
}

/**
 * Wie oft hat Sinan diese Art zuletzt UNVERÄNDERT genehmigt? Nur menschliche Entscheidungen
 * zählen – sonst würde die Automatik ihr eigenes Vertrauen erzeugen.
 */
export function vertrauen(kind: string): { entscheidungen: number; unveraendert: number; quote: number; erreicht: boolean } {
  const r = db.prepare(
    `SELECT
        SUM(CASE WHEN status IN ('approved','sent') THEN 1 WHEN status='discarded' THEN 1 ELSE 0 END) AS entscheidungen,
        SUM(CASE WHEN status IN ('approved','sent') AND ki_original IS NOT NULL AND TRIM(draft)=TRIM(ki_original) THEN 1 ELSE 0 END) AS unveraendert
       FROM drafts
      WHERE kind=? AND COALESCE(freigabe_quelle,'mensch')='mensch' AND COALESCE(phase,'message')='message'
        AND created_at >= datetime('now', ?)`,
  ).get(kind, `-${VERTRAUEN.tage} days`) as { entscheidungen: number | null; unveraendert: number | null };
  const entscheidungen = r.entscheidungen || 0;
  const unveraendert = r.unveraendert || 0;
  const quote = entscheidungen ? unveraendert / entscheidungen : 0;
  return { entscheidungen, unveraendert, quote, erreicht: entscheidungen >= VERTRAUEN.minEntscheidungen && quote >= VERTRAUEN.minQuote };
}

export function autoHeute(): number {
  return (db.prepare(
    "SELECT COUNT(*) n FROM drafts WHERE freigabe_quelle='auto' AND freigegeben_at >= datetime('now','start of day')",
  ).get() as { n: number }).n;
}

/**
 * Gibt geeignete Entwürfe frei. Sendet NICHTS selbst – das macht sendApprovedDrafts über den
 * Governor. Gibt die Zahl der Freigaben zurück.
 */
export function autoFreigabe(now = new Date()): number {
  const e = autoFreigabeEinstellung();
  const arten = AUTO_ARTEN.filter((a) => e[a] && vertrauen(a).erreicht);
  if (!arten.length) return 0;
  let frei = Math.max(0, e.tagesCap - autoHeute());
  if (!frei) return 0;
  const karenz = new Date(now.getTime() - e.karenzMin * 60_000).toISOString().slice(0, 19).replace("T", " ");
  const kandidaten = db.prepare(
    `SELECT d.id, d.kind, d.draft, d.sequence_stage, c.full_name
       FROM drafts d LEFT JOIN contacts c ON c.id=d.contact_id
      WHERE d.status='pending' AND COALESCE(d.phase,'message')='message'
        AND d.kind IN (${arten.map(() => "?").join(",")})
        AND d.contact_id IS NOT NULL AND COALESCE(c.do_not_contact,0)=0
        AND ${zgBedingung("c")}
        AND d.created_at <= ?
      ORDER BY d.created_at LIMIT 50`,
  ).all(...arten, karenz) as { id: number; kind: "first" | "followup"; draft: string; sequence_stage: number | null; full_name: string | null }[];
  const plan = followupPlan();
  const namen: string[] = [];
  for (const k of kandidaten) {
    if (!frei) break;
    const pruef = pruefeAusgehend(k.draft, {
      kind: k.kind, vorname: k.full_name, erlaubteLinks: erlaubteLinks(),
      abschied: k.kind === "followup" && (k.sequence_stage ?? 1) >= plan.length,
    });
    if (!pruef.ok) continue; // bleibt beim Menschen
    if (approveDraft(k.id, undefined, "auto")) { frei--; namen.push(k.full_name || "Kontakt"); }
  }
  if (namen.length) {
    console.info(`[freigabe] ${namen.length} Entwurf/Entwürfe automatisch freigegeben`);
    events.emit("drafts:auto", { anzahl: namen.length, namen });
  }
  return namen.length;
}

/** Für die Cockpit-Karte. */
export function autoFreigabeStand() {
  return {
    einstellung: autoFreigabeEinstellung(),
    heute: autoHeute(),
    vertrauen: Object.fromEntries(AUTO_ARTEN.map((a) => [a, vertrauen(a)])),
    schwelle: VERTRAUEN,
  };
}
