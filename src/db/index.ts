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
