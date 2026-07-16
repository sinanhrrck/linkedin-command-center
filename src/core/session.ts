import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { governor } from "./safetyGovernor.js";

let context: BrowserContext | null = null;

/**
 * Lebt der Kontext noch? Playwright wirft beim Zugriff auf einen toten Kontext erst
 * beim nächsten Befehl – deshalb hier vorher prüfen, statt den Fehler zu kassieren.
 */
function kontextLebt(ctx: BrowserContext): boolean {
  try {
    const b = ctx.browser();
    if (b && !b.isConnected()) return false; // Browser-Prozess ist weg
    ctx.pages(); // wirft, wenn der Kontext geschlossen wurde
    return true;
  } catch {
    return false;
  }
}

/**
 * STEALTH: gleicht die Spuren aus, die headless-Chrome sonst verraten. Live gemessen
 * (2026-07-16) waren die Lücken gegenüber echtem Chrome: `navigator.plugins` leer,
 * `navigator.mimeTypes` leer und `window.chrome` fehlt. Der UA wird separat über
 * `config.browser.userAgent` gesetzt, die Sprache über `locale`.
 * Läuft vor jedem Seitenskript, also bevor LinkedIns Fingerprinting greift.
 */
const STEALTH = `
(() => {
  // Echtes Chrome meldet 5 PDF-Plugins. Headless meldet 0 – ein eindeutiger Verräter.
  const mk = (name, desc, type, suffix) => ({ name, description: desc, filename: name, length: 1,
    0: { type, suffixes: suffix, description: desc } });
  const plugins = [
    mk("PDF Viewer", "Portable Document Format", "application/pdf", "pdf"),
    mk("Chrome PDF Viewer", "Portable Document Format", "application/pdf", "pdf"),
    mk("Chromium PDF Viewer", "Portable Document Format", "application/pdf", "pdf"),
    mk("Microsoft Edge PDF Viewer", "Portable Document Format", "application/pdf", "pdf"),
    mk("WebKit built-in PDF", "Portable Document Format", "application/pdf", "pdf"),
  ];
  Object.defineProperty(navigator, "plugins", { get: () => plugins });
  Object.defineProperty(navigator, "mimeTypes", { get: () => [
    { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" },
  ]});
  // window.chrome existiert in echtem Chrome, in headless nicht.
  if (!window.chrome) window.chrome = { runtime: {}, app: { isInstalled: false } };
})();
`;

/** Pfad der Live-Ansicht fürs Dashboard (Engine schreibt, CRM-Server liest). */
export const LIVE_SHOT_PATH = join(process.cwd(), ".live", "screen.jpg");

/**
 * Öffnet einen PERSISTENTEN Browser-Kontext mit deinen echten Cookies.
 * Beim ersten Mal (npm run login) loggst du dich manuell ein; die Session bleibt erhalten.
 *
 * headless bleibt AUS: der headless-UA enthält "HeadlessChrome" und verrät die Automation
 * an LinkedIn. Wir nehmen ein echtes Fenster (UA "Chrome/149.0.0.0") und verstecken es.
 *
 * @param opts.visible true = Fenster sichtbar lassen (nur fürs manuelle Login nötig).
 */
export async function getContext(opts: { visible?: boolean } = {}): Promise<BrowserContext> {
  // SELBSTHEILUNG: Stirbt der Browser (Absturz, pkill, Rechner-Schlaf), zeigte die Variable
  // trotzdem weiter auf ihn. getContext() gab dann die Leiche zurück und JEDER Versand
  // scheiterte mit "Target page, context or browser has been closed" – dauerhaft, bis der
  // Prozess neu startete. Real passiert 2026-07-16 beim Senden-Knopf im Dashboard.
  // Deshalb: tote Kontexte erkennen und neu starten statt ewig weiterreichen.
  if (context && !kontextLebt(context)) {
    console.warn("[session] Browser war weg – starte neu.");
    context = null;
  }
  if (context) return context;
  // "embedded" = headless: es existiert KEIN Fenster, also kann auch keins aufpoppen.
  // Die Seite siehst du stattdessen als Live-Ansicht im Dashboard (saveLiveShot).
  const headless = config.browser.mode === "embedded" && !opts.visible;
  context = await chromium.launchPersistentContext(config.paths.sessionDir, {
    headless,
    viewport: { width: 1280, height: 900 },
    userAgent: config.browser.userAgent, // niemals "HeadlessChrome" senden
    locale: config.browser.locale,
    timezoneId: config.browser.timezone,
    args: [
      "--disable-blink-features=AutomationControlled",
      // Ohne diese drei drosselt Chrome verdeckte Fenster und der Bot stockt.
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
    ],
  });
  await context.addInitScript(STEALTH);
  // Zweites Netz: Playwright meldet selbst, wenn der Kontext stirbt. Dann sofort die
  // Referenz löschen, damit der nächste getContext() sauber neu startet.
  context.on("close", () => {
    console.warn("[session] Browser-Kontext geschlossen – nächster Zugriff startet neu.");
    context = null;
  });
  return context;
}

export async function newPage(): Promise<Page> {
  const ctx = await getContext();
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return page;
}

/**
 * Schreibt einen Schnappschuss der aktuellen Seite für die Live-Ansicht im Dashboard.
 * Nötig, weil Engine und CRM-Server getrennte Prozesse sind: der Server kann nicht direkt
 * auf den Browser der Engine zugreifen, also geht der Umweg über eine Datei.
 *
 * WICHTIG (macOS, live getestet): Ein verstecktes Fenster liefert keine Frames mehr, dann
 * hängt jeder Screenshot bis in den Timeout – auch der CDP-Weg mit fromSurface:false.
 * Live-Ansicht und verstecktes Fenster schließen sich also gegenseitig aus. Bei hidden
 * steigen wir sofort aus, sonst blockiert der Loop jede Minute sinnlos.
 * Der Bot selbst arbeitet im Versteck normal weiter (rAF + Klicks getestet und OK).
 */
export async function saveLiveShot(): Promise<void> {
  if (!context) return;
  try {
    const page = context.pages()[0];
    if (!page) return;
    mkdirSync(join(process.cwd(), ".live"), { recursive: true });
    await page.screenshot({ path: LIVE_SHOT_PATH, type: "jpeg", quality: 55, timeout: 5000 });
  } catch {
    /* Live-Bild ist Komfort, nie kritisch */
  }
}

/**
 * Erkennt LinkedIn-Sicherheits-Checkpoints (Verifizierung, "ungewöhnliche Aktivität").
 * Findet er einen, zieht er sofort die globale Handbremse im Governor.
 * Nach jeder Navigation aufrufen.
 */
export async function guardAgainstCheckpoint(page: Page): Promise<boolean> {
  const url = page.url();
  // Primärsignal: die URL. LinkedIn-Sicherheitsseiten leiten hierhin um.
  let checkpointHit =
    url.includes("/checkpoint/") || url.includes("/authwall") || url.includes("/uas/login");

  // Backup: nur SICHTBARE Überschriften prüfen. NICHT die ganze Seite – LinkedIn
  // bettet riesige JSON-Payloads als Text ein, in denen "verify" o.ä. vorkommt.
  // Ein pauschales text=/verify/i matcht darauf und pausiert den Governor grundlos.
  if (!checkpointHit) {
    checkpointHit =
      (await page
        .locator("h1:visible, h2:visible")
        .filter({
          hasText:
            /verify your identity|verify it'?s you|unusual activity|security (check|verification)|sicherheits(überprüfung|check)|ungewöhnliche aktivität|identität (verifizieren|bestätigen)/i,
        })
        .count()) > 0;
  }

  if (checkpointHit) {
    governor.pause("LinkedIn-Checkpoint erkannt – manuelles Eingreifen nötig");
    return true;
  }
  return false;
}

export async function closeSession() {
  await context?.close();
  context = null;
}
