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
    serverProc = spawn(process.execPath, [path.join(__dirname, "..", "dist", "scripts", "crmServer.js")], {
      cwd: dataDir,
      stdio: "inherit",
      // PLAYWRIGHT_BROWSERS_PATH=0 → Playwright sucht Chromium in node_modules (mitgebündelt),
      // nicht im System-Cache. So braucht der Nutzer keine separate Browser-Installation.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NEXTLEAD_PACKAGED: "1", NEXTLEAD_APP_DIR: path.join(__dirname, ".."), PLAYWRIGHT_BROWSERS_PATH: "0", DB_PATH: path.join(dataDir, "data.db"), SESSION_DIR: path.join(dataDir, ".session") },
    });
  } else {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    serverProc = spawn(npm, ["run", "crm"], { cwd: ROOT, stdio: "inherit", env: process.env });
  }
  serverProc.on("error", (e) => console.error("[app] Server-Start fehlgeschlagen:", e.message));
}

/** Warten, bis der Server auf Port 4321 antwortet, dann Callback. */
function waitForServer(cb, tries = 80) {
  http
    .get(DASHBOARD_URL, () => cb())
    .on("error", () => {
      if (tries <= 0) return cb();
      setTimeout(() => waitForServer(cb, tries - 1), 500);
    });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    title: "NextLead",
    backgroundColor: "#eef1f0",
    autoHideMenuBar: true,
  });
  win.loadURL(DASHBOARD_URL);
  // Externe Links (z.B. LinkedIn, aistudio) im echten Browser öffnen, nicht in der App.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(DASHBOARD_URL)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
}

// EINMAL-START: verhindert, dass die App zweimal läuft (sonst kollidieren beide um Port 4321
// → EADDRINUSE-Absturz). Ein zweiter Start bringt stattdessen das bestehende Fenster nach vorn.
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
    waitForServer(createWindow);
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
