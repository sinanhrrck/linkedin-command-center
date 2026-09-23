import { readFileSync, existsSync, statSync } from "node:fs";
import { config } from "./config.js";
import { join } from "node:path";

/**
 * NUTZER-PROFIL. Alles, was das Tool von einer PERSON wissen muss, damit die KI in IHRER
 * Stimme schreibt: wer sie ist, ihr Ziel, ihr Stil, ihre Beispiel-Nachrichten, ihre Winkel.
 *
 * Früher stand das fest im Code (context.ts) und war komplett auf Sinan zugeschnitten. Jetzt
 * kommt es aus einer Datei, damit JEDER das Tool lokal mit SEINEM Profil nutzen kann, ohne
 * Code anzufassen. Reihenfolge beim Laden:
 *   1. profil.local.json   → das persönliche Profil des Nutzers (gitignored, bleibt lokal)
 *   2. profil.example.json → neutrale Blaupause (liegt im Repo, wird mitgeliefert)
 *   3. eingebauter Default (unten) → falls beide Dateien fehlen, läuft das Tool trotzdem
 *
 * Der Setup-Assistent (später) schreibt profil.local.json. Bis dahin kann man die Datei von
 * Hand anlegen (profil.example.json kopieren und ausfüllen).
 */
/**
 * LEAD MAGNET (2026-09-23): ein konkretes, kostenloses Angebot, zu dem man leicht Ja sagen kann
 * (Hormozi: erst Wert geben, dann fragen). Bewusst STRUKTURIERT statt Fließtext, damit Follow-ups,
 * Agent und Varianten-Test gezielt EINES davon einsetzen können.
 * `route` = zu welchem Signal es passt: "karriere" (Orientierung, Jobsuche, Weg nach der
 * Ausbildung) oder "finanzen" (Geld-, Spar-, Absicherungsfragen). Nichts davon ist im Code
 * hart verdrahtet – angeboten wird NUR, was hier steht und `aktiv` ist.
 */
export type LeadMagnet = {
  key: string;
  titel: string;
  route: "karriere" | "finanzen";
  /** Was die Person davon hat – in ihren Worten, nicht in Produktsprache. */
  nutzen: string;
  /** Wie es abläuft (Dauer, online/Telefon, was danach passiert). */
  ablauf: string;
  /** Die leichte Frage, mit der es angeboten wird ("Soll ich dir zeigen, wie das abläuft?"). */
  cta: string;
  /** Was nach einem Ja passiert (für den Agent und die Übergabe an den Menschen). */
  naechsterSchritt: string;
  /** Nur für Unterlagen (PDF, Rechner). Ohne Link wird ein solches Angebot nie gemacht. */
  link?: string;
  art?: "gespraech" | "unterlage";
  aktiv?: boolean;
};

export type Profil = {
  /** Vorname, wird in Prompts als Label genutzt ("Über <name>", "So klingt <name>"). */
  name: string;
  /** Wer die Person ist: Rolle + Wesen, ausformuliert. Ein bis drei Sätze. */
  persona: string;
  /** Was eine Nachricht erreichen soll (Mehrwert-first, nicht verkaufen …). */
  ziel: string;
  /** DEIN konkretes Angebot als Mehrwert-Türöffner: was es ist, für wen, der nächste Schritt.
   *  Der Agent bietet es an, sobald ein echter Bedarf sichtbar wird (z.B. Jobsuche). Optional –
   *  leer = der Agent bleibt rein beim Kennenlernen. */
  angebot?: string;
  /** Strukturierte Lead Magnets (siehe Typ oben). Leer = nur der Fließtext `angebot` wirkt. */
  leadMagnete?: LeadMagnet[];
  /** Echte Belege: kurze eigene Geschichten/Ergebnisse. Die KI darf NUR diese verwenden. */
  beweise?: string[];
  /** Optionaler Buchungslink (z. B. Calendly). Ohne Link schlägt der Bot zwei Termine vor. */
  buchungslink?: string;
  /** Harte Grenzen, die kein Gesprächsziel aushebeln darf (Vertriebs-Timing, Tabus). */
  tabus: string;
  /** Konkrete Stil-Regeln, eine pro Eintrag. */
  stilRegeln: string[];
  /** 1–4 echte Nachrichten in der Stimme der Person (Few-Shot, hebt die Qualität stark). */
  beispielNachrichten: string[];
  /** Erstnachricht-Winkel je Zielgruppe (an frisch Vernetzte). */
  winkel: { azubi: string; student: string };
};

/**
 * Eingebauter Default: bewusst NEUTRAL (kein Sinan, kein Fin.Co). Greift nur, wenn weder
 * profil.local.json noch profil.example.json existieren – dann schreibt die KI generisch,
 * aber das Tool startet und stürzt nicht ab.
 */
const DEFAULT_PROFIL: Profil = {
  name: "Ich",
  persona:
    "Eine sympathische, ehrliche Person, die auf Augenhöhe schreibt. Kein Verkäufersprech, " +
    "keine Business-Floskeln, echtes Interesse am Menschen gegenüber.",
  ziel:
    "Mehrwert zuerst: ehrlich hilfreich und sympathisch sein, echtes Interesse zeigen. " +
    "NICHT verkaufen, NICHT pitchen. Die Tür für ein späteres Gespräch sanft offen halten.",
  angebot: "",
  tabus:
    "ZUERST VERDIENEN, DANN ANBIETEN. Solange die Person keinen Bedarf, Zweifel oder Interesse " +
    "gezeigt hat, ist jede Nachricht reines Kennenlernen. Kein Angebot, keine Beratung. " +
    "NIEMALS nach privaten/sensiblen Themen fragen, die die Person nicht selbst aufgemacht hat.",
  stilRegeln: [
    "immer per Du, niemals siezen",
    "keine Emojis",
    "kurz halten: 2 bis 3 Sätze, niemals mehr",
    "locker und menschlich, kein Verkäufersprech",
    "mit EINER echten, konkreten Frage enden",
  ],
  beispielNachrichten: [],
  winkel: {
    azubi:
      "Nimm Bezug auf die aktuelle Ausbildung/den Berufseinstieg der Person und zeige echtes " +
      "Interesse an ihrem weiteren Weg. Kein Pitch.",
    student:
      "Nimm Bezug auf das Studium der Person und zeige echtes Interesse an ihrem weiteren Weg. " +
      "Behaupte nur eigene Erfahrungen, die du wirklich hast. Kein Pitch.",
  },
};

function ladeProfil(): Profil {
  // Das persönliche Profil liegt am konfigurierten Ort (Datenordner im Server-Modus, sonst wie
  // bisher im Arbeitsverzeichnis); die Beispiel-Vorlage bleibt im Projektordner.
  for (const pfad of [config.paths.profilPath, join(process.cwd(), "profil.example.json")]) {
    if (!existsSync(pfad)) continue;
    try {
      const roh = JSON.parse(readFileSync(pfad, "utf8")) as Partial<Profil>;
      // Felder einzeln übernehmen → fehlende Felder fallen sauber auf den Default zurück.
      const p: Profil = {
        ...DEFAULT_PROFIL,
        ...roh,
        winkel: { ...DEFAULT_PROFIL.winkel, ...(roh.winkel ?? {}) },
      };
      if (pfad.endsWith("profil.example.json"))
        console.info("[profil] Kein profil.local.json gefunden – nutze die Beispiel-Vorlage. Leg dein eigenes Profil an (profil.example.json kopieren → profil.local.json).");
      return p;
    } catch (e) {
      console.error(`[profil] ${pfad} ist fehlerhaft (kein gültiges JSON):`, (e as Error).message);
    }
  }
  console.warn("[profil] Kein Profil gefunden – nutze den neutralen Default. Nachrichten werden generisch.");
  return DEFAULT_PROFIL;
}

/** Beim Start geladen. Für Texte bitte `getProfil()` nutzen – das sieht Änderungen sofort. */
export const profil = ladeProfil();

/**
 * Aktuelles Profil, neu geladen, sobald sich die Datei ändert. Grund: Dashboard und Engine sind
 * getrennte Prozesse. Ein im Cockpit gespeichertes Angebot wirkte sonst erst nach einem
 * Engine-Neustart – der Nutzer hätte gespeichert und nichts gesehen.
 */
let cache: { mtime: number; profil: Profil } | null = null;
export function getProfil(): Profil {
  let mtime = -1;
  try { mtime = existsSync(config.paths.profilPath) ? statSync(config.paths.profilPath).mtimeMs : -1; } catch { /* Datei weg → Default */ }
  if (!cache || cache.mtime !== mtime) cache = { mtime, profil: mtime === -1 && !cache ? profil : ladeProfil() };
  return cache.profil;
}
