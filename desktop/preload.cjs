// Brücke zwischen dem Electron-Hauptprozess und dem Dashboard (das über http://localhost
// geladen wird). contextIsolation bleibt an, nodeIntegration aus – wir geben dem Dashboard nur
// eine kleine, sichere API fürs Update-Feature frei (kein Node-Zugriff für die Seite selbst).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nextlead", {
  // Läuft die Seite in der echten App (nicht im Browser)? Dashboard blendet den Banner nur dann ein.
  isApp: true,
  version: () => ipcRenderer.invoke("app:version"),
  // Sofort nach Updates suchen (manueller Knopf).
  check: () => ipcRenderer.invoke("update:check"),
  // Update herunterladen + anwenden (Windows) bzw. .dmg öffnen (macOS).
  install: () => ipcRenderer.invoke("update:install"),
  // Status-Updates aus dem Hauptprozess empfangen (checking/available/downloading/…).
  onStatus: (cb) => ipcRenderer.on("update:status", (_e, s) => cb(s)),
});
