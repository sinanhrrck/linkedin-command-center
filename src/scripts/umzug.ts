/**
 * UMZUG MAC → SERVER (2026-09-21). Zwei Kommandos:
 *
 *   npm run umzug -- export [--nur-sitzung] [--trotzdem]     (am Mac)
 *   npm run umzug -- import <datei> [--ueberschreiben] [--ohne-pruefung]        (am Server)
 *
 * Bewusst EIGENSTÄNDIG (importiert weder config.ts noch session.ts): Beim Export am Mac liegen die
 * Daten im userData-Ordner der App, nicht im Repo; ein Import von db/index.ts würde eine leere
 * data.db im falschen Ordner anlegen. Alles hier arbeitet nur mit expliziten Pfaden.
 *
 * WARUM storageState UND NICHT DER PROFILORDNER: Playwright startet Chromium auf dem Mac mit
 * `--use-mock-keychain`, auf Linux mit `--password-store=basic`. Die Cookie-Datenbank ist damit je
 * Plattform anders verschlüsselt – kopierte Profil-Dateien ergäben auf dem Server eine leere
 * Anmeldung. Cookies als Klartext-JSON (Playwright storageState) sind plattformneutral, wenige KB
 * und beliebig oft wiederholbar (Sitzung abgelaufen → neu exportieren → neu importieren).
 */
import { chromium } from "playwright";
import Database from "better-sqlite3";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, hostname, tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const SITZUNG_DATEI = "nextlead-sitzung.json";
const INFO_DATEI = "umzug-info.json";
// Diese Zeilen aus der Mac-.env zeigen auf Mac-Pfade und dürfen im Container NICHT gelten.
const ENV_ZEILEN_ENTFERNEN = /^(SESSION_DIR|DB_PATH|UPLOAD_DIR|PROFIL_PATH|LIVE_DIR|ENGINE_LOG|ENV_PATH|DATA_DIR|BROWSER_MODE|HOST|PORT|CRM_PORT)=/;

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (f: string) => argv.includes(f);
const stempel = () => new Date().toISOString().replace(/[-:]/g, "").slice(0, 13).replace("T", "-");

function fehler(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

/** Quellordner am Mac: SESSION_DIR/DB_PATH aus der Umgebung, sonst der userData-Ordner der App, sonst cwd. */
function quelleErmitteln(): { dir: string; session: string; db: string } {
  const appDir = process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "linkedin-command-center")
    : join(homedir(), ".config", "linkedin-command-center");
  const dir = process.env.NEXTLEAD_QUELLE ? resolve(process.env.NEXTLEAD_QUELLE) : existsSync(join(appDir, ".session")) ? appDir : process.cwd();
  return {
    dir,
    session: process.env.SESSION_DIR ? resolve(process.env.SESSION_DIR) : join(dir, ".session"),
    db: process.env.DB_PATH ? resolve(process.env.DB_PATH) : join(dir, "data.db"),
  };
}

function laeuftNextLead(): string[] {
  try {
    const out = execFileSync("pgrep", ["-fl", "NextLead.app|dist/index.js|dist/scripts/crmServer.js|tsx src/index.ts|tsx src/scripts/crmServer.ts"], { encoding: "utf8" });
    // Eigene Aufrufe und Shell-Wrapper (deren Befehlstext das Muster nur ZITIERT) ausblenden.
    return out.split("\n").filter((l) => l.trim() && !l.includes("umzug.ts") && !/\b(zsh|bash|sh) -c\b|\bp?grep\b/.test(l));
  } catch {
    return []; // pgrep: exit 1 = nichts gefunden
  }
}

/** Cookies + localStorage der LinkedIn-Sitzung als JSON. Öffnet den Profilordner headless, ohne Seite. */
async function sitzungExportieren(sessionDir: string): Promise<{ cookies: unknown[]; origins: unknown[] }> {
  if (!existsSync(sessionDir)) fehler(`Sitzungsordner fehlt: ${sessionDir}`);
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) rmSync(join(sessionDir, f), { force: true });
  const ctx = await chromium.launchPersistentContext(sessionDir, { headless: true, userAgent: UA, locale: "de-DE", timezoneId: "Europe/Berlin" });
  try {
    const state = await ctx.storageState();
    const cookies = state.cookies.filter((c) => /linkedin\.com$/i.test(c.domain));
    const origins = state.origins.filter((o) => /linkedin\.com/i.test(o.origin));
    if (!cookies.some((c) => c.name === "li_at")) fehler("Im Profil ist keine gültige LinkedIn-Anmeldung (Cookie li_at fehlt). Erst in der Mac-App bei LinkedIn einloggen.");
    return { cookies, origins };
  } finally {
    await ctx.close();
  }
}

async function exportieren(): Promise<void> {
  const nurSitzung = flag("--nur-sitzung");
  const q = quelleErmitteln();
  console.info(`Quelle: ${q.dir}\n  Sitzung: ${q.session}\n  Datenbank: ${q.db}`);
  const laufend = laeuftNextLead();
  if (laufend.length) {
    console.warn("\n⚠ NextLead läuft noch:\n  " + laufend.join("\n  "));
    if (!flag("--trotzdem")) fehler("Bitte die Mac-App (und eine evtl. laufende Engine) ZUERST beenden – sonst ist der Export unvollständig. Mit --trotzdem erzwingen.");
  }

  const sitzung = await sitzungExportieren(q.session);
  const info = { exportedAt: new Date().toISOString(), host: hostname(), quelle: q.dir, nurSitzung, dbMtime: existsSync(q.db) ? statSync(q.db).mtime.toISOString() : null, cookies: sitzung.cookies.length };

  if (nurSitzung) {
    const ziel = resolve(`nextlead-sitzung-${stempel()}.json`);
    writeFileSync(ziel, JSON.stringify({ ...sitzung, info }, null, 1));
    console.info(`\n✓ Sitzung exportiert (${sitzung.cookies.length} Cookies) → ${ziel}`);
    console.info("  Auf den Server kopieren und dort:  npm run umzug -- import <datei>   (bzw. docker compose run, siehe MIGRATION.md)");
    return;
  }

  if (!existsSync(q.db)) fehler(`Datenbank nicht gefunden: ${q.db}`);
  const tmp = mkdtempSync(join(tmpdir(), "nextlead-umzug-"));
  try {
    // Konsistente DB-Kopie über die SQLite-Backup-API (auch bei WAL-Modus vollständig).
    const src = new Database(q.db, { readonly: true });
    await src.backup(join(tmp, "data.db"));
    src.close();
    writeFileSync(join(tmp, SITZUNG_DATEI), JSON.stringify(sitzung, null, 1));
    writeFileSync(join(tmp, INFO_DATEI), JSON.stringify(info, null, 2));
    for (const name of [".env", "profil.local.json"]) if (existsSync(join(q.dir, name))) cpSync(join(q.dir, name), join(tmp, name));
    if (existsSync(join(q.dir, ".uploads"))) cpSync(join(q.dir, ".uploads"), join(tmp, ".uploads"), { recursive: true });
    const ziel = resolve(`nextlead-umzug-${stempel()}.tar.gz`);
    execFileSync("tar", ["-czf", ziel, "-C", tmp, "."]);
    const mb = (statSync(ziel).size / 1_048_576).toFixed(1);
    console.info(`\n✓ Umzugspaket erstellt (${mb} MB): ${ziel}`);
    console.info(`  Inhalt: data.db, ${SITZUNG_DATEI} (${sitzung.cookies.length} Cookies), .env, profil.local.json, .uploads, ${INFO_DATEI}`);
    console.info("  ACHTUNG: Das Paket enthält API-Keys und deine LinkedIn-Anmeldung. Nie ins Git, nach dem Umzug löschen.");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Mac-Pfadzeilen entfernen; alles andere (Keys, Telegram) bleibt. */
function envBereinigen(text: string): { text: string; entfernt: string[] } {
  const entfernt: string[] = [];
  const zeilen = text.split("\n").filter((z) => {
    if (ENV_ZEILEN_ENTFERNEN.test(z)) { entfernt.push(z.split("=")[0]); return false; }
    return true;
  });
  return { text: zeilen.join("\n"), entfernt };
}

async function sitzungImportieren(sessionDir: string, sitzung: { cookies: Parameters<import("playwright").BrowserContext["addCookies"]>[0] }): Promise<void> {
  mkdirSync(sessionDir, { recursive: true });
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) rmSync(join(sessionDir, f), { force: true });
  const ctx = await chromium.launchPersistentContext(sessionDir, {
    headless: true, userAgent: UA, locale: "de-DE", timezoneId: "Europe/Berlin",
    args: ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
  });
  try {
    await ctx.clearCookies();
    await ctx.addCookies(sitzung.cookies);
    console.info(`✓ ${sitzung.cookies.length} Cookies in ${sessionDir} eingespielt.`);
    if (flag("--ohne-pruefung")) return; // z.B. für Tests: kein Aufruf bei LinkedIn
    // Prüfung: EIN Aufruf des Feeds. Landet er auf Login/Checkpoint, ist die Sitzung nicht brauchbar.
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 45_000 });
    const url = page.url();
    if (/\/login|\/checkpoint|\/authwall|\/uas\//i.test(url)) {
      console.warn(`\n⚠ Sitzung importiert, aber LinkedIn zeigt: ${url}`);
      console.warn("  → Sitzung ist abgelaufen oder LinkedIn verlangt eine Bestätigung (Checkpoint). Am Mac in der App neu einloggen, dann erneut exportieren.");
    } else {
      console.info(`✓ Sitzung gültig – eingeloggt (${url}).`);
    }
  } finally {
    await ctx.close();
  }
}

async function importieren(): Promise<void> {
  const datei = argv[1] ? resolve(argv[1]) : fehler("Aufruf: npm run umzug -- import <nextlead-umzug-….tar.gz | nextlead-sitzung-….json>");
  if (!existsSync(datei)) fehler(`Datei nicht gefunden: ${datei}`);
  const dataDir = resolve(process.env.DATA_DIR ?? "./data");
  const sessionDir = process.env.SESSION_DIR ? resolve(process.env.SESSION_DIR) : join(dataDir, ".session");
  mkdirSync(dataDir, { recursive: true });
  console.info(`Datenordner: ${dataDir}`);
  const laufend = laeuftNextLead();
  if (laufend.length && !flag("--trotzdem")) fehler("NextLead läuft auf diesem Rechner noch (docker compose down / Prozess beenden), dann importieren:\n  " + laufend.join("\n  "));

  if (datei.endsWith(".json")) {
    const roh = JSON.parse(readFileSync(datei, "utf8"));
    await sitzungImportieren(sessionDir, roh);
    if (roh.info) writeFileSync(join(dataDir, INFO_DATEI), JSON.stringify(roh.info, null, 2));
    console.info("✓ Fertig. Container/Engine wieder starten; die Pause im Dashboard aufheben.");
    return;
  }

  const tmp = mkdtempSync(join(tmpdir(), "nextlead-import-"));
  try {
    execFileSync("tar", ["-xzf", datei, "-C", tmp]);
    const ueberschreiben = flag("--ueberschreiben");
    const kopieren = (name: string, ziel = name) => {
      const von = join(tmp, name);
      if (!existsSync(von)) return;
      const nach = join(dataDir, ziel);
      if (existsSync(nach) && !ueberschreiben) {
        console.warn(`  – ${ziel} existiert bereits, wird NICHT ersetzt (mit --ueberschreiben erzwingen).`);
        return;
      }
      cpSync(von, nach, { recursive: true });
      console.info(`  ✓ ${ziel}`);
    };
    console.info("Dateien einspielen:");
    kopieren("data.db");
    kopieren("profil.local.json");
    kopieren(".uploads");
    kopieren(INFO_DATEI);
    // .env: Mac-Pfade rausfiltern, DASHBOARD_TOKEN bleibt Sache des Nutzers (MIGRATION.md).
    const envQuelle = join(tmp, ".env");
    const envZiel = join(dataDir, ".env");
    if (existsSync(envQuelle) && (!existsSync(envZiel) || ueberschreiben)) {
      const { text, entfernt } = envBereinigen(readFileSync(envQuelle, "utf8"));
      writeFileSync(envZiel, text);
      console.info(`  ✓ .env${entfernt.length ? ` (Mac-Pfade entfernt: ${entfernt.join(", ")})` : ""}`);
    } else if (existsSync(envZiel)) {
      console.warn("  – .env existiert bereits, wird NICHT ersetzt.");
    }
    const sitzungPfad = join(tmp, SITZUNG_DATEI);
    if (existsSync(sitzungPfad)) await sitzungImportieren(sessionDir, JSON.parse(readFileSync(sitzungPfad, "utf8")));
    if (!/^DASHBOARD_TOKEN=.{12,}/m.test(existsSync(envZiel) ? readFileSync(envZiel, "utf8") : "")) {
      console.warn(`\n⚠ In ${envZiel} fehlt noch DASHBOARD_TOKEN. Ohne Token startet der Server-Modus nicht.\n  Erzeugen:  openssl rand -hex 24   → als Zeile DASHBOARD_TOKEN=<wert> eintragen.`);
    }
    console.info(`\n✓ Import abgeschlossen. Inhalt von ${dataDir}: ${readdirSync(dataDir).join(", ")}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (cmd === "export") exportieren().catch((e) => fehler(String(e?.message ?? e)));
else if (cmd === "import") importieren().catch((e) => fehler(String(e?.message ?? e)));
else fehler("Aufruf:\n  npm run umzug -- export [--nur-sitzung] [--trotzdem]\n  npm run umzug -- import <datei> [--ueberschreiben] [--ohne-pruefung]");
