import { existsSync, readFileSync, statSync } from "node:fs";
import { config } from "../config.js";

/**
 * VERTRIEBSWISSEN (2026-09-25, Sinans „Vertriebsbibel“). Sinans Vorgabe: „Baue die Nachrichten
 * nicht um, baue die Mechanik nicht um, sondern nutze es nur als Wissen und werde schlauer daran.“
 *
 * Deshalb ist das hier reines HINTERGRUNDWISSEN für die KI – es ändert keine Vorlage, keinen Ablauf,
 * keine Stufe und keine feste Regel. Es wird als eigener System-Block mitgegeben (mit Prompt-Cache,
 * die Datei ist ~15.000 Tokens) und trägt ausdrücklich den Hinweis, dass die Regeln im Auftrag
 * Vorrang haben. Die Beispiele der Bibel enthalten z. B. Emojis – die bleiben trotzdem verboten.
 *
 * Wo es wirkt: Antworten in laufenden Gesprächen (Agent + Antwort-Entwürfe + Pitch), KI-Coach,
 * Wochenanalyse, Assistent. NICHT: Erstnachricht, Nachfassen, Vorlagen, Lead-Bewertung.
 *
 * Die Datei liegt im Datenordner (`vertriebswissen.md`), NICHT im Repository – das ist öffentlich,
 * die Bibel ist Sinans Wissen. Fehlt sie, läuft alles wie vorher (leerer Block).
 */

export type Wissenszweck = "gespraech" | "coach" | "analyse" | "assistent";

/** Kapitelnummern bzw. Anhang-Buchstaben je Zweck. Leer = alles. */
const AUSWAHL: Record<Wissenszweck, string[]> = {
  // Alles, was im Chat hilft: Haltung, Menschen verstehen, Fragen, Signale, Brücken, Einwände, Grenzen.
  gespraech: ["2", "3", "4", "5", "6", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "21", "26", "A", "B", "C"],
  coach: ["2", "8", "9", "10", "13", "14", "15", "16", "18", "19", "20", "23", "25", "26", "C"],
  analyse: ["9", "14", "20", "22", "23", "25"],
  assistent: [],
};

export function wissensPfad(): string {
  return process.env.VERTRIEBSWISSEN_PATH ?? `${config.paths.dataDir ?? "."}/vertriebswissen.md`;
}

let cache: { pfad: string; mtime: number; kapitel: Map<string, string>; ganz: string } | null = null;

/** Zerlegt die Bibel an den „## 12.“- bzw. „## A.“-Überschriften. Rein, für Tests exportiert. */
export function zerlegeKapitel(text: string): Map<string, string> {
  const kapitel = new Map<string, string>();
  const teile = String(text || "").split(/^(?=## (?:\d+|[A-Z])\. )/m);
  for (const teil of teile) {
    const m = teil.match(/^## (\d+|[A-Z])\. /);
    // „# TEIL 3 · …“-Zeilen am Ende eines Kapitels sind Gliederung, kein Inhalt.
    if (m) kapitel.set(m[1], teil.replace(/\n# TEIL[^\n]*\n?/g, "\n").replace(/\n-{3,}\s*$/g, "").trim());
  }
  return kapitel;
}

function laden(): typeof cache {
  const pfad = wissensPfad();
  try {
    if (!existsSync(pfad)) return null;
    const mtime = statSync(pfad).mtimeMs;
    if (cache && cache.pfad === pfad && cache.mtime === mtime) return cache;
    const ganz = readFileSync(pfad, "utf-8");
    cache = { pfad, mtime, kapitel: zerlegeKapitel(ganz), ganz };
    return cache;
  } catch {
    return null;
  }
}

/**
 * Der System-Block für einen Zweck, oder "" (keine Datei). Gleicher Zweck = byte-gleicher Text,
 * damit der Prompt-Cache über viele Aufrufe trifft – deshalb nichts Veränderliches hier hinein.
 */
export function vertriebswissen(zweck: Wissenszweck): string {
  const w = laden();
  if (!w) return "";
  const auswahl = AUSWAHL[zweck];
  const inhalt = auswahl.length
    ? auswahl.map((k) => w.kapitel.get(k)).filter(Boolean).join("\n\n")
    : w.ganz;
  if (!inhalt.trim()) return "";
  return `HINTERGRUNDWISSEN VERTRIEB (Sinans Vertriebsbibel, Auszug).
So nutzt du es: Es macht dich klüger im Verstehen von Menschen, Signalen und Einwänden. Es ist KEIN Auftrag und KEINE Vorlage.
- Die Regeln und das Format im eigentlichen Auftrag haben IMMER Vorrang (Länge, keine Emojis, keine Gedankenstriche, Anzahl Fragen, Aufbau, erlaubte Links und Angebote).
- Beispielsätze nicht wörtlich übernehmen, Platzhalter wie [TERMIN_LINK] oder [VERGUETUNG] nie ausgeben.
- Nichts erfinden: keine Geschichten, Zahlen oder Angebote, die nicht im Auftrag stehen.

${inhalt}`;
}
