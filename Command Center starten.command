#!/bin/zsh
# Doppelklick = Ersteinrichtung (falls nötig) + Start + Dashboard im Browser öffnen.
# Kein Terminal-Tippen nötig. Beim allerersten Mal dauert es ein paar Minuten (Installation),
# danach startet es in Sekunden.
cd "$(dirname "$0")"

echo "── Command Center ──────────────────────────────"

# 1) Node vorhanden? Ohne Node läuft nichts – Laien freundlich hinweisen.
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js ist nicht installiert. Es wird einmalig gebraucht."
  osascript -e 'display dialog "Für Command Center muss einmalig Node.js installiert werden (kostenlos).\n\nKlick OK, dann öffnet sich die Download-Seite. Installiere Node.js (LTS) und starte danach diese App erneut per Doppelklick." buttons {"OK"} default button "OK" with title "Einrichtung"' >/dev/null 2>&1
  open "https://nodejs.org/de/download"
  exit 0
fi

# 2) Abhängigkeiten installiert? Beim ersten Start automatisch einrichten.
if [ ! -d node_modules ]; then
  echo "Erste Einrichtung läuft … das dauert einige Minuten, bitte Fenster offen lassen."
  npm install || { echo "Installation fehlgeschlagen."; read -r "?Enter zum Schließen…"; exit 1; }
  echo "Lade den Browser für die Automatisierung … (einmalig)"
  npx playwright install chromium
fi

# 3) .env vorhanden? (Der Setup-Assistent im Browser füllt sie – hier nur anlegen, falls leer.)
[ -f .env ] || cp .env.example .env 2>/dev/null

# 4) Dashboard starten, falls es nicht schon läuft.
if ! lsof -ti tcp:4321 >/dev/null 2>&1; then
  echo "Starte das Dashboard …"
  npm run crm >/tmp/command-center.log 2>&1 &
  # kurz warten, bis der Server hört
  for i in {1..20}; do
    lsof -ti tcp:4321 >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

echo "Öffne das Dashboard im Browser. Dieses Fenster kannst du schließen."
open "http://localhost:4321"
