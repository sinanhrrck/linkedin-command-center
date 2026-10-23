// Rein, ohne Profil/DB: zwei echte Terminvorschläge bzw. Buchungslink. Aus modules/angebot.ts
// herausgelöst (2026-10-23), damit die Trainings-Website dieselbe Formulierung nutzt.

const WOCHENTAG = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

/**
 * Die nächsten zwei echten Werktags-Termine (frühestens morgen). Die KI bekommt sie fertig, damit
 * sie kein Datum erfindet und nicht „nächste Woche irgendwann“ schreibt – ein konkreter Vorschlag
 * ist der leichteste Weg zu einem Ja.
 */
export function zweiTermine(now = new Date(), stunden: [number, number] = [17, 18]): string[] {
  const out: string[] = [];
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  for (let i = 1; out.length < 2 && i < 14; i++) {
    const tag = new Date(d);
    tag.setDate(d.getDate() + i);
    if (tag.getDay() === 0 || tag.getDay() === 6) continue;
    const name = i === 1 ? "morgen" : WOCHENTAG[tag.getDay()];
    out.push(`${name} um ${stunden[out.length]} Uhr`);
  }
  return out;
}

/** Wie der nächste Schritt formuliert wird: Link, wenn vorhanden, sonst zwei feste Vorschläge. */
export function ctaText(now: Date, buchungslink?: string | null): string {
  const link = buchungslink?.trim();
  if (link) return `Nächster Schritt: Schick diesen Link zum Termin-Aussuchen, unverändert: ${link}`;
  const [a, b] = zweiTermine(now);
  return `Nächster Schritt: Schlag GENAU diese zwei Termine vor (nichts anderes erfinden): ${a} oder ${b}. Frag, was besser passt.`;
}
