#!/bin/zsh
# Doppelklick startet das Dashboard und öffnet es im Browser.
# Von dort aus steuerst du den Bot über den Start/Stop-Button – kein Terminal-Tippen nötig.
cd "$(dirname "$0")"

# Dashboard nur starten, wenn es nicht schon läuft.
if ! lsof -ti tcp:4321 >/dev/null 2>&1; then
  npm run crm >/tmp/command-center.log 2>&1 &
  sleep 2
fi

open "http://localhost:4321"
