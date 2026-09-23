import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { config } from "../config.js";
import { getProfil, type LeadMagnet, type Profil } from "../profil.js";

/**
 * ANGEBOTS-SCHICHT (2026-09-23, Sinan: „vertrieblicher, stell dir vor du bist Alex Hormozi“).
 *
 * Vorher kannte nur der Gesprächsagent das Angebot, und zwar als Fließtext. Erstnachricht,
 * Follow-ups und Reaktivierung durften ausdrücklich KEINEN Wert anbieten – ein Follow-up war
 * reines „wollte nochmal nachfragen“. Hier liegt jetzt EINE Quelle für: welche kostenlosen
 * Angebote (Lead Magnets) es gibt, welches zu welchem Signal passt, und wie der nächste Schritt
 * konkret aussieht (Buchungslink oder zwei echte Terminvorschläge statt „melde dich gern“).
 *
 * Reine Funktionen über `getProfil()`. Nichts ist hart verdrahtet: steht kein Lead Magnet im
 * Profil, liefern alle Blöcke einen leeren String und die Prompts verhalten sich wie vorher.
 */

export type Route = LeadMagnet["route"];

/** Aktive, tatsächlich lieferbare Lead Magnets. Eine Unterlage ohne Link ist nicht lieferbar. */
export function leadMagnete(route?: Route | null, p: Profil = getProfil()): LeadMagnet[] {
  return (p.leadMagnete || []).filter((m) =>
    m && m.aktiv !== false && m.titel?.trim() && m.cta?.trim()
    && (m.art !== "unterlage" || !!m.link?.trim())
    && (!route || m.route === route));
}

export function leadMagnet(key: string, p: Profil = getProfil()): LeadMagnet | null {
  return leadMagnete(null, p).find((m) => m.key === key) ?? null;
}

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
export function ctaAnweisung(now = new Date(), p: Profil = getProfil()): string {
  const link = p.buchungslink?.trim();
  if (link) return `Nächster Schritt: Schick diesen Link zum Termin-Aussuchen, unverändert: ${link}`;
  const [a, b] = zweiTermine(now);
  return `Nächster Schritt: Schlag GENAU diese zwei Termine vor (nichts anderes erfinden): ${a} oder ${b}. Frag, was besser passt.`;
}

/** Alle Links, die ein Text enthalten darf. Alles andere ist erfunden. */
export function erlaubteLinks(p: Profil = getProfil()): string[] {
  return [p.buchungslink, ...(p.leadMagnete || []).map((m) => m.link)]
    .map((l) => String(l || "").trim()).filter(Boolean);
}

const magnetZeile = (m: LeadMagnet) =>
  `- ${m.titel} [passt bei: ${m.route === "finanzen" ? "Geld-/Finanzfragen" : "Orientierung, Karriere, Weg nach der Ausbildung"}]. `
  + `Nutzen: ${m.nutzen}. Ablauf: ${m.ablauf}. Leicht anbieten mit z. B.: "${m.cta}"`;

/**
 * Block für den Gesprächsagenten in den Angebots-Phasen: WELCHES Angebot zu welchem Signal
 * passt. Vorher bot die Phase `call_angebot` immer die Potenzialanalyse an – auch wenn jemand
 * gerade konkrete Geldfragen gestellt hatte und eigentlich ins Beratungsgespräch gehörte.
 */
export function angebotsWahl(now = new Date(), p: Profil = getProfil()): string {
  const alle = leadMagnete(null, p);
  const cta = ctaAnweisung(now, p);
  if (!alle.length) {
    return `# Welches Angebot?
Wähle nach dem Signal der Person: Orientierung/Karriere/Jobsuche → das Karriere-Angebot aus "Dein Angebot". Konkrete Geld-/Finanzfragen → ein kurzes, kostenloses Gespräch, in dem genau diese Fragen durchgegangen werden. Nie beides in einer Nachricht.
${cta}`;
  }
  return `# Welches Angebot?
Wähle GENAU EINES, passend zum Signal der Person. Nie zwei in einer Nachricht.
${alle.map(magnetZeile).join("\n")}
${cta}`;
}

/**
 * Kurzer Hinweis für Nachfass-Nachrichten und Reaktivierung (Phase 2): EIN Angebot als leichtes,
 * optionales Ja. Ohne gepflegte Lead Magnets leer → die Prompts bleiben wie vorher.
 */
export function angebotsHinweis(route?: Route | null, key?: string, p: Profil = getProfil()): string {
  const auswahl = key ? [leadMagnet(key, p)].filter(Boolean) as LeadMagnet[] : leadMagnete(route, p);
  const m = auswahl[0];
  if (!m) return "";
  return `ANGEBOT FÜR DIESE NACHRICHT (optional, als leichtes Ja, niemals als Pitch):
${magnetZeile(m)}
Erst der Nutzen für die Person, dann die leichte Frage. Kein Link, keine Preise, kein Druck.`;
}

/** Belege, die die KI verwenden darf. Leer = sie darf keine Erfolge behaupten. */
export function beweisBlock(p: Profil = getProfil()): string {
  const b = (p.beweise || []).map((x) => String(x).trim()).filter(Boolean);
  return b.length
    ? `ECHTE BELEGE (nur diese verwenden, nichts dazuerfinden, keine Zahlen ergänzen):\n${b.map((x) => `- ${x}`).join("\n")}`
    : "BELEGE: keine hinterlegt. Behaupte keine Erfolge, Zahlen oder Kundengeschichten.";
}

/**
 * Vorschläge für das Einstellungs-Formular. Das sind VORLAGEN für den Nutzer, sie wirken erst,
 * wenn er sie speichert und aktiviert – kein Prompt liest diese Liste.
 */
export const LEAD_MAGNET_VORSCHLAEGE: LeadMagnet[] = [
  {
    key: "potenzialanalyse", titel: "kostenlose Potenzialanalyse", route: "karriere", art: "gespraech",
    nutzen: "Klarheit über die eigenen Stärken und Antriebe, schwarz auf weiß. Hilft bei Jobsuche, Gehaltsgespräch und der Frage, welcher Weg nach der Ausbildung passt",
    ablauf: "15–20 Minuten online ausfüllen, danach gehen wir das Ergebnis zusammen durch",
    cta: "Soll ich dir mal zeigen, wie das abläuft?",
    naechsterSchritt: "Zugangscode schicken und Termin fürs Auswertungsgespräch ausmachen", aktiv: false,
  },
  {
    key: "beratung", titel: "kurzes kostenloses Gespräch zu deinen Geldfragen", route: "finanzen", art: "gespraech",
    nutzen: "Die konkreten Fragen (Konto, Sparen, Absicherung, Finanzierung) werden Punkt für Punkt geklärt, statt halb im Chat",
    ablauf: "etwa 20 Minuten, Telefon oder Video",
    cta: "Wollen wir das einmal kurz in Ruhe durchgehen?",
    naechsterSchritt: "Termin festmachen, danach übernimmt der Mensch", aktiv: false,
  },
  {
    key: "gehaltscheck", titel: "Gehalts-Check nach der Ausbildung", route: "finanzen", art: "gespraech",
    nutzen: "Was vom ersten vollen Gehalt nach der Ausbildung wirklich übrig bleibt und was man damit sinnvoll anfängt, bevor sich schlechte Gewohnheiten einschleifen",
    ablauf: "15 Minuten, am Telefon",
    cta: "Hast du Lust auf einen kurzen Gehalts-Check?",
    naechsterSchritt: "Termin festmachen", aktiv: false,
  },
  {
    key: "karrierecheck", titel: "Karriere-Check: was nach der Ausbildung möglich ist", route: "karriere", art: "gespraech",
    nutzen: "Ein ehrlicher Überblick, welche Wege es nach der Ausbildung gibt (Weiterbildung, Studium, Wechsel, eigenes Business) und was davon zur Person passt",
    ablauf: "20 Minuten, locker am Telefon",
    cta: "Wollen wir da mal 20 Minuten drüber sprechen?",
    naechsterSchritt: "Termin festmachen", aktiv: false,
  },
];

const text = (v: unknown, max = 400) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const istLink = (v: string) => /^https:\/\/[^\s]+$/i.test(v);

/** Säubert Eingaben aus dem Cockpit. Wirft mit verständlichem Grund, statt Unsinn zu speichern. */
export function pruefeAngebot(input: { leadMagnete?: unknown; beweise?: unknown; buchungslink?: unknown }) {
  const roh = Array.isArray(input.leadMagnete) ? input.leadMagnete : [];
  if (roh.length > 8) throw new Error("Höchstens 8 Angebote.");
  const keys = new Set<string>();
  const leadMagnete: LeadMagnet[] = roh.map((r, i) => {
    const m = (r || {}) as Record<string, unknown>;
    const titel = text(m.titel, 120);
    if (!titel) throw new Error(`Angebot ${i + 1}: Titel fehlt.`);
    let key = text(m.key, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
      || titel.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    while (keys.has(key)) key += "-2";
    keys.add(key);
    const link = text(m.link, 300);
    if (link && !istLink(link)) throw new Error(`„${titel}“: Der Link muss mit https:// beginnen.`);
    const art = m.art === "unterlage" ? "unterlage" : "gespraech";
    const aktiv = m.aktiv !== false;
    if (aktiv && art === "unterlage" && !link) throw new Error(`„${titel}“ ist eine Unterlage und braucht einen Link, sonst kann sie niemand bekommen.`);
    if (aktiv && !text(m.cta)) throw new Error(`„${titel}“: Die Frage, mit der es angeboten wird, fehlt.`);
    return {
      key, titel, route: m.route === "finanzen" ? "finanzen" : "karriere", art,
      nutzen: text(m.nutzen), ablauf: text(m.ablauf, 240), cta: text(m.cta, 200),
      naechsterSchritt: text(m.naechsterSchritt, 200), ...(link ? { link } : {}), aktiv,
    };
  });
  const beweise = (Array.isArray(input.beweise) ? input.beweise : String(input.beweise ?? "").split("\n"))
    .map((b) => text(b, 300)).filter(Boolean).slice(0, 8);
  const buchungslink = text(input.buchungslink, 300);
  if (buchungslink && !istLink(buchungslink)) throw new Error("Der Buchungslink muss mit https:// beginnen.");
  return { leadMagnete, beweise, buchungslink };
}

/**
 * Schreibt NUR diese drei Felder in profil.local.json – alles andere (Persona, Stil, Beispiele)
 * bleibt Byte für Byte erhalten. Atomar über eine Zwischendatei, damit ein Absturz mitten im
 * Schreiben nie ein halbes Profil hinterlässt.
 */
export function speichereAngebot(input: Parameters<typeof pruefeAngebot>[0], pfad = config.paths.profilPath) {
  const sauber = pruefeAngebot(input);
  const bestehend = existsSync(pfad) ? JSON.parse(readFileSync(pfad, "utf8")) as Record<string, unknown> : {};
  const neu = { ...bestehend, leadMagnete: sauber.leadMagnete, beweise: sauber.beweise, buchungslink: sauber.buchungslink };
  const tmp = `${pfad}.tmp`;
  writeFileSync(tmp, JSON.stringify(neu, null, 2));
  renameSync(tmp, pfad);
  return sauber;
}

/** Was das Cockpit-Formular zum Vorbefüllen braucht. */
export function angebotFuerCockpit(p: Profil = getProfil()) {
  const vorhanden = new Set((p.leadMagnete || []).map((m) => m.key));
  return {
    leadMagnete: p.leadMagnete || [],
    beweise: p.beweise || [],
    buchungslink: p.buchungslink || "",
    vorschlaege: LEAD_MAGNET_VORSCHLAEGE.filter((m) => !vorhanden.has(m.key)),
    fliesstextAngebot: Boolean((p.angebot || "").trim()),
  };
}
