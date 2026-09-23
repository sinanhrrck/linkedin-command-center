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

export type ProfilFakten = { rolle: string | null; firma: string | null; seit: string | null; ueber: string | null };

const INFO = /^(info|about|über mich)$/i;
const ERFAHRUNG = /^(berufserfahrung|erfahrung|experience)$/i;
const STOPP = /^(aktivität|activity|ausbildung|education|kenntnisse|skills|berufserfahrung|erfahrung|experience|interessen|interests|empfehlungen|recommendations|sprachen|languages|bescheinigungen und zertifikate|licenses & certifications|ehrenamt|volunteering|projekte|projects|auszeichnungen|honors & awards|beiträge|posts|info|about|highlights|empfohlen|featured|analysen|analytics|ressourcen|resources)$/i;
const MONAT = "(jan|feb|mär|mrz|apr|mai|may|jun|jul|aug|sep|okt|oct|nov|dez|dec|mar)[a-zä]*\\.?";
const ZEITRAUM = new RegExp(`^(${MONAT}\\s+)?(\\d{4})\\s*[–-]\\s*(heute|present|${MONAT}\\s+\\d{4}|\\d{4})`, "i");
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

/** Reine Funktion: aus dem sichtbaren Text von `main` die Fakten ziehen. Unklares bleibt null. */
export function extrahiereProfilFakten(text: string): ProfilFakten {
  const z = zeilen(text);
  const fakten: ProfilFakten = { rolle: null, firma: null, seit: null, ueber: null };

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
  if (!f.rolle && !f.firma && !f.ueber) return false;
  const c = db.prepare("SELECT id FROM contacts WHERE profile_url=?").get(profileUrl) as { id: number } | undefined;
  if (!c) return false;
  db.prepare(
    `INSERT INTO contact_profile_facts(contact_id,rolle,firma,seit,ueber,captured_at) VALUES(?,?,?,?,?,datetime('now'))
     ON CONFLICT(contact_id) DO UPDATE SET
       rolle=COALESCE(excluded.rolle,rolle), firma=COALESCE(excluded.firma,firma),
       seit=COALESCE(excluded.seit,seit), ueber=COALESCE(excluded.ueber,ueber), captured_at=excluded.captured_at`,
  ).run(c.id, f.rolle, f.firma, f.seit, f.ueber);
  return true;
}

export function profilFakten(contactId: number | null | undefined): ProfilFakten | null {
  if (!contactId) return null;
  return (db.prepare("SELECT rolle,firma,seit,ueber FROM contact_profile_facts WHERE contact_id=?").get(contactId) as ProfilFakten | undefined) ?? null;
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
