import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { config } from "../config.js";
import { getState, setState } from "../db/index.js";
import { governor } from "./safetyGovernor.js";

/**
 * SERVER-MODUS (2026-09-21): Betrieb ohne App-Hülle auf einem Heimserver (Docker, kein
 * Bildschirm). Alles hier ist an `NEXTLEAD_SERVER=1` gebunden; Mac-App und Dev-Modus rufen
 * nichts davon auf bzw. bekommen ein No-op.
 */
export const istServerModus = (): boolean => config.server.serverModus;

/** Name der Marker-Datei, die `npm run umzug -- import` in den Datenordner schreibt. */
export const UMZUG_INFO = "umzug-info.json";

/**
 * Harte Startbedingungen. Wird VOR dem Öffnen des Ports geprüft, damit ein offenes Dashboard
 * im Heimnetz ohne Token gar nicht erst entstehen kann.
 */
export function pruefeServerStartbedingungen(): void {
  if (!istServerModus()) return;
  if (config.paths.dataDir) mkdirSync(config.paths.dataDir, { recursive: true });
  if (!config.server.token || config.server.token.length < 12) {
    console.error(
      "\n[server] START VERWEIGERT: DASHBOARD_TOKEN fehlt oder ist kürzer als 12 Zeichen.\n" +
        "         Das Dashboard wäre sonst für jeden im Netz ohne Anmeldung erreichbar.\n" +
        `         Trag in ${config.paths.envPath} eine Zeile DASHBOARD_TOKEN=<zufälliger Wert> ein\n` +
        "         (Erzeugen: openssl rand -hex 24) und starte neu.\n",
    );
    process.exit(78); // EX_CONFIG
  }
}

/**
 * Basic-Auth gegen DASHBOARD_TOKEN. Nutzername ist egal, das Passwort ist das Token.
 * Zeitkonstanter Vergleich, damit das Token nicht zeichenweise erraten werden kann.
 */
export function anmeldungOk(req: IncomingMessage): boolean {
  const token = config.server.token;
  if (!token) return true; // kein Token konfiguriert = wie bisher (nur localhost)
  const kopf = req.headers.authorization ?? "";
  if (!kopf.startsWith("Basic ")) return false;
  let pass = "";
  try {
    const roh = Buffer.from(kopf.slice(6), "base64").toString("utf8");
    pass = roh.slice(roh.indexOf(":") + 1);
  } catch {
    return false;
  }
  const a = Buffer.from(pass);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Schreibt einmal ins Log, mit welcher Uhrzeit die Prozesse rechnen (Arbeitszeitfenster!). */
export function logZeitzone(wer: string): void {
  const jetzt = new Date();
  const tz = process.env.TZ ?? "(TZ nicht gesetzt)";
  const lokal = jetzt.toLocaleString("de-DE", { timeZone: undefined });
  const berlin = jetzt.toLocaleString("de-DE", { timeZone: "Europe/Berlin" });
  console.info(`[${wer}] Zeit: lokal ${lokal} · TZ=${tz} · Berlin ${berlin} · Browser meldet ${config.browser.timezone}`);
  if (lokal !== berlin) console.warn(`[${wer}] ACHTUNG: Prozesszeit ≠ Europe/Berlin – Arbeitszeitfenster des Governors verschieben sich. TZ=Europe/Berlin setzen.`);
}

/**
 * ERSTSTART AUF DEM SERVER. LinkedIn sieht ein neues Gerät (andere IP, Linux-Chromium).
 * Deshalb: (1) Not-Aus AN – es wird nichts gesendet, bis der Nutzer es im Dashboard freigibt,
 * (2) Warm-up zurück auf Tag 1 (start_date = jetzt), damit die Caps wieder bei 50 % beginnen.
 * Läuft genau einmal je Datenordner (Marker `server_first_start` in state).
 */
export function serverErststart(): void {
  if (!istServerModus()) return;
  if (getState("server_first_start")) return;
  const jetzt = new Date().toISOString();
  governor.setNotAus(true);
  setState("start_date", jetzt);
  setState("server_first_start", jetzt);
  console.warn(
    "[server] ERSTSTART: Not-Aus ist AKTIV (kein Versand) und der Warm-up beginnt neu bei Tag 1.\n" +
      "         Freigeben: im Dashboard unter Einstellungen den Not-Aus lösen.",
  );
  warneWennDbNachExportGeaendert();
}

/**
 * Warnung, wenn die eingespielte Datenbank NACH dem Export auf dem Mac noch verändert wurde:
 * dann lief die Mac-App weiter, und beide Datenbanken sind auseinandergelaufen. Die Prüfung
 * vergleicht die Datei-Änderungszeit (tar erhält sie beim Entpacken) mit dem Export-Zeitpunkt
 * aus umzug-info.json. WICHTIG: die Änderungszeit stammt aus config.ts, gemessen BEVOR die DB
 * geöffnet wurde – nach dem Öffnen trägt die Datei die Startzeit dieses Prozesses (Fehlalarm
 * beim ersten echten Serverstart 2026-09-22). Nur beim Erststart sinnvoll.
 */
function warneWennDbNachExportGeaendert(): void {
  try {
    if (!config.paths.dataDir) return;
    const infoPfad = `${config.paths.dataDir}/${UMZUG_INFO}`;
    if (!existsSync(infoPfad) || !existsSync(config.paths.dbPath)) return;
    const info = JSON.parse(readFileSync(infoPfad, "utf8")) as { exportedAt?: string; dbMtime?: string };
    const exportZeit = info.exportedAt ? new Date(info.exportedAt).getTime() : 0;
    const dbZeit = config.paths.dbMtimeBeimStart;
    if (exportZeit && dbZeit && dbZeit > exportZeit + 60_000) {
      console.warn(
        `[server] WARNUNG: data.db wurde nach dem Export (${info.exportedAt}) noch verändert (${new Date(dbZeit).toISOString()}).\n` +
          "         Vermutlich lief die Mac-App weiter. Prüfe, ob du den aktuellen Stand exportiert hast – zwei Instanzen am selben Konto sind nicht erlaubt.",
      );
      setState("server_db_warnung", `DB nach Export verändert (${new Date(dbZeit).toISOString()})`);
    }
  } catch {
    /* Warnung ist Komfort, nie kritisch */
  }
}
