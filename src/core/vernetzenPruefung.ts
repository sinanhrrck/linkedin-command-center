/**
 * VERNETZEN: WEN klicke ich wirklich? (2026-10-27, Auslöser: „outreach – 3 technische Fehler:
 * Einladung-Senden-Button nicht gefunden“).
 *
 * `findConnectButton` nahm den ERSTEN Knopf mit „… als Kontakt einladen“ auf der ganzen Seite. Steht
 * „Vernetzen“ beim Profil selbst nicht offen (unter „Mehr“, Einladung schon ausstehend, nur „Folgen“),
 * trifft das die Vorschlagskarten rechts („Weitere Profile“) – deren Knopf lädt einen FREMDEN sofort
 * ein, ohne Bestätigungsfenster. Genau das Fehlerbild „Senden-Button nicht gefunden“, nur dass die
 * Einladung beim Falschen rausging und nicht gezählt wurde.
 *
 * Regel jetzt: geklickt wird nur ein Knopf, dessen Beschriftung den NAMEN DES PROFILS trägt (aus der
 * Überschrift gelesen). Kein Name → kein Klick. Reine Funktionen, damit testbar ohne Browser.
 */

const TITEL = new Set(["dr", "prof", "mba", "msc", "bsc", "ba", "ma", "ll.m", "dipl", "ing"]);

export function normalName(s: string | null | undefined): string {
  return String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss").replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
}

/** Namensteile, die in der Knopf-Beschriftung stehen müssen (ohne Titel, ohne Ein-Buchstaben-Kürzel). */
export function namensTeile(name: string | null | undefined): string[] {
  return normalName(name).split(/[\s-]+/).filter((t) => t.length >= 2 && !TITEL.has(t));
}

/** Gehört diese Knopf-Beschriftung (aria-label) zu genau diesem Profil? Ohne Namen immer nein. */
export function labelGehoertZu(label: string | null | undefined, name: string | null | undefined): boolean {
  const teile = namensTeile(name);
  if (!teile.length) return false;
  // Ganze Wörter vergleichen (Bindestriche trennen): „Lenas“ ist nicht „Lena“.
  const woerter = new Set(normalName(label).split(/[\s-]+/));
  return teile.every((t) => woerter.has(t));
}

/** Zeigt der Knopf, dass die Einladung schon raus ist? („Ausstehend, … zurückziehen“ / „Pending“) */
export function istAusstehendLabel(label: string | null | undefined): boolean {
  return /ausstehend|pending|zur(u|ü)ckziehen|withdraw/i.test(String(label ?? ""));
}

/** LinkedIns Wochenlimit-/Sperrhinweis im Vernetzen-Fenster. */
export function istEinladungsLimitText(text: string | null | undefined): boolean {
  const t = String(text ?? "").replace(/\s+/g, " ");
  return /w(ö|oe)chentliche[sn]? (einladungs)?limit|limit (f(ü|ue)r|an) einladungen|zu viele einladungen|weekly (invitation )?limit|invitation limit|too many invitations/i.test(t);
}

/** Eigentlicher Name aus der Profil-Überschrift: ohne Zusätze wie „(sie/ihr)“, „, CFP“ oder „| Azubi“. */
export function nameAusUeberschrift(h1: string | null | undefined): string | null {
  const erste = String(h1 ?? "").split("\n")[0];
  const name = erste.split(/[,(|•·]/)[0].replace(/\s+/g, " ").trim();
  return namensTeile(name).length ? name : null;
}
