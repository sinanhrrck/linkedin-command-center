import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const db = new Database(config.paths.dbPath);
db.pragma("journal_mode = WAL");
db.exec(readFileSync(join(__dirname, "schema.sql"), "utf-8"));

// Leichte Migration: Spalten für bestehende DBs nachrüsten (CREATE IF NOT EXISTS
// ergänzt keine Spalten). Wirft, wenn Spalte schon da → ignorieren.
try {
  db.exec("ALTER TABLE lead_sources ADD COLUMN keep_filter TEXT");
} catch {
  /* Spalte existiert bereits */
}
try {
  db.exec("ALTER TABLE contacts ADD COLUMN messaged_at TEXT"); // wann Erstnachricht raus (für Follow-up-Timing)
} catch {
  /* Spalte existiert bereits */
}
try {
  db.exec("ALTER TABLE contacts ADD COLUMN replied_at TEXT"); // wann der Kontakt geantwortet hat (Hot Lead)
} catch {
  /* Spalte existiert schon */
}
try {
  db.exec("ALTER TABLE contacts ADD COLUMN zielgruppe TEXT"); // azubi | student -> Winkel der Erstnachricht
} catch {
  /* Spalte existiert schon */
}
try {
  // Lead-Score aus Name+Headline (kein Profilbesuch -> kein profileView-Risiko). Priorisiert
  // die begrenzten Tages-Anfragen auf die besten Leads und sortiert echten Muell aus.
  db.exec("ALTER TABLE contacts ADD COLUMN lead_score INTEGER");
} catch {
  /* Spalte existiert schon */
}
try {
  db.exec("ALTER TABLE contacts ADD COLUMN score_grund TEXT");
} catch {
  /* Spalte existiert schon */
}
try {
  db.exec("ALTER TABLE lead_sources ADD COLUMN zielgruppe TEXT"); // azubi | student -> Fokus-Steuerung
} catch {
  /* Spalte existiert schon */
}
try {
  // Der ehrlichste Qualitaetsmassstab: schickt Sinan den KI-Vorschlag unveraendert raus, war er
  // gut. Schreibt er ihn um, zeigt genau diese Aenderung, was der KI fehlt. Das Original wird
  // deshalb NIE ueberschrieben - nach einer Woche laesst sich objektiv entscheiden, ob der Bot
  // den Tuer-Moment allein fahren darf.
  db.exec("ALTER TABLE drafts ADD COLUMN ki_original TEXT");
} catch {
  /* Spalte existiert schon */
}
try {
  db.exec("ALTER TABLE drafts ADD COLUMN intent TEXT"); // Einordnung der KI (chance/einwand/...)
} catch {
  /* Spalte existiert bereits */
}

/** Key/Value-State */
export const getState = (key: string): string | undefined =>
  (db.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | undefined)
    ?.value;

export const setState = (key: string, value: string) =>
  db.prepare(
    "INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, value);

/** Automatik-Modus: manual | semi | full. Steuert, was der Bot ohne Freigabe sendet. */
export type Mode = "manual" | "semi" | "full";
export const getMode = (): Mode => {
  const m = getState("mode");
  return m === "semi" || m === "full" ? m : "manual";
};
export const setMode = (m: Mode) => setState("mode", m);

/** Startdatum des Tools (für Warm-up-Berechnung), einmalig gesetzt. */
export function getStartDate(): Date {
  let iso = getState("start_date");
  if (!iso) {
    iso = new Date().toISOString();
    setState("start_date", iso);
  }
  return new Date(iso);
}

/**
 * FOKUS: auf welche Zielgruppen soll der Bot gerade gehen? Steuert, welche Lead-Quellen
 * abgegrast werden (leadFeed). Sinan stellt das im Dashboard ein, der Bot holt sich den
 * Nachschub dann von allein – ohne dass jemand Quellen an- und ausknipsen muss.
 * "beides" = alle Quellen. Default: azubi (Sinans Kern-Zielgruppe).
 */
export type Focus = "azubi" | "student" | "beides";

export function getFocus(): Focus {
  const v = getState("focus");
  return v === "student" || v === "beides" ? v : "azubi";
}

export function setFocus(f: Focus) {
  setState("focus", f);
}

/**
 * KATEGORIENWEISE AUTONOMIE – das Rueckgrat des Stufenmodells.
 * Statt eines Grobschalters (manual/semi/full) entscheidet pro Signal-Typ, ob der Bot
 * autonom handelt ("auto") oder Sinan uebergibt ("ask"). So laesst sich die Freigabe
 * kategorienweise anheben, sobald die Wochen-Bilanz zeigt, dass eine Kategorie sitzt –
 * genau Sinans Stufe 2 ("Kategorien, bei denen du ~immer gleich entscheidest, werden
 * freigegeben"). Greift nur im full-Modus (im Autopilot); manual/semi machen weiter Entwuerfe.
 *
 * Defaults bilden das heutige Verhalten ab: Routine + Abschiede laufen autonom, die
 * vertrieblich heiklen Momente (Tuer + Einwand) gehen erst mal zu Sinan.
 */
export type IntentKat = "absage" | "einwand" | "chance" | "positive" | "neutral";
const AUTONOMIE_DEFAULT: Record<IntentKat, "auto" | "ask"> = {
  absage: "auto",   // Abschied, nichts zu entscheiden
  neutral: "auto",  // Smalltalk
  positive: "auto", // interessiert, aber noch kein Tuer-Moment
  chance: "ask",    // DER Vertriebsmoment -> Sinans Wahl: erst beobachten
  einwand: "ask",   // heikel, ein falscher Satz verbrennt den Lead
};

export function autonomyFor(intent: string): "auto" | "ask" {
  const v = getState(`autonomy_${intent}`);
  if (v === "auto" || v === "ask") return v;
  return AUTONOMIE_DEFAULT[intent as IntentKat] ?? "ask";
}

export function setAutonomy(intent: IntentKat, val: "auto" | "ask") {
  setState(`autonomy_${intent}`, val);
}
