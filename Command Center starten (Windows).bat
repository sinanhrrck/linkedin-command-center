@echo off
REM Doppelklick = Ersteinrichtung (falls noetig) + Start + Dashboard im Browser oeffnen.
REM Beim allerersten Mal dauert es ein paar Minuten (Installation), danach Sekunden.
cd /d "%~dp0"
echo -- Command Center --------------------------------

REM 1) Node vorhanden?
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js ist nicht installiert. Es wird einmalig gebraucht.
  echo Die Download-Seite oeffnet sich jetzt. Installiere Node.js ^(LTS^) und starte danach diese App erneut.
  start "" https://nodejs.org/de/download
  pause
  exit /b
)

REM 2) Abhaengigkeiten installiert?
if not exist node_modules (
  echo Erste Einrichtung laeuft ... das dauert einige Minuten, bitte Fenster offen lassen.
  call npm install || (echo Installation fehlgeschlagen. & pause & exit /b)
  echo Lade den Browser fuer die Automatisierung ... (einmalig)
  call npx playwright install chromium
)

REM 3) .env anlegen, falls noetig (der Setup-Assistent fuellt sie im Browser).
if not exist .env copy .env.example .env >nul 2>nul

REM 4) Dashboard starten und oeffnen.
echo Starte das Dashboard ...
start "" cmd /c "npm run crm > %TEMP%\command-center.log 2>&1"
timeout /t 4 >nul
start "" http://localhost:4321
echo Dashboard geoeffnet. Dieses Fenster kannst du schliessen.
