import { readFileSync, writeFileSync, existsSync } from "node:fs";

const ENV_PATH = ".env";

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
  writeFileSync(ENV_PATH, content);
}
