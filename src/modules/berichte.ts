import { db } from "../db/index.js";
import { backfillCrmStages } from "./crmStages.js";

/**
 * TAGES- UND WOCHENBERICHT (Sinans Vorgabe 2026-09-22).
 *
 * Ein Bericht beantwortet für EINEN Zeitraum (ein Tag oder eine Kalenderwoche Mo–So) die Frage
 * „Was ist passiert, und war das mehr oder weniger als im Zeitraum davor?“. Er wird automatisch
 * gebaut (Cron → Telegram) und im Cockpit unter „Auswertung“ für jeden beliebigen Tag bzw. jede
 * Woche abgerufen (`GET /api/bericht?art=tag|woche&datum=…`).
 *
 * EINE WAHRHEIT: Alle Funnel-Zahlen kommen aus `crm_stage_events` (wie die Wirkungs-Auswertung),
 * alle Sende-Zahlen aus `actions` (das unveränderliche Safety-Protokoll), Entwürfe aus `drafts`.
 * Nichts wird gespeichert – jeder Bericht ist jederzeit aus den Ereignissen nachrechenbar, auch
 * rückwirkend. Zeiträume werden in LOKALER Zeit gebildet (`localtime`), damit „heute“ das ist,
 * was Sinan unter heute versteht, nicht der UTC-Tag.
 */

export type BerichtArt = "tag" | "woche";

export type Zeitraum = { von: string; bis: string; label: string };

export type BerichtZahlen = {
  // Sende-Aktivität (actions)
  anfragen: number;
  nachrichten: number;
  kommentare: number;
  profilbesuche: number;
  // Funnel-Ereignisse (crm_stage_events)
  neueKontakte: number; // found
  angenommen: number;
  angeschrieben: number;
  geantwortet: number;
  positiv: number; // interested | question | meeting
  qualifiziert: number;
  termine: number;
  gewonnen: number;
  // Entscheidungen (drafts)
  neueEntwuerfe: number;
  gesendeteEntwuerfe: number;
};

export type TagesZeile = { datum: string; wochentag: string; anfragen: number; angenommen: number; angeschrieben: number; geantwortet: number };

export type Bericht = {
  art: BerichtArt;
  zeitraum: Zeitraum;
  vergleich: Zeitraum;
  zahlen: BerichtZahlen;
  vorher: BerichtZahlen;
  /** Quoten INNERHALB des Zeitraums (Ereignisse, nicht Kohorten – siehe Hinweis im Text). */
  quoten: { annahme: number | null; antwort: number | null; positiv: number | null };
  tage: TagesZeile[]; // je Tag des Zeitraums (beim Tagesbericht genau eine Zeile)
  top: { kampagne: { name: string; geantwortet: number; angeschrieben: number } | null; quelle: { label: string; angenommen: number; anfragen: number } | null };
  offen: { entwuerfe: number; hotLeads: number };
  text: string; // fertiger Telegram-/Klartext
  generatedAt: string;
};

const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const POSITIV = "('interested','question','meeting')";
/**
 * EIN EREIGNIS JE PERSON UND STUFE. In `crm_stage_events` kann dieselbe Stufe eines Kontakts
 * zweimal stehen (Live-Schlüssel `contact:<id>:<stufe>` UND Altbestands-Schlüssel
 * `backfill:<id>:<stufe>`). Die Wirkungs-Auswertung zählt deshalb DISTINCT contact_id; der Bericht
 * muss dasselbe tun, sonst verdoppeln sich die Zahlen (live passiert 2026-09-22: 3 gesendete
 * Nachrichten, 6 „Angeschrieben“). Gezählt wird der FRÜHESTE Zeitpunkt je Person und Stufe.
 */
const ERST = `erst AS (
  SELECT contact_id, stage, campaign_id, source_id, MAX(reply_quality) reply_quality,
         MIN(COALESCE(occurred_at, created_at)) t
    FROM crm_stage_events GROUP BY contact_id, stage)`;

/** ISO-Datum (YYYY-MM-DD) in lokaler Zeit. */
export function isoLokal(d: Date): string {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), t = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${t}`;
}
const parse = (iso: string): Date => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
const plusTage = (iso: string, n: number): string => { const d = parse(iso); d.setDate(d.getDate() + n); return isoLokal(d); };
const de = (iso: string): string => { const [y, m, d] = iso.split("-"); return `${d}.${m}.${y}`; };

/** Montag der Kalenderwoche, in der `iso` liegt. */
export function wochenstart(iso: string): string {
  const d = parse(iso);
  const tag = d.getDay(); // 0 = So
  return plusTage(iso, tag === 0 ? -6 : 1 - tag);
}

function zeitraumFuer(art: BerichtArt, datum: string): { zeitraum: Zeitraum; vergleich: Zeitraum } {
  if (art === "tag") {
    const gestern = plusTage(datum, -1);
    return {
      zeitraum: { von: datum, bis: datum, label: `${WD[parse(datum).getDay()]} ${de(datum)}` },
      vergleich: { von: gestern, bis: gestern, label: `${WD[parse(gestern).getDay()]} ${de(gestern)}` },
    };
  }
  const von = wochenstart(datum), bis = plusTage(von, 6);
  const vVon = plusTage(von, -7), vBis = plusTage(von, -1);
  return {
    zeitraum: { von, bis, label: `KW ${kalenderwoche(von)} · ${de(von)}–${de(bis)}` },
    vergleich: { von: vVon, bis: vBis, label: `KW ${kalenderwoche(vVon)} · ${de(vVon)}–${de(vBis)}` },
  };
}

function kalenderwoche(iso: string): number {
  const d = parse(iso);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const tag = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - tag);
  const jahresanfang = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - jahresanfang.getTime()) / 86_400_000 + 1) / 7);
}

const n = (row: unknown, key: string): number => Number((row as Record<string, number | null>)?.[key] ?? 0);

function zahlenFuer(z: Zeitraum): BerichtZahlen {
  const a = db.prepare(
    `SELECT
       SUM(CASE WHEN type='connect' THEN 1 ELSE 0 END) anfragen,
       SUM(CASE WHEN type='message' THEN 1 ELSE 0 END) nachrichten,
       SUM(CASE WHEN type='comment' THEN 1 ELSE 0 END) kommentare,
       SUM(CASE WHEN type='profileView' THEN 1 ELSE 0 END) profilbesuche
     FROM actions WHERE status='done' AND date(created_at,'localtime') BETWEEN ? AND ?`,
  ).get(z.von, z.bis);
  const e = db.prepare(
    `WITH ${ERST}
     SELECT
       SUM(CASE WHEN stage='found' THEN 1 ELSE 0 END) neueKontakte,
       SUM(CASE WHEN stage='accepted' THEN 1 ELSE 0 END) angenommen,
       SUM(CASE WHEN stage='messaged' THEN 1 ELSE 0 END) angeschrieben,
       SUM(CASE WHEN stage='replied' THEN 1 ELSE 0 END) geantwortet,
       SUM(CASE WHEN stage='replied' AND reply_quality IN ${POSITIV} THEN 1 ELSE 0 END) positiv,
       SUM(CASE WHEN stage='qualified' THEN 1 ELSE 0 END) qualifiziert,
       SUM(CASE WHEN stage='meeting' THEN 1 ELSE 0 END) termine,
       SUM(CASE WHEN stage='won' THEN 1 ELSE 0 END) gewonnen
     FROM erst WHERE date(t,'localtime') BETWEEN ? AND ?`,
  ).get(z.von, z.bis);
  const d = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM drafts WHERE phase='message' AND date(created_at,'localtime') BETWEEN ? AND ?) neueEntwuerfe,
       (SELECT COUNT(*) FROM drafts WHERE status='sent' AND date(COALESCE(sent_at,created_at),'localtime') BETWEEN ? AND ?) gesendeteEntwuerfe`,
  ).get(z.von, z.bis, z.von, z.bis);
  return {
    anfragen: n(a, "anfragen"), nachrichten: n(a, "nachrichten"), kommentare: n(a, "kommentare"), profilbesuche: n(a, "profilbesuche"),
    neueKontakte: n(e, "neueKontakte"), angenommen: n(e, "angenommen"), angeschrieben: n(e, "angeschrieben"), geantwortet: n(e, "geantwortet"),
    positiv: n(e, "positiv"), qualifiziert: n(e, "qualifiziert"), termine: n(e, "termine"), gewonnen: n(e, "gewonnen"),
    neueEntwuerfe: n(d, "neueEntwuerfe"), gesendeteEntwuerfe: n(d, "gesendeteEntwuerfe"),
  };
}

function tageFuer(z: Zeitraum): TagesZeile[] {
  const rows: TagesZeile[] = [];
  for (let iso = z.von; iso <= z.bis; iso = plusTage(iso, 1)) {
    const a = db.prepare("SELECT COUNT(*) n FROM actions WHERE type='connect' AND status='done' AND date(created_at,'localtime')=?").get(iso);
    const e = db.prepare(
      `WITH ${ERST}
       SELECT
         SUM(CASE WHEN stage='accepted' THEN 1 ELSE 0 END) angenommen,
         SUM(CASE WHEN stage='messaged' THEN 1 ELSE 0 END) angeschrieben,
         SUM(CASE WHEN stage='replied' THEN 1 ELSE 0 END) geantwortet
       FROM erst WHERE date(t,'localtime')=?`,
    ).get(iso);
    rows.push({ datum: iso, wochentag: WD[parse(iso).getDay()], anfragen: n(a, "n"), angenommen: n(e, "angenommen"), angeschrieben: n(e, "angeschrieben"), geantwortet: n(e, "geantwortet") });
  }
  return rows;
}

function topFuer(z: Zeitraum): Bericht["top"] {
  const k = db.prepare(
    `WITH ${ERST}
     SELECT ca.name,
            SUM(CASE WHEN e.stage='replied' THEN 1 ELSE 0 END) geantwortet,
            SUM(CASE WHEN e.stage='messaged' THEN 1 ELSE 0 END) angeschrieben
       FROM erst e JOIN campaigns ca ON ca.id=e.campaign_id
      WHERE date(e.t,'localtime') BETWEEN ? AND ?
      GROUP BY ca.id ORDER BY geantwortet DESC, angeschrieben DESC LIMIT 1`,
  ).get(z.von, z.bis) as { name: string; geantwortet: number; angeschrieben: number } | undefined;
  const q = db.prepare(
    `WITH ${ERST}
     SELECT COALESCE(s.label, 'Quelle ' || s.id) label,
            SUM(CASE WHEN e.stage='accepted' THEN 1 ELSE 0 END) angenommen,
            SUM(CASE WHEN e.stage='invited' THEN 1 ELSE 0 END) anfragen
       FROM erst e JOIN lead_sources s ON s.id=e.source_id
      WHERE date(e.t,'localtime') BETWEEN ? AND ?
      GROUP BY s.id ORDER BY angenommen DESC, anfragen DESC LIMIT 1`,
  ).get(z.von, z.bis) as { label: string; angenommen: number; anfragen: number } | undefined;
  return {
    kampagne: k && (k.geantwortet || k.angeschrieben) ? k : null,
    quelle: q && (q.angenommen || q.anfragen) ? q : null,
  };
}

const pct = (z: number, nenner: number): number | null => (nenner > 0 ? Math.round((z / nenner) * 100) : null);
const delta = (jetzt: number, vorher: number): string => {
  const d = jetzt - vorher;
  return d === 0 ? "±0" : d > 0 ? `+${d}` : `${d}`;
};

/** Klartext für Telegram und CLI – bewusst ohne Markdown-Sonderzeichen aus Nutzerdaten. */
function textFuer(b: Omit<Bericht, "text" | "generatedAt">): string {
  const z = b.zahlen, v = b.vorher;
  const titel = b.art === "tag" ? "📅 Tagesbericht" : "📊 Wochenbericht";
  const zeile = (label: string, jetzt: number, vorher: number) => `${label}: ${jetzt} (${delta(jetzt, vorher)})`;
  const teile: string[] = [
    `${titel} · ${b.zeitraum.label}`,
    `Vergleich: ${b.vergleich.label}`,
    "",
    "AKTIVITÄT",
    zeile("Anfragen", z.anfragen, v.anfragen),
    zeile("Nachrichten", z.nachrichten, v.nachrichten),
    zeile("Kommentare", z.kommentare, v.kommentare),
    "",
    "ERGEBNIS",
    zeile("Neue Kontakte", z.neueKontakte, v.neueKontakte),
    zeile("Angenommen", z.angenommen, v.angenommen),
    zeile("Angeschrieben", z.angeschrieben, v.angeschrieben),
    zeile("Geantwortet", z.geantwortet, v.geantwortet) + (z.geantwortet ? ` · davon positiv ${z.positiv}` : ""),
    zeile("Qualifiziert", z.qualifiziert, v.qualifiziert),
    zeile("Termine", z.termine, v.termine),
  ];
  if (z.gewonnen || v.gewonnen) teile.push(zeile("Gewonnen", z.gewonnen, v.gewonnen));
  if (b.art === "woche") {
    teile.push("", "JE TAG (Anfragen / angenommen / angeschrieben / geantwortet)");
    for (const t of b.tage) teile.push(`${t.wochentag} ${de(t.datum).slice(0, 5)}: ${t.anfragen} / ${t.angenommen} / ${t.angeschrieben} / ${t.geantwortet}`);
    if (b.top.kampagne) teile.push("", `Beste Kampagne: ${b.top.kampagne.name} (${b.top.kampagne.geantwortet} Antworten auf ${b.top.kampagne.angeschrieben} Nachrichten)`);
    if (b.top.quelle) teile.push(`Beste Quelle: ${b.top.quelle.label} (${b.top.quelle.angenommen} Annahmen)`);
  }
  teile.push("", `Offen: ${b.offen.entwuerfe} Entwürfe warten · ${b.offen.hotLeads} Hot Leads`);
  if (b.art === "woche" && b.quoten.annahme != null) {
    teile.push(`Quoten im Zeitraum: Annahme ${b.quoten.annahme}%${b.quoten.antwort != null ? ` · Antwort ${b.quoten.antwort}%` : ""}`);
  }
  return teile.join("\n");
}

/** Bericht für EINEN Zeitraum. `datum` = ein Tag im Zeitraum (Standard: heute, lokale Zeit). */
export function bericht(art: BerichtArt, datum: string = isoLokal(new Date())): Bericht {
  backfillCrmStages(); // Altbestand einmalig in Ereignisse übernehmen – idempotent, wie in funnel.ts
  const { zeitraum, vergleich } = zeitraumFuer(art, datum);
  const zahlen = zahlenFuer(zeitraum);
  const vorher = zahlenFuer(vergleich);
  const invited = n(db.prepare(
    `WITH ${ERST} SELECT COUNT(*) n FROM erst WHERE stage='invited' AND date(t,'localtime') BETWEEN ? AND ?`,
  ).get(zeitraum.von, zeitraum.bis), "n");
  const offen = {
    entwuerfe: n(db.prepare("SELECT COUNT(*) n FROM drafts WHERE status='pending' AND phase='message'").get(), "n"),
    hotLeads: n(db.prepare("SELECT COUNT(*) n FROM contacts WHERE status='replied'").get(), "n"),
  };
  const ohneText: Omit<Bericht, "text" | "generatedAt"> = {
    art, zeitraum, vergleich, zahlen, vorher,
    // Ereignis-Quoten im Zeitraum: Annahmen dieser Woche ÷ Anfragen dieser Woche. Das ist KEINE
    // Kohorten-Quote (die steht in der Wirkungs-Auswertung), aber für einen Wochenblick ehrlich
    // genug, solange man weiß, dass Annahmen oft erst Tage nach der Anfrage kommen.
    quoten: { annahme: pct(zahlen.angenommen, invited), antwort: pct(zahlen.geantwortet, zahlen.angeschrieben), positiv: pct(zahlen.positiv, zahlen.angeschrieben) },
    tage: tageFuer(zeitraum),
    top: art === "woche" ? topFuer(zeitraum) : { kampagne: null, quelle: null },
    offen,
  };
  return { ...ohneText, text: textFuer(ohneText), generatedAt: new Date().toISOString() };
}

export const tagesbericht = (datum?: string) => bericht("tag", datum);
export const wochenbericht = (datum?: string) => bericht("woche", datum);
/** Die ABGESCHLOSSENE Vorwoche (für den Montag-Push). */
export const letzteWoche = () => bericht("woche", plusTage(wochenstart(isoLokal(new Date())), -1));
