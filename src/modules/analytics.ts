import { db } from "../db/index.js";
import { config } from "../config.js";
import { governor } from "../core/safetyGovernor.js";

/**
 * ANALYTICS – fundierte Kennzahlen für strategische Planung & Skalierung.
 * Alle Quoten sind ehrlich definiert (Zähler/Nenner offengelegt) und über die richtigen
 * Grundgesamtheiten gerechnet: KUMULATIV aus den Zeitstempeln (invited_at/accepted_at/
 * messaged_at/replied_at), nicht aus dem aktuellen Status. So sind sie monoton und vergleichbar.
 */

type Quote = { n: number; von: number; pct: number; tier: "good" | "mid" | "low" | "none" };
function quote(n: number, von: number, gut: number, mittel: number): Quote {
  const pct = von > 0 ? Math.round((n / von) * 100) : 0;
  const tier = von === 0 ? "none" : pct >= gut ? "good" : pct >= mittel ? "mid" : "low";
  return { n, von, pct, tier };
}

const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

export function getAnalytics() {
  // --- Grundzahlen (kumulativ) ---
  const g = db
    .prepare(
      `SELECT
         COUNT(*) AS gesammelt,
         SUM(CASE WHEN invited_at  IS NOT NULL THEN 1 ELSE 0 END) AS eingeladen,
         SUM(CASE WHEN accepted_at IS NOT NULL THEN 1 ELSE 0 END) AS angenommen,
         SUM(CASE WHEN messaged_at IS NOT NULL THEN 1 ELSE 0 END) AS angeschrieben,
         SUM(CASE WHEN replied_at  IS NOT NULL THEN 1 ELSE 0 END) AS geantwortet
       FROM contacts`,
    )
    .get() as Record<string, number>;
  const gesamt = {
    gesammelt: g.gesammelt ?? 0,
    eingeladen: g.eingeladen ?? 0,
    angenommen: g.angenommen ?? 0,
    angeschrieben: g.angeschrieben ?? 0,
    geantwortet: g.geantwortet ?? 0,
  };

  const funnel = [
    { stage: "gesammelt", label: "Gesammelt", count: gesamt.gesammelt },
    { stage: "eingeladen", label: "Eingeladen", count: gesamt.eingeladen },
    { stage: "angenommen", label: "Angenommen", count: gesamt.angenommen },
    { stage: "angeschrieben", label: "Angeschrieben", count: gesamt.angeschrieben },
    { stage: "geantwortet", label: "Geantwortet", count: gesamt.geantwortet },
  ];

  /**
   * KERNQUOTEN – ehrlich über REIFE KOHORTEN.
   * Eine Einladung/Nachricht ist erst aussagekräftig, wenn sie lange genug her ist, um überhaupt
   * beantwortet worden zu sein. Zählt man frische Einladungen mit (die noch gar nicht angenommen
   * sein KÖNNEN), sinkt die Quote künstlich – die Zahl lügt dann nach unten. Deshalb: Nenner =
   * nur Kontakte, deren Einladung/Nachricht mindestens REIFE_TAGE her ist. Ø-Annahme dauert ~1–2
   * Tage, 7 Tage fangen also praktisch alle Spätzünder ab.
   */
  // Reife = so lange, wie eine Reaktion realistisch braucht. Gleiche Definition wie der Governor
  // (acceptanceMaturityDays, Default 2) – Ø-Annahme dauert ~1–2 Tage, das fängt praktisch alle ab.
  // 7 Tage wären zu streng (würfe fast alle Daten weg); 2 Tage halten die Stichprobe belastbar.
  const REIFE_TAGE = config.safety.acceptanceMaturityDays ?? 2;
  const MIN_N = config.safety.acceptanceRateMinSample ?? 20; // darunter statistisch nicht belastbar
  const grenze = `-${REIFE_TAGE} days`;
  const r = db
    .prepare(
      `SELECT
         SUM(CASE WHEN invited_at  <= datetime('now','localtime',?) THEN 1 ELSE 0 END) AS einReif,
         SUM(CASE WHEN invited_at  <= datetime('now','localtime',?) AND accepted_at IS NOT NULL THEN 1 ELSE 0 END) AS annReif,
         SUM(CASE WHEN messaged_at <= datetime('now','localtime',?) THEN 1 ELSE 0 END) AS angReif,
         SUM(CASE WHEN messaged_at <= datetime('now','localtime',?) AND replied_at IS NOT NULL THEN 1 ELSE 0 END) AS antReif
       FROM contacts`,
    )
    .get(grenze, grenze, grenze, grenze) as Record<string, number>;

  type RQuote = { pct: number | null; zaehler: number; nenner: number; genugDaten: boolean; gut: number; mittel: number; tier: Quote["tier"] };
  const reifeQuote = (zaehler: number, nenner: number, gut: number, mittel: number): RQuote => {
    const pct = nenner > 0 ? Math.round((zaehler / nenner) * 100) : null;
    const genugDaten = nenner >= MIN_N;
    const tier: Quote["tier"] = !genugDaten || pct === null ? "none" : pct >= gut ? "good" : pct >= mittel ? "mid" : "low";
    return { pct, zaehler, nenner, genugDaten, gut, mittel, tier };
  };

  const akz = governor.acceptanceRate(); // rollierende reife 7-Tage-Kohorte (Breaker-Wert) → als Trend
  const quoten = {
    reifeTage: REIFE_TAGE,
    minN: MIN_N,
    annahme: reifeQuote(r.annReif ?? 0, r.einReif ?? 0, 40, 25), // gut ≥40 %, mittel ≥25 %
    antwort: reifeQuote(r.antReif ?? 0, r.angReif ?? 0, 30, 15), // gut ≥30 %, mittel ≥15 %
    endToEnd: reifeQuote(r.antReif ?? 0, r.einReif ?? 0, 10, 5), // Hot-Lead je reifer Einladung
    // Trend der letzten 7 Tage (Richtung, nicht Gesamtbild)
    trend7d: {
      pct: akz.sample > 0 ? Math.round(akz.rate * 100) : null,
      n: akz.sample,
      genugDaten: akz.sample >= (config.safety.acceptanceRateMinSample ?? 15),
    },
  };

  // --- Tempo: Ø Tage zwischen den Stufen (mit Stichprobengröße n, damit man weiß, wie belastbar) ---
  const tempoRow = db
    .prepare(
      `SELECT
         ROUND(AVG(julianday(accepted_at)-julianday(invited_at)),1) AS bisAnnahme,
         SUM(CASE WHEN accepted_at IS NOT NULL AND invited_at IS NOT NULL THEN 1 ELSE 0 END) AS nAnnahme,
         (SELECT ROUND(AVG(julianday(replied_at)-julianday(messaged_at)),1) FROM contacts WHERE replied_at IS NOT NULL AND messaged_at IS NOT NULL) AS bisAntwort,
         (SELECT COUNT(*) FROM contacts WHERE replied_at IS NOT NULL AND messaged_at IS NOT NULL) AS nAntwort
       FROM contacts WHERE accepted_at IS NOT NULL AND invited_at IS NOT NULL`,
    )
    .get() as { bisAnnahme: number | null; nAnnahme: number; bisAntwort: number | null; nAntwort: number };
  const tempo = {
    tageBisAnnahme: tempoRow.bisAnnahme, nAnnahme: tempoRow.nAnnahme ?? 0,
    tageBisAntwort: tempoRow.bisAntwort, nAntwort: tempoRow.nAntwort ?? 0,
  };

  // --- Wochentag-Analyse: nur REIFE Einladungen (≥REIFE_TAGE), sonst verzerren frische Tage.
  // Prozent nur ab WD_MIN Einladungen zeigen – darunter ist ein Tageswert reines Rauschen. ---
  const WD_MIN = 8;
  const wdRows = db
    .prepare(
      `SELECT strftime('%w', invited_at, 'localtime') AS wd, COUNT(*) AS n,
              SUM(CASE WHEN accepted_at IS NOT NULL THEN 1 ELSE 0 END) AS acc
         FROM contacts
        WHERE invited_at IS NOT NULL AND invited_at <= datetime('now','localtime',?)
        GROUP BY wd`,
    )
    .all(grenze) as { wd: string; n: number; acc: number }[];
  const wochentage = Array.from({ length: 7 }, (_, i) => {
    const row = wdRows.find((x) => Number(x.wd) === i);
    const n = row?.n ?? 0, acc = row?.acc ?? 0;
    return { tag: WD[i], eingeladen: n, angenommen: acc, pct: n >= WD_MIN ? Math.round((acc / n) * 100) : null, genugDaten: n >= WD_MIN };
  });

  // --- Verlauf: pro Tag der letzten 42 Tage (eingeladen/angenommen/geantwortet nach jeweiligem _at) ---
  const tageZurueck = 42;
  const bucket = (spalte: string) =>
    Object.fromEntries(
      (db
        .prepare(
          `SELECT date(${spalte},'localtime') d, COUNT(*) n FROM contacts
            WHERE ${spalte} >= datetime('now','localtime','-${tageZurueck - 1} days','start of day') GROUP BY d`,
        )
        .all() as { d: string; n: number }[]).map((r) => [r.d, r.n]),
    );
  const inv = bucket("invited_at"), accp = bucket("accepted_at"), rep = bucket("replied_at");
  const verlauf = Array.from({ length: tageZurueck }, (_, i) => {
    const dt = new Date();
    dt.setDate(dt.getDate() - (tageZurueck - 1 - i));
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    return { date: key, label: `${dt.getDate()}.${dt.getMonth() + 1}.`, eingeladen: inv[key] ?? 0, angenommen: accp[key] ?? 0, geantwortet: rep[key] ?? 0 };
  });

  // --- Lead-Quellen-Vergleich (nur zugeordnete Kontakte; Altbestand hat keine Quelle) ---
  const quellen = db
    .prepare(
      `SELECT s.id, s.label, s.search_url,
              COUNT(c.id) AS kontakte,
              SUM(CASE WHEN c.invited_at  IS NOT NULL THEN 1 ELSE 0 END) AS eingeladen,
              SUM(CASE WHEN c.accepted_at IS NOT NULL THEN 1 ELSE 0 END) AS angenommen,
              SUM(CASE WHEN c.replied_at  IS NOT NULL THEN 1 ELSE 0 END) AS geantwortet
         FROM lead_sources s LEFT JOIN contacts c ON c.source_id = s.id
        GROUP BY s.id ORDER BY kontakte DESC`,
    )
    .all() as { id: number; label: string | null; kontakte: number; eingeladen: number; angenommen: number; geantwortet: number }[];
  const quellenAufbereitet = quellen.map((q) => ({
    ...q,
    label: q.label || "Quelle",
    annahmePct: q.eingeladen > 0 ? Math.round((q.angenommen / q.eingeladen) * 100) : null,
    antwortPct: q.angenommen > 0 ? Math.round((q.geantwortet / q.angenommen) * 100) : null,
  }));
  const kontakteOhneQuelle = (db.prepare("SELECT COUNT(*) n FROM contacts WHERE source_id IS NULL").get() as { n: number }).n;

  // --- Skalierungs-Projektion: was bringt mehr Vernetzungs-Volumen? ---
  // Rechnung: Vernetzungen/Woche × Annahmequote × Antwortquote = erwartete Hot Leads/Woche.
  // Basis: die belastbaren Gesamt-Quoten. Zeigt den Hebel (Volumen vs. Quote) transparent.
  const aRate = gesamt.eingeladen > 0 ? gesamt.angenommen / gesamt.eingeladen : 0;
  const rRate = gesamt.angeschrieben > 0 ? gesamt.geantwortet / gesamt.angeschrieben : 0;
  const proWoche = (vernetzungen: number) => {
    const ang = vernetzungen * aRate;
    const hot = ang * rRate;
    return { vernetzungen, angenommen: Math.round(ang * 10) / 10, hotLeads: Math.round(hot * 10) / 10 };
  };
  const projektion = {
    annahmeRate: Math.round(aRate * 100),
    antwortRate: Math.round(rRate * 100),
    weeklyCap: config.safety.weeklyConnectCap,
    szenarien: [25, 50, config.safety.weeklyConnectCap].map(proWoche),
    // pro Hot Lead nötige Vernetzungen (Effizienz-Kennzahl)
    vernetzungenProHotLead: aRate * rRate > 0 ? Math.round(1 / (aRate * rRate)) : null,
  };

  return { gesamt, funnel, quoten, tempo, wochentage, verlauf, quellen: quellenAufbereitet, kontakteOhneQuelle, projektion, generatedAt: new Date().toISOString() };
}
