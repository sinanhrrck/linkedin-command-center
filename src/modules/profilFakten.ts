import { db } from "../db/index.js";

/**
 * PROFIL-FAKTEN (2026-09-23, Phase 5): mehr als nur die Headline.
 *
 * Bisher kannte die KI von einer Person nur Name + Headline. Headlines sind oft veraltet
 * („Auszubildender“ zwei Jahre nach dem Abschluss) – daher u. a. der Fehler „du machst deine
 * Ausbildung“ bei fertigen Bankkaufleuten. Beim Vernetzen und beim Anschreiben ist die
 * Profilseite ohnehin offen; dort lesen wir EINMAL den sichtbaren Text mit, ohne zusätzlichen
 * Seitenaufruf und ohne Klick auf „mehr anzeigen“ – das Lese-Budget bleibt unberührt.
 *
 * Bewusst der TEXT und nicht CSS-Klassen: LinkedIn verschleiert die Klassen (siehe leads.ts),
 * die Überschriften „Info“ und „Berufserfahrung“ sind dagegen stabil.
 *
 * Datensparsam: nur aktuelle Rolle, Firma, seit wann und ein gekürzter „Info“-Auszug. Keine
 * E-Mail-Adressen, Telefonnummern oder Links. Gelöscht mit dem Kontakt.
 */

export type ProfilFakten = {
  rolle: string | null; firma: string | null; seit: string | null; ueber: string | null;
  /**
   * ZIELGRUPPEN-PRÜFUNG (2026-09-25, Sinan: „Ausbilder mit 40 und 20 Jahren im Beruf dürfen nie
   * angeschrieben werden“). `erfahrung` = alle sichtbaren Positionstitel (nicht nur der aktuelle),
   * `erstes_jahr` = frühestes Jahr im Lebenslauf: Beginn der ersten Position bzw. Schul-/Studien-
   * ABSCHLUSS (nicht Beginn – Schulzeit ab 2010 hieße sonst 16 Berufsjahre für einen 22-Jährigen).
   */
  erfahrung?: string | null; erstes_jahr?: number | null;
};

const INFO = /^(info|about|über mich)$/i;
const ERFAHRUNG = /^(berufserfahrung|erfahrung|experience)$/i;
const STOPP = /^(aktivität|activity|ausbildung|education|kenntnisse|skills|berufserfahrung|erfahrung|experience|interessen|interests|empfehlungen|recommendations|sprachen|languages|bescheinigungen und zertifikate|licenses & certifications|ehrenamt|volunteering|projekte|projects|auszeichnungen|honors & awards|beiträge|posts|info|about|highlights|empfohlen|featured|analysen|analytics|ressourcen|resources)$/i;
const MONAT = "(jan|feb|mär|mrz|apr|mai|may|jun|jul|aug|sep|okt|oct|nov|dez|dec|mar)[a-zä]*\\.?";
const ZEITRAUM = new RegExp(`^(${MONAT}\\s+)?(\\d{4})\\s*[–-]\\s*(heute|present|${MONAT}\\s+\\d{4}|\\d{4})`, "i");
/** Seitenfuß von LinkedIn („Info · Barrierefreiheit · Talent Solutions …“) – landete als Info-Text im CRM. */
const FUSS = /^(barrierefreiheit|accessibility|talent solutions|community-richtlinien|community guidelines)$/i;
const JAHR = /\b(19[5-9]\d|20\d\d)\b/g;
const ANSTELLUNG = /^(vollzeit|teilzeit|ausbildung|werkstudent|praktikum|selbstständig|freiberuflich|full-time|part-time|apprenticeship|internship|self-employed|freelance)/i;
const RAUSCHEN = /^(…?\s*mehr anzeigen|…?\s*see more|mehr anzeigen|alle .* anzeigen|show all .*)$/i;

function zeilen(text: string): string[] {
  const out: string[] = [];
  for (const roh of String(text || "").split("\n")) {
    const z = roh.replace(/\s+/g, " ").trim();
    if (!z || RAUSCHEN.test(z)) continue;
    if (out[out.length - 1] === z) continue; // LinkedIn rendert Überschriften oft doppelt (sichtbar + Screenreader)
    out.push(z);
  }
  return out;
}

/** Entfernt Kontaktdaten und Links – die gehören nicht in einen Prompt. */
function entschaerfen(t: string): string {
  return t
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "")
    .replace(/https?:\/\/\S+|www\.\S+/gi, "")
    .replace(/(\+?\d[\d\s/().-]{7,}\d)/g, "")
    .replace(/…?\s*mehr anzeigen|…\s*see more/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Positionen der Berufserfahrung: Titel + Startjahr je Zeitraum-Zeile. Anders als der Block für
 * `rolle` endet dieser NICHT an einer Zeile „Ausbildung“, wenn direkt ein Zeitraum folgt – das ist
 * dann die Anstellungsart („Auszubildende / Ausbildung / Sept. 2022–…“), nicht die Überschrift.
 */
function positionen(z: string[]): { titel: string; jahr: number | null }[] {
  const e = z.findIndex((x) => ERFAHRUNG.test(x));
  if (e < 0) return [];
  const block: string[] = [];
  for (let k = e + 1; k < z.length; k++) {
    if (STOPP.test(z[k]) && !(ANSTELLUNG.test(z[k]) && ZEITRAUM.test(z[k + 1] ?? ""))) break;
    block.push(z[k]);
  }
  const out: { titel: string; jahr: number | null }[] = [];
  block.forEach((zeile, d) => {
    if (!ZEITRAUM.test(zeile) || d < 1) return;
    const davor = block[d - 1];
    const titel = d >= 2 && (davor.includes("·") || ANSTELLUNG.test(davor)) ? block[d - 2] : davor;
    const jahr = zeile.match(/\b(19[5-9]\d|20\d\d)\b/);
    if (titel && titel.length <= 120 && !ZEITRAUM.test(titel)) out.push({ titel, jahr: jahr ? Number(jahr[1]) : null });
  });
  return out;
}

/** Abschlussjahre im Bereich „Ausbildung/Education“ (Schule, Studium): jeweils das SPÄTERE Jahr. */
function abschlussJahre(z: string[]): number[] {
  const a = z.findIndex((x, i) => /^(ausbildung|education)$/i.test(x) && !ZEITRAUM.test(z[i + 1] ?? "") && i > z.findIndex((y) => ERFAHRUNG.test(y)));
  if (a < 0) return [];
  const jahre: number[] = [];
  for (let k = a + 1; k < z.length && !(STOPP.test(z[k]) && !/^(ausbildung|education)$/i.test(z[k])); k++) {
    const treffer = [...z[k].matchAll(JAHR)].map((m) => Number(m[1]));
    if (treffer.length && /^[\s\w.äöü]*\d{4}\s*([–-]\s*[\w.äöü]*\s*\d{4})?\s*$/i.test(z[k])) jahre.push(Math.max(...treffer));
  }
  return jahre;
}

/** Reine Funktion: aus dem sichtbaren Text von `main` die Fakten ziehen. Unklares bleibt null. */
export function extrahiereProfilFakten(text: string): ProfilFakten {
  let z = zeilen(text);
  // Seitenfuß abschneiden: er beginnt mit „Info“ direkt vor „Barrierefreiheit“.
  const fuss = z.findIndex((x) => FUSS.test(x));
  if (fuss >= 0) z = z.slice(0, INFO.test(z[fuss - 1] ?? "") ? fuss - 1 : fuss);
  const fakten: ProfilFakten = { rolle: null, firma: null, seit: null, ueber: null, erfahrung: null, erstes_jahr: null };
  const pos = positionen(z);
  if (pos.length) fakten.erfahrung = entschaerfen(pos.map((p) => p.titel).join(" | ")).slice(0, 600) || null;
  const jahre = [...pos.map((p) => p.jahr).filter((j): j is number => j != null), ...abschlussJahre(z)];
  if (jahre.length) fakten.erstes_jahr = Math.min(...jahre);

  const i = z.findIndex((x) => INFO.test(x));
  if (i >= 0) {
    const teile: string[] = [];
    for (let k = i + 1; k < z.length && !STOPP.test(z[k]); k++) teile.push(z[k]);
    const ueber = entschaerfen(teile.join(" "));
    if (ueber.length >= 15) fakten.ueber = ueber.length > 500 ? `${ueber.slice(0, 497).replace(/\s+\S*$/, "")} …` : ueber;
  }

  const e = z.findIndex((x) => ERFAHRUNG.test(x));
  if (e >= 0) {
    const block: string[] = [];
    for (let k = e + 1; k < z.length && !STOPP.test(z[k]); k++) block.push(z[k]);
    const d = block.findIndex((x) => ZEITRAUM.test(x));
    if (d >= 1) {
      fakten.seit = (block[d].split(/\s*[–-]\s*/)[0] || "").trim() || null;
      const davor = block[d - 1];
      if (d >= 2 && davor.includes("·")) {
        // Einzelposten: Rolle / „Firma · Vollzeit“ / Zeitraum
        fakten.rolle = block[d - 2];
        fakten.firma = davor.split("·")[0].trim() || null;
      } else if (d >= 2 && /^(vollzeit|teilzeit|ausbildung|werkstudent|praktikum|full-time|part-time|apprenticeship|internship)/i.test(davor)) {
        // Gruppiert nach Firma: Firma / Gesamtdauer / Rolle / Anstellungsart / Zeitraum
        fakten.rolle = block[d - 2];
        fakten.firma = block[0];
      } else {
        fakten.rolle = davor;
        fakten.firma = d >= 3 ? block[0] : null;
      }
    }
  }
  for (const k of ["rolle", "firma"] as const) {
    const v = fakten[k];
    if (v && (v.length > 120 || ZEITRAUM.test(v))) fakten[k] = null;
    else if (v) fakten[k] = entschaerfen(v) || null;
  }
  return fakten;
}

/** Speichert nur, was erkannt wurde; Bekanntes wird nicht mit „leer“ überschrieben. */
export function speichereProfilFakten(profileUrl: string, f: ProfilFakten): boolean {
  if (!f.rolle && !f.firma && !f.ueber && !f.erfahrung && f.erstes_jahr == null) return false;
  const c = db.prepare("SELECT id FROM contacts WHERE profile_url=?").get(profileUrl) as { id: number } | undefined;
  if (!c) return false;
  db.prepare(
    `INSERT INTO contact_profile_facts(contact_id,rolle,firma,seit,ueber,erfahrung,erstes_jahr,captured_at) VALUES(?,?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(contact_id) DO UPDATE SET
       rolle=COALESCE(excluded.rolle,rolle), firma=COALESCE(excluded.firma,firma),
       seit=COALESCE(excluded.seit,seit), ueber=COALESCE(excluded.ueber,ueber),
       erfahrung=COALESCE(excluded.erfahrung,erfahrung),
       -- Das früheste Jahr kann nur früher werden (mehr Lebenslauf sichtbar), nie später.
       erstes_jahr=CASE WHEN excluded.erstes_jahr IS NULL THEN erstes_jahr WHEN erstes_jahr IS NULL THEN excluded.erstes_jahr ELSE MIN(erstes_jahr, excluded.erstes_jahr) END,
       captured_at=excluded.captured_at`,
  ).run(c.id, f.rolle, f.firma, f.seit, f.ueber, f.erfahrung ?? null, f.erstes_jahr ?? null);
  return true;
}

export function profilFakten(contactId: number | null | undefined): ProfilFakten | null {
  if (!contactId) return null;
  return (db.prepare("SELECT rolle,firma,seit,ueber,erfahrung,erstes_jahr FROM contact_profile_facts WHERE contact_id=?").get(contactId) as ProfilFakten | undefined) ?? null;
}

/** Prompt-Baustein. Leer, wenn nichts bekannt ist. */
export function faktenBlock(contactId: number | null | undefined): string {
  const f = profilFakten(contactId);
  if (!f || (!f.rolle && !f.ueber)) return "";
  const rolle = f.rolle ? `Aktuelle Rolle laut Profil: ${f.rolle}${f.firma ? ` bei ${f.firma}` : ""}${f.seit ? ` (seit ${f.seit})` : ""}` : "";
  return `\nWEITERE PROFIL-INFOS (aktueller als die Headline):
${rolle}${f.ueber ? `${rolle ? "\n" : ""}Info-Text (Auszug): ${f.ueber}` : ""}
Nutze höchstens EIN Detail daraus. Nichts Privates (Familie, Gesundheit, Religion, Politik), nicht wörtlich zitieren, nichts dazuerfinden.\n`;
}
