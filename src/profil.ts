import { readFileSync, existsSync } from "node:fs";
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
export type Profil = {
  /** Vorname, wird in Prompts als Label genutzt ("Über <name>", "So klingt <name>"). */
  name: string;
  /** Wer die Person ist: Rolle + Wesen, ausformuliert. Ein bis drei Sätze. */
  persona: string;
  /** Was eine Nachricht erreichen soll (Mehrwert-first, nicht verkaufen …). */
  ziel: string;
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
  for (const datei of ["profil.local.json", "profil.example.json"]) {
    const pfad = join(process.cwd(), datei);
    if (!existsSync(pfad)) continue;
    try {
      const roh = JSON.parse(readFileSync(pfad, "utf8")) as Partial<Profil>;
      // Felder einzeln übernehmen → fehlende Felder fallen sauber auf den Default zurück.
      const p: Profil = {
        ...DEFAULT_PROFIL,
        ...roh,
        winkel: { ...DEFAULT_PROFIL.winkel, ...(roh.winkel ?? {}) },
      };
      if (datei === "profil.example.json")
        console.info("[profil] Kein profil.local.json gefunden – nutze die Beispiel-Vorlage. Leg dein eigenes Profil an (profil.example.json kopieren → profil.local.json).");
      return p;
    } catch (e) {
      console.error(`[profil] ${datei} ist fehlerhaft (kein gültiges JSON):`, (e as Error).message);
    }
  }
  console.warn("[profil] Kein Profil gefunden – nutze den neutralen Default. Nachrichten werden generisch.");
  return DEFAULT_PROFIL;
}

export const profil = ladeProfil();
