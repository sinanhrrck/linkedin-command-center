/**
 * ZIELGRUPPEN-REGEL (2026-09-25, Sinans Vorgabe): „Es wird eine Zielgruppe bestimmt. Aus dieser
 * Zielgruppe werden Leads gezogen und gesammelt. Sobald die Zielgruppe geändert wird, wird auch der
 * Versand an diese Zielgruppe gestoppt.“ Auslöser: automatische Erstnachrichten an Filialleiter und
 * Bankkaufleute mit 20 Berufsjahren, weil vor dem Versand keinerlei Zielgruppen-Schranke existierte.
 *
 * Diese Datei ist bewusst REIN (keine DB): Dieselbe Regel läuft als SQLite-Funktion `zg_passt` in
 * jeder Auswahl-Abfrage (db/index.ts registriert sie) und als JS-Prüfung vor Einzelversänden. Eine
 * Regel, eine Wahrheit – wie beim Governor wird nichts an einer Stelle nachgebaut.
 *
 * Wörter statt regulärer Ausdrücke: Sinan pflegt die Liste selbst im Cockpit („Azubi, Ausbildung“).
 * Teilwort-Treffer ohne Groß/Klein: „Leiter“ trifft „Filialleiter“ und „Abteilungsleiter“.
 */

export type ZielgruppenRegel = {
  erkennung: string | null;
  ausschluss: string | null;
  max_berufsjahre: number | null;
};

export function woerter(liste: string | null | undefined): string[] {
  return String(liste ?? "")
    .split(/[,;\n]/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
}

/** Jahr aus Profil-Fakten wie „Aug. 2004“ oder „2019“. */
export function seitJahr(seit: string | null | undefined): number | null {
  const m = String(seit ?? "").match(/\b(19[5-9]\d|20\d\d)\b/);
  return m ? Number(m[1]) : null;
}

export function pruefeZielgruppe(
  person: { headline?: string | null; rolle?: string | null; seit?: string | null },
  regel: ZielgruppenRegel,
  jetzt = new Date(),
): { ok: boolean; grund: string } {
  const text = `${person.headline ?? ""} ${person.rolle ?? ""}`.toLowerCase();
  const raus = woerter(regel.ausschluss).find((w) => text.includes(w));
  if (raus) return { ok: false, grund: `Profil enthält „${raus}“` };
  const erkennung = woerter(regel.erkennung);
  if (erkennung.length && !erkennung.some((w) => text.includes(w)))
    return { ok: false, grund: "Kein Erkennungswort im Profil" };
  const jahr = seitJahr(person.seit);
  const max = regel.max_berufsjahre;
  if (max != null && max > 0 && jahr != null && jetzt.getFullYear() - jahr > max)
    return { ok: false, grund: `Seit ${jahr} im Job (mehr als ${max} Jahre)` };
  return { ok: true, grund: "" };
}

/**
 * SQL-Baustein: gehört der Kontakt `alias` zu einer AKTIVEN Zielgruppe und passt er noch zu ihr?
 * Wird in jede Auswahl für automatische Ansprache eingesetzt. Kontakte ohne Zielgruppe fallen
 * damit bewusst heraus – genau die Altbestände, die den Vorfall ausgelöst haben.
 */
export function zgBedingung(alias: string): string {
  return `EXISTS (SELECT 1 FROM zielgruppen zg LEFT JOIN contact_profile_facts zgf ON zgf.contact_id=${alias}.id
    WHERE zg.id=${alias}.zielgruppe_id AND zg.aktiv=1
      AND zg_passt(${alias}.headline, zgf.rolle, zgf.seit, zg.erkennung, zg.ausschluss, zg.max_berufsjahre)=1)`;
}
