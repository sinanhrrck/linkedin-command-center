// NextLead als Desktop-App (Electron-Hülle).
// Startet den lokalen Dashboard-Server und zeigt ihn in einem eigenen App-Fenster –
// so fühlt es sich wie ein normales Programm an, kein Terminal, kein Browser-Tab.
//
// DEV: `npm run app` (nutzt den tsx-Server über npm).
// PAKET: siehe desktop/README.md – für die verteilbare .app/.exe wird der Server vorher
// nach JavaScript kompiliert und hier statt "npm run crm" die kompilierte Version gestartet.
const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DASHBOARD_URL = "http://localhost:4321";
let serverProc = null;

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
  });
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
