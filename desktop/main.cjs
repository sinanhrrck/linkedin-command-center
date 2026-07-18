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

/** Dashboard-Server starten (Dev: npm run crm). */
function startServer() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  serverProc = spawn(npm, ["run", "crm"], { cwd: ROOT, stdio: "inherit", env: process.env });
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

app.whenReady().then(() => {
  startServer();
  waitForServer(createWindow);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Server sauber beenden, wenn die App schließt.
function stopServer() {
  if (serverProc) {
    try { serverProc.kill(); } catch { /* egal */ }
    serverProc = null;
  }
}
app.on("window-all-closed", () => { stopServer(); app.quit(); });
app.on("before-quit", stopServer);
