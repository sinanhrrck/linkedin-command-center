# NextLead als Desktop-App

NextLead als echtes Programm (`.app` / `.exe`), das man herunterlädt und öffnet — kein
ZIP-Ordner, kein Terminal. `main.cjs` ist die Electron-Hülle: sie startet den Dashboard-
Server und zeigt ihn in einem eigenen Fenster.

## So entstehen die Download-Dateien (automatisch über GitHub)

Niemand muss die App von Hand bauen. **GitHub baut sie kostenlos** und legt sie zum Download
bereit (`.github/workflows/release.yml`):

1. Einen Versions-Tag pushen, z.B.:
   ```
   git tag v0.1.0 && git push origin v0.1.0
   ```
   (Oder auf GitHub unter **Actions → „NextLead App bauen" → Run workflow**.)
2. GitHub baut auf echten Mac- und Windows-Rechnern die Installer und hängt sie an ein
   **Release**. Die Landing-Page („Download") verlinkt automatisch auf das neueste Release.

Der Build kompiliert vorher TypeScript → JavaScript (`npm run build:app`) und bündelt
Chromium mit (`PLAYWRIGHT_BROWSERS_PATH=0`), damit die App ohne Zusatz-Installation läuft.

## Lokal testen (eigenes Fenster, Dev)

```
npm install
npm install --save-dev electron
npm run app
```

## Bekannter Stand / was noch iteriert wird

- **Verifiziert:** Der Server läuft kompiliert ohne `tsx` (Dashboard + API), Dev-Betrieb
  unverändert. Die Prozess-Starts (Engine/Login) sind für den paketierten Modus umgestellt
  (Electrons Node statt tsx). Nutzerdaten (.env, profil.local.json, data.db, .session) landen
  im beschreibbaren `userData`-Ordner.
- **Wird beim ersten CI-Build geprüft:** native SQLite-Neukompilierung für Electron
  (electron-builder macht das automatisch) und das Chromium-Bündeln. Falls dort etwas hakt,
  steht die Ursache im Actions-Log — das ist unsere Debug-Fläche, ohne dass jemand lokal bauen muss.

## Signieren (später, optional)

Unsigniert zeigt das System beim ersten Öffnen eine Warnung (Mac: Rechtsklick → Öffnen;
Windows: „Trotzdem ausführen"). Für die warnungsfreie Variante: macOS braucht einen
Apple-Developer-Account (99 $/Jahr), dann signiert electron-builder automatisch.
