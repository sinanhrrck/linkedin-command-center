# Auto-Start & Dauerbetrieb (macOS)

## Warum das der groesste Hebel ist
Der Bot schoepft sein Tageslimit voll aus, WENN er laeuft. Er war nur meistens aus:
15.07. = 10 Anfragen dann 21h Luecke, 16.07. = 11, 17.07. = 12 (je ~2h Laufzeit).
Von 100 moeglichen Anfragen/Woche wurden 33 genutzt. Nicht das Tempo fehlt, die Laufzeit.

## Der Engine-LaunchAgent (startet den Bot beim Login)

**FALLE (live gemessen 2026-07-17): Das Startskript darf NICHT in ~/Downloads liegen.**
macOS schuetzt Downloads/Desktop/Documents per TCC. launchd darf von dort nichts ausfuehren
und der Job stirbt mit `Exit 78: EX_CONFIG` – ohne jede Fehlermeldung, still.
Deshalb liegt das Skript in `~/.commandcenter/engine-start.sh` (ungeschuetzt). Das PROJEKT
selbst darf in ~/Downloads bleiben: nur das Ausfuehren von dort ist blockiert, der laufende
Prozess kommt an DB und Session heran.

Installieren:
```bash
mkdir -p ~/.commandcenter
cp deploy/engine-start.sh ~/.commandcenter/
chmod +x ~/.commandcenter/engine-start.sh
cp deploy/com.sinan.commandcenter.engine.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.sinan.commandcenter.engine.plist
```

Pruefen:
```bash
launchctl print gui/$(id -u)/com.sinan.commandcenter.engine | grep -E "state|pid|last exit"
# state = running  + pid = ... -> laeuft
# last exit code = 78: EX_CONFIG -> TCC blockt (Skript liegt in einem geschuetzten Ordner)
tail -f ~/.commandcenter/launchagent.log
```

Abschalten:
```bash
launchctl unload ~/Library/LaunchAgents/com.sinan.commandcenter.engine.plist
```

## Bewusst KEIN KeepAlive
launchd wuerde den Prozess nach jedem Kill sofort neu starten – der Stop-Knopf im Dashboard
(`pkill`) waere damit kaputt. Sinan nutzt den Knopf. Abstuerze faengt stattdessen die
Selbstheilung in `core/session.ts` ab (toter Browser -> neu starten).

## Sleep-Schutz
`caffeinate -i` (im Startskript) haelt den Mac wach, solange der Loop laeuft. Bei
ZUGEKLAPPTEM Deckel schlaeft er trotzdem – ausser am Strom mit externem Monitor.
Nicht schlimm: die Arbeitszeit ist ohnehin auf 9-19 Uhr begrenzt.

## Dashboard-Autostart (optional)
`com.sinan.commandcenter.dashboard.plist` startet nur das Cockpit (localhost:4321),
nicht den Bot. Gleiche TCC-Falle beachten.
