import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

// Dieselbe Datei, die config.ts beim Start geladen hat (Datenordner im Server-Modus, sonst ./.env).
const ENV_PATH = config.paths.envPath;

/**
 * Schreibt/aktualisiert Schlüssel in der .env-Datei, ohne den Rest zu zerstören.
 * Vorhandene Keys werden ersetzt, neue angehängt. Aktualisiert auch process.env,
 * damit frisch geschriebene Werte im laufenden Prozess sofort verfügbar sind.
 */
export function upsertEnv(vars: Record<string, string>) {
  let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf-8") : "";
  for (const [key, value] of Object.entries(vars)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    content = re.test(content) ? content.replace(re, line) : content.trimEnd() + `\n${line}\n`;
    process.env[key] = value;
  }
  mkdirSync(dirname(ENV_PATH), { recursive: true });
  writeFileSync(ENV_PATH, content);
}
