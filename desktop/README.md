# NextLead als Desktop-App (Electron)

Ziel: NextLead als echtes Programm (`.app` / `.exe`) statt ZIP-Ordner. Diese Hülle
(`main.cjs`) startet den lokalen Dashboard-Server und zeigt ihn in einem eigenen Fenster.

Der Weg hat **drei Stufen** – Stufe 1 läuft sofort, 2 und 3 sind der Verteil-Schritt.

## Stufe 1 — jetzt testen (Dev-Fenster)

Auf einem Rechner mit installierten Abhängigkeiten:

```bash
npm install
npm install --save-dev electron      # einmalig, ~250 MB (bewusst NICHT in den Standard-Deps)
npm run app
```

→ NextLead öffnet sich in einem eigenen Fenster (kein Browser-Tab). Der Setup-Assistent
läuft darin genauso wie im Browser.

## Stufe 2 — installierbares Paket bauen (.dmg / .exe)

Für eine Datei, die man weitergeben und doppelklicken kann:

1. `npm install --save-dev electron-builder`
2. In `package.json` einen `build`-Block ergänzen (appId, productName „NextLead", Ziel
   `dmg`/`nsis`, Icon) und ein `dist`-Script (`electron-builder`).
3. **Wichtig:** Der Server läuft heute über `tsx` (Dev-Werkzeug). Für ein Paket ohne
   Dev-Werkzeuge muss der TypeScript-Code vorher nach JavaScript kompiliert werden
   (`tsc` → `dist/`) und `main.cjs` startet dann die kompilierte Version statt `npm run crm`.
4. Playwrights Chromium (~150 MB) muss mitgebündelt werden (`extraResources`) **oder** die
   App lädt es beim ersten Start (`npx playwright install chromium`).
5. `npm run dist` → erzeugt das Paket in `dist/`.

Das ist ein richtiger Build und wird auf **deinem** Mac/PC gemacht (nicht in der Cloud).

## Stufe 3 — Signieren (damit Laien es ohne Warnung öffnen)

- **macOS:** Ohne Signatur + Notarisierung zeigt macOS „Entwickler nicht verifiziert"
  (Nutzer: Rechtsklick → Öffnen). Für die saubere Variante braucht es einen
  **Apple-Developer-Account (99 $/Jahr)**; electron-builder signiert + notarisiert dann.
- **Windows:** Ohne Signatur warnt SmartScreen („Trotzdem ausführen"). Ein Code-Signing-
  Zertifikat entfernt die Warnung, ist aber optional.

## Empfehlung

Erst Stufe 1 als eigenes Fenster nutzen und mit 1–2 echten Nutzern testen. Stufe 2/3
(paketieren + signieren) lohnt sich, sobald du es breiter verteilen willst — dann gehen
wir die gemeinsam auf deinem Rechner durch.
