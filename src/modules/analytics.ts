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

  // --- Kernquoten (mit Benchmark-Einordnung; Werte aus LinkedIn-Praxis) ---
  const akz = governor.acceptanceRate(); // reife Kohorte letzte 7 Tage (Breaker-Wert)
  const quoten = {
    annahmeGesamt: quote(gesamt.angenommen, gesamt.eingeladen, 40, 25), // gut ≥40%, mittel ≥25%
    annahme7d: {
      n: Math.round(akz.rate * akz.sample),
      von: akz.sample,
      pct: Math.round(akz.rate * 100),
      tier: (akz.sample < config.safety.acceptanceRateMinSample ? "none" : akz.rate >= 0.4 ? "good" : akz.rate >= 0.25 ? "mid" : "low") as Quote["tier"],
    },
    antwortGesamt: quote(gesamt.geantwortet, gesamt.angeschrieben, 30, 15), // gut ≥30%, mittel ≥15%
    endToEnd: quote(gesamt.geantwortet, gesamt.eingeladen, 10, 5), // Hot-Lead je Einladung: gut ≥10%
    ansprache: quote(gesamt.angeschrieben, gesamt.angenommen, 80, 50), // wie viele Angenommene wurden angeschrieben
  };

  // --- Tempo: Ø Tage zwischen den Stufen ---
  const tempoRow = db
    .prepare(
      `SELECT
         ROUND(AVG(julianday(accepted_at)-julianday(invited_at)),1) AS bisAnnahme,
         (SELECT ROUND(AVG(julianday(replied_at)-julianday(messaged_at)),1)
            FROM contacts WHERE replied_at IS NOT NULL AND messaged_at IS NOT NULL) AS bisAntwort
       FROM contacts WHERE accepted_at IS NOT NULL AND invited_at IS NOT NULL`,
    )
    .get() as { bisAnnahme: number | null; bisAntwort: number | null };
  const tempo = { tageBisAnnahme: tempoRow.bisAnnahme, tageBisAntwort: tempoRow.bisAntwort };

  // --- Wochentag-Analyse: an welchem Tag eingeladene Anfragen am besten angenommen werden ---
  const wdRows = db
    .prepare(
      `SELECT strftime('%w', invited_at) AS wd, COUNT(*) AS n,
              SUM(CASE WHEN accepted_at IS NOT NULL THEN 1 ELSE 0 END) AS acc
         FROM contacts WHERE invited_at IS NOT NULL GROUP BY wd`,
    )
    .all() as { wd: string; n: number; acc: number }[];
  const wochentage = Array.from({ length: 7 }, (_, i) => {
    const r = wdRows.find((x) => Number(x.wd) === i);
    const n = r?.n ?? 0, acc = r?.acc ?? 0;
    return { tag: WD[i], eingeladen: n, angenommen: acc, pct: n > 0 ? Math.round((acc / n) * 100) : null };
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
