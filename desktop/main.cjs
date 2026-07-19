// NextLead als Desktop-App (Electron-Hülle).
// Startet den lokalen Dashboard-Server und zeigt ihn in einem eigenen App-Fenster –
// so fühlt es sich wie ein normales Programm an, kein Terminal, kein Browser-Tab.
//
// DEV: `npm run app` (nutzt den tsx-Server über npm).
// PAKET: siehe desktop/README.md – für die verteilbare .app/.exe wird der Server vorher
// nach JavaScript kompiliert und hier statt "npm run crm" die kompilierte Version gestartet.
const { app, BrowserWindow, shell, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DASHBOARD_URL = "http://localhost:4321";
const UPDATE_REPO = "sinanhrrck/linkedin-command-center"; // GitHub-Repo mit den Releases
let serverProc = null;
let mainWin = null;
let latestUpdate = null; // gemerktes Ziel: { version, url, name }

// ===== In-App-Update =====
// Bewusst OHNE electron-updater/Squirrel: das braucht auf macOS ein bezahltes Apple-Zertifikat.
// Stattdessen fragen wir die GitHub-Releases direkt ab und installieren per Knopf:
//  - Windows: neuen Installer laden + starten (schliesst die App, installiert drüber) → Ein-Klick.
//  - macOS: neues .dmg laden + öffnen (Nutzer zieht es einmal in "Programme"). Kein Zertifikat nötig.

function sendUpdate(status) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("update:status", status);
}

/** Version a > b ? (numerischer Semver-Vergleich, z.B. "0.1.10" > "0.1.9"). */
function istNeuer(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** GitHub-API abfragen (folgt keinen Redirects – die API antwortet direkt mit JSON). */
function ghJson(pfad) {
  return new Promise((res, rej) => {
    https.get({ host: "api.github.com", path: pfad, headers: { "User-Agent": "NextLead", Accept: "application/vnd.github+json" } }, (r) => {
      let d = ""; r.on("data", (c) => (d += c));
      r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on("error", rej);
  });
}

/** Datei laden und dabei GitHub→S3-Redirects (302) selbst auflösen. */
function lade(url, ziel, onFortschritt) {
  return new Promise((res, rej) => {
    const f = fs.createWriteStream(ziel);
    const hol = (u) => {
      https.get(u, { headers: { "User-Agent": "NextLead" } }, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return hol(r.headers.location); }
        if (r.statusCode !== 200) { rej(new Error("HTTP " + r.statusCode)); return; }
        const total = Number(r.headers["content-length"] || 0);
        let got = 0;
        r.on("data", (c) => { got += c.length; if (total && onFortschritt) onFortschritt(got / total); });
        r.pipe(f);
        f.on("finish", () => f.close(() => res(ziel)));
      }).on("error", rej);
    };
    hol(url);
  });
}

/** Prüft, ob eine neuere Version veröffentlicht ist, und merkt sich das passende Installations-Asset. */
async function suchNachUpdate(manuell) {
  if (!app.isPackaged) { if (manuell) sendUpdate({ state: "dev" }); return; } // im Dev-Modus kein Update
  try {
    sendUpdate({ state: "checking" });
    const rel = await ghJson(`/repos/${UPDATE_REPO}/releases/latest`);
    const tag = String(rel.tag_name || "").replace(/^v/, "");
    const aktuell = app.getVersion();
    if (!tag || !istNeuer(tag, aktuell)) { sendUpdate({ state: "none", current: aktuell }); return; }
    const endung = process.platform === "darwin" ? ".dmg" : ".exe";
    const asset = (rel.assets || []).find((a) => a.name.toLowerCase().endsWith(endung));
    if (!asset) { sendUpdate({ state: "none", current: aktuell }); return; } // Release ohne passendes Paket
    latestUpdate = { version: tag, url: asset.browser_download_url, name: asset.name };
    const notes = String(rel.body || "").split("\n").slice(0, 6).join("\n").slice(0, 500);
    sendUpdate({ state: "available", version: tag, current: aktuell, notes });
  } catch (e) {
    sendUpdate({ state: "error", message: e.message });
  }
}

ipcMain.handle("app:version", () => app.getVersion());
ipcMain.handle("update:check", () => suchNachUpdate(true));
ipcMain.handle("update:install", async () => {
  if (!latestUpdate) return { ok: false };
  try {
    const ziel = path.join(app.getPath("temp"), latestUpdate.name);
    sendUpdate({ state: "downloading", percent: 0 });
    await lade(latestUpdate.url, ziel, (p) => sendUpdate({ state: "downloading", percent: Math.round(p * 100) }));
    if (process.platform === "win32") {
      // NSIS-Installer starten – er schliesst die laufende App und installiert die neue Version drüber.
      sendUpdate({ state: "installing" });
      spawn(ziel, [], { detached: true, stdio: "ignore" }).unref();
      setTimeout(() => app.quit(), 800);
    } else {
      // macOS: .dmg öffnen; Nutzer zieht NextLead in "Programme" (überschreibt die alte Version).
      sendUpdate({ state: "downloaded-mac" });
      shell.openPath(ziel);
    }
    return { ok: true };
  } catch (e) {
    sendUpdate({ state: "error", message: e.message });
    return { ok: false, error: e.message };
  }
});

/**
 * Dashboard-Server starten.
 *  - DEV (nicht paketiert): über `npm run crm` (tsx).
 *  - PAKETIERT: den KOMPILIERTEN Server (dist/scripts/crmServer.js) über Electrons eingebautes
 *    Node (ELECTRON_RUN_AS_NODE). Arbeitsverzeichnis = beschreibbarer Nutzer-Ordner
 *    (userData) → dort landen .env, profil.local.json, data.db, .session. NEXTLEAD_APP_DIR
 *    zeigt auf den (schreibgeschützten) App-Code, damit der Server Engine/Login-Skripte findet.
 */
function startServer() {
  if (app.isPackaged) {
    const dataDir = app.getPath("userData");
    // Chromium liegt ENTPACKT in app.asar.unpacked (asarUnpack). Playwright würde ihn sonst im
    // gepackten app.asar suchen und beim Start scheitern (spawn ENOTDIR), weil die Engine als
    // reines Node läuft (keine Electron-asar-Umleitung beim Spawnen von Binaries). Deshalb hier
    // den ENTPACKTEN Browser-Ordner explizit vorgeben.
    const browsersPath = path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "playwright-core", ".local-browsers");
    serverProc = spawn(process.execPath, [path.join(__dirname, "..", "dist", "scripts", "crmServer.js")], {
      cwd: dataDir,
      stdio: "inherit",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NEXTLEAD_PACKAGED: "1", NEXTLEAD_APP_DIR: path.join(__dirname, ".."), PLAYWRIGHT_BROWSERS_PATH: browsersPath, DB_PATH: path.join(dataDir, "data.db"), SESSION_DIR: path.join(dataDir, ".session") },
    });
  } else {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    serverProc = spawn(npm, ["run", "crm"], { cwd: ROOT, stdio: "inherit", env: process.env });
  }
  serverProc.on("error", (e) => console.error("[app] Server-Start fehlgeschlagen:", e.message));
}

/**
 * Fenster SOFORT öffnen und die Seite so lange neu laden, bis der Server bereit ist.
 * Robuster als vorher: das Fenster hängt nicht mehr an einem http.get im Hauptprozess (der
 * schlug im gepackten Zustand fehl → Fenster kam nie). Erst kurze Warteseite, dann Dashboard.
 */
function createWindow() {
  const win = new BrowserWindow({
    width: 1320, height: 880, minWidth: 980, minHeight: 640,
    title: "NextLead", backgroundColor: "#eef1f0", autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  mainWin = win;
  // Externe Links (LinkedIn, aistudio) im echten Browser öffnen, nicht in der App.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(DASHBOARD_URL)) { shell.openExternal(url); return { action: "deny" }; }
    return { action: "allow" };
  });
  // Ladeversuch mit Wiederholung, bis der Server antwortet.
  let versuche = 0;
  const laden = () => win.loadURL(DASHBOARD_URL).catch(() => {});
  win.webContents.on("did-fail-load", () => {
    if (++versuche <= 120) setTimeout(laden, 500); // bis zu 60s auf den Server warten
  });
  laden();
  return win;
}

// EINMAL-START: verhindert Doppelstart (Port-4321-Kollision). Zweiter Start holt das
// bestehende Fenster nach vorn. requestSingleInstanceLock ist self-healing (tote Locks zählen nicht).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length) { if (wins[0].isMinimized()) wins[0].restore(); wins[0].focus(); }
  });
  app.whenReady().then(() => {
    startServer();
    createWindow(); // Fenster sofort – lädt das Dashboard, sobald der Server steht.
    // Update-Check: einmal kurz nach Start (Server + Fenster stehen lassen) und danach alle 6 Stunden.
    setTimeout(() => suchNachUpdate(false), 8000);
    setInterval(() => suchNachUpdate(false), 6 * 60 * 60 * 1000);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// Server sauber beenden, wenn die App schließt.
function stopServer() {
  if (serverProc) {
    try { serverProc.kill(); } catch { /* egal */ }
    serverProc = null;
  }
}
app.on("window-all-closed", () => { stopServer(); app.quit(); });
app.on("before-quit", stopServer);
