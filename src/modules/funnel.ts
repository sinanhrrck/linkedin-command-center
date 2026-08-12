import { db } from "../db/index.js";
import { config } from "../config.js";
import { backfillCrmStages, FUNNEL_STAGES, POSITIVE_QUALITIES, REPLY_QUALITIES, type CrmStage, type ReplyQuality } from "./crmStages.js";

/**
 * EINHEITLICHES MESSMODELL (Phase 5.1/5.2).
 *
 * Alle Zahlen dieser Datei stammen aus GENAU EINER Quelle: `crm_stage_events`. Jede Zeile dort ist
 * ein Ereignis mit fachlichem Dedupe-Schlüssel, eingefrorener Zuordnung (Kampagne, Quelle, Ziel)
 * und Ereigniszeit. Daraus folgen die beiden Zusagen aus dem Zielbild:
 *
 *  1. Ein Ereignis wird nur einmal gezählt. Neustarts, wiederholte Ticks oder ein zweiter Fund
 *     desselben Kontakts schreiben denselben Schlüssel und werden ignoriert.
 *  2. Jeder Wert ist rückführbar: zu jeder Kennzahl liefert `contactsForStage` exakt die Kontakte,
 *     die sie erzeugt haben — mit demselben Filter und derselben Grundgesamtheit.
 *
 * Bewusst NICHT hier: Empfehlungen oder automatische Eingriffe. Dieses Modul misst nur.
 */

export type FunnelFilter = {
  campaignId?: number | null;
  goalCode?: string | null;
  sourceId?: number | null;
  zielgruppe?: string | null;
  /** ISO-Datum (einschließlich), gemessen an der Ereigniszeit, nicht am Schreibzeitpunkt. */
  from?: string | null;
  to?: string | null;
  /** network = bestehende Verbindung (kostete nie eine Anfrage), external = neu vernetzt. */
  route?: "network" | "external" | null;
  automation?: "active" | "paused" | "excluded" | null;
};

type Bedingung = { sql: string; args: unknown[] };

/**
 * Herkunft (Kampagne/Quelle/Ziel) wird am EREIGNIS gefiltert, weil sie dort unveränderlich ist.
 * Segmentmerkmale (Zielgruppe, Route, Automatik-Status) beschreiben dagegen den heutigen Zustand
 * einer Person und werden deshalb am Kontakt gefiltert.
 */
function bedingungen(filter: FunnelFilter): Bedingung {
  const teile: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, value: unknown) => { teile.push(sql); args.push(value); };

  if (filter.campaignId != null) add("e.campaign_id=?", filter.campaignId);
  if (filter.goalCode) add("e.goal_code=?", filter.goalCode);
  if (filter.sourceId != null) add("e.source_id=?", filter.sourceId);
  if (filter.zielgruppe) add("c.zielgruppe=?", filter.zielgruppe);
  if (filter.from) add("date(e.occurred_at)>=date(?)", filter.from);
  if (filter.to) add("date(e.occurred_at)<=date(?)", filter.to);
  if (filter.route === "network") teile.push("COALESCE(c.aus_netzwerk,0)=1");
  if (filter.route === "external") teile.push("COALESCE(c.aus_netzwerk,0)=0");
  if (filter.automation === "active") teile.push("COALESCE(c.automation_status,'active')='active' AND COALESCE(c.do_not_contact,0)=0");
  if (filter.automation === "paused") teile.push("(COALESCE(c.automation_status,'active') IN ('paused','manual') OR (c.snoozed_until IS NOT NULL AND c.snoozed_until>datetime('now')))");
  if (filter.automation === "excluded") teile.push("(COALESCE(c.automation_status,'active')='excluded' OR COALESCE(c.do_not_contact,0)=1)");

  return { sql: teile.length ? `WHERE ${teile.join(" AND ")}` : "", args };
}

const runde = (wert: number) => Math.round(wert * 10) / 10;
const prozent = (zaehler: number, nenner: number) => (nenner > 0 ? Math.round((zaehler / nenner) * 1000) / 10 : null);

export type StufenWert = {
  stage: CrmStage;
  label: string;
  count: number;
  /** Übergangsquote von der vorherigen belegten Stufe — die einzige fair vergleichbare Größe. */
  fromPreviousPct: number | null;
};

const LABELS: Record<CrmStage, string> = {
  found: "Gefunden", suitable: "Geeignet", invited: "Vernetzung gesendet", accepted: "Angenommen",
  messaged: "Angeschrieben", replied: "Geantwortet", qualified: "Qualifiziert", meeting: "Termin",
  won: "Gewonnen", lost: "Verloren", not_fit: "Nicht passend",
};

/** Die Kette bis zum Termin. `won/lost/not_fit` sind Ergebnisse, keine Kettenglieder. */
const KETTE: CrmStage[] = ["found", "suitable", "invited", "accepted", "messaged", "replied", "qualified", "meeting"];

/**
 * COUNT(DISTINCT contact_id) ist Pflicht, nicht Geschmackssache: Altbestand kann dieselbe Stufe
 * sowohl als Backfill-Zeile (`backfill:<id>:<stufe>`) als auch als Live-Zeile (`contact:<id>:
 * <stufe>`) tragen. Beide belegen DASSELBE Ereignis. Ein einfaches COUNT(*) würde solche Kontakte
 * doppelt zählen und genau die Zusage brechen, die dieses Modell geben soll.
 */
function stufenZaehlen(filter: FunnelFilter): Record<CrmStage, number> {
  const { sql, args } = bedingungen(filter);
  const rows = db.prepare(
    `SELECT e.stage stage, COUNT(DISTINCT e.contact_id) n
       FROM crm_stage_events e JOIN contacts c ON c.id=e.contact_id
       ${sql}
      GROUP BY e.stage`,
  ).all(...args) as Array<{ stage: CrmStage; n: number }>;
  const counts = Object.fromEntries(FUNNEL_STAGES.map((s) => [s, 0])) as Record<CrmStage, number>;
  for (const row of rows) if (row.stage in counts) counts[row.stage] = row.n;
  return counts;
}

/** Antwortqualitäten. Grundlage für positive Antwortquote und das Warnsystem. */
function qualitaeten(filter: FunnelFilter) {
  const { sql, args } = bedingungen(filter);
  const rows = db.prepare(
    `SELECT COALESCE(e.reply_quality,'neutral') quality, COUNT(DISTINCT e.contact_id) n
       FROM crm_stage_events e JOIN contacts c ON c.id=e.contact_id
       ${sql}${sql ? " AND" : "WHERE"} e.stage='replied'
      GROUP BY quality`,
  ).all(...args) as Array<{ quality: string; n: number }>;
  const werte = Object.fromEntries(REPLY_QUALITIES.map((q) => [q, 0])) as Record<ReplyQuality, number>;
  for (const row of rows) if (row.quality in werte) werte[row.quality as ReplyQuality] = row.n;
  const positiv = [...POSITIVE_QUALITIES].reduce((summe, q) => summe + werte[q], 0);
  const gesamt = Object.values(werte).reduce((a, b) => a + b, 0);
  return { werte, positiv, gesamt };
}

/**
 * Durchlaufzeiten. Sie werden je Kontakt aus den Ereigniszeiten gerechnet, nicht aus dem heutigen
 * Zustand — dadurch bleiben sie stabil, auch wenn ein Kontakt später weiterläuft.
 */
function tempo(filter: FunnelFilter) {
  const { sql, args } = bedingungen(filter);
  const basis = `FROM crm_stage_events e JOIN contacts c ON c.id=e.contact_id ${sql}`;
  const row = db.prepare(
    `WITH je_kontakt AS (
        SELECT e.contact_id id,
               MIN(CASE WHEN e.stage='messaged' THEN e.occurred_at END) angeschrieben,
               MIN(CASE WHEN e.stage='replied'  THEN e.occurred_at END) geantwortet,
               MIN(CASE WHEN e.stage='meeting'  THEN e.occurred_at END) termin,
               MIN(CASE WHEN e.stage IN ('invited','messaged') THEN e.occurred_at END) erstkontakt
          ${basis}
         GROUP BY e.contact_id
      )
      SELECT AVG(julianday(geantwortet)-julianday(angeschrieben)) tage_bis_antwort,
             SUM(CASE WHEN geantwortet IS NOT NULL AND angeschrieben IS NOT NULL THEN 1 ELSE 0 END) n_antwort,
             AVG(CASE WHEN termin IS NOT NULL THEN julianday(termin)-julianday(erstkontakt) END) tage_bis_termin,
             SUM(CASE WHEN termin IS NOT NULL AND erstkontakt IS NOT NULL THEN 1 ELSE 0 END) n_termin
        FROM je_kontakt`,
  ).get(...args) as { tage_bis_antwort: number | null; n_antwort: number; tage_bis_termin: number | null; n_termin: number };
  return {
    tageBisAntwort: row.tage_bis_antwort == null ? null : runde(row.tage_bis_antwort),
    nAntwort: row.n_antwort ?? 0,
    tageBisTermin: row.tage_bis_termin == null ? null : runde(row.tage_bis_termin),
    nTermin: row.n_termin ?? 0,
  };
}

/**
 * Vollständiger Funnel-Bericht für einen Ausschnitt. Alle Quoten tragen ihren Nenner und ein
 * `genugDaten`-Kennzeichen mit: eine Quote aus drei Kontakten ist keine Erkenntnis, und das
 * Warnsystem darf auf so etwas nicht anschlagen.
 */
export function funnelReport(filter: FunnelFilter = {}) {
  backfillCrmStages();
  const counts = stufenZaehlen(filter);
  const antworten = qualitaeten(filter);
  const minN = config.safety.acceptanceRateMinSample ?? 20;

  let vorher: number | null = null;
  const kette: StufenWert[] = KETTE.map((stage) => {
    const count = counts[stage];
    const wert: StufenWert = { stage, label: LABELS[stage], count, fromPreviousPct: vorher == null ? null : prozent(count, vorher) };
    vorher = count;
    return wert;
  });

  const quote = (zaehler: number, nenner: number) => ({
    pct: prozent(zaehler, nenner), zaehler, nenner, genugDaten: nenner >= minN,
  });

  return {
    filter,
    kette,
    counts,
    ergebnisse: { won: counts.won, lost: counts.lost, notFit: counts.not_fit },
    antworten: { ...antworten, positivPct: prozent(antworten.positiv, counts.messaged) },
    quoten: {
      minN,
      annahme: quote(counts.accepted, counts.invited),
      antwort: quote(counts.replied, counts.messaged),
      positiveAntwort: quote(antworten.positiv, counts.messaged),
      qualifizierung: quote(counts.qualified, counts.replied),
      termin: quote(counts.meeting, counts.qualified),
    },
    // „Ergebnisse pro 100 Vernetzungen“ macht Kampagnen und Quellen unterschiedlicher Größe
    // vergleichbar — der eigentliche Zweck dieses Berichts.
    pro100Vernetzungen: counts.invited
      ? {
          angenommen: runde((counts.accepted / counts.invited) * 100),
          geantwortet: runde((counts.replied / counts.invited) * 100),
          positiv: runde((antworten.positiv / counts.invited) * 100),
          qualifiziert: runde((counts.qualified / counts.invited) * 100),
          termine: runde((counts.meeting / counts.invited) * 100),
          gewonnen: runde((counts.won / counts.invited) * 100),
        }
      : null,
    /** Wie viele Vernetzungen kostet ein qualifizierter Kontakt? Die harte Effizienzzahl. */
    vernetzungenProQualifiziert: counts.qualified ? Math.round(counts.invited / counts.qualified) : null,
    vernetzungenProTermin: counts.meeting ? Math.round(counts.invited / counts.meeting) : null,
    tempo: tempo(filter),
    generatedAt: new Date().toISOString(),
  };
}

export type FunnelKontakt = {
  id: number;
  full_name: string | null;
  profile_url: string;
  headline: string | null;
  status: string;
  occurred_at: string;
  reply_quality: ReplyQuality | null;
  source: string;
};

/**
 * ABNAHME zu 5.1: Jeder Wert im Dashboard lässt sich auf konkrete Kontakte zurückführen. Diese
 * Funktion nutzt DIESELBEN Filter und DIESELBE Tabelle wie die Zählung — die Liste kann deshalb
 * nicht von der Kennzahl abweichen.
 */
export function contactsForStage(stage: CrmStage, filter: FunnelFilter = {}, limit = 200): FunnelKontakt[] {
  const { sql, args } = bedingungen(filter);
  return db.prepare(
    `SELECT c.id, c.full_name, c.profile_url, c.headline, c.status,
            MIN(e.occurred_at) occurred_at,
            MAX(e.reply_quality) reply_quality,
            MAX(e.source) source
       FROM crm_stage_events e JOIN contacts c ON c.id=e.contact_id
       ${sql}${sql ? " AND" : "WHERE"} e.stage=?
      GROUP BY c.id
      ORDER BY occurred_at DESC
      LIMIT ?`,
  ).all(...args, stage, limit) as FunnelKontakt[];
}

/** Funnel je Kampagne — die Vergleichsansicht aus 5.2. */
export function funnelByCampaign(filter: FunnelFilter = {}) {
  backfillCrmStages();
  const kampagnen = db.prepare(
    "SELECT id,name,goal_code,kind,active FROM campaigns WHERE archived_at IS NULL ORDER BY created_at DESC",
  ).all() as Array<{ id: number; name: string; goal_code: string | null; kind: string; active: number }>;
  return kampagnen.map((k) => ({ campaign: k, report: funnelReport({ ...filter, campaignId: k.id }) }));
}

/** Funnel je Lead-Quelle — zeigt Quellen, die viele Kontakte, aber kaum Antworten liefern. */
export function funnelBySource(filter: FunnelFilter = {}) {
  backfillCrmStages();
  const quellen = db.prepare(
    "SELECT id,label,search_url,active,campaign_id FROM lead_sources ORDER BY id",
  ).all() as Array<{ id: number; label: string | null; search_url: string; active: number; campaign_id: number | null }>;
  return quellen.map((q) => ({
    source: { ...q, label: q.label || "Quelle" },
    report: funnelReport({ ...filter, sourceId: q.id }),
  }));
}
