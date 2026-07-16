# Auto-Start & Dauerbetrieb (macOS)

Damit das Dashboard beim Login automatisch startet und der Bot nicht durch Ruhezustand stirbt.

## Sleep-Schutz (schon eingebaut)
Der Loop wird beim „Bot starten" automatisch mit `caffeinate -i` gestartet – der Mac schläft
nicht ein, solange der Bot läuft. Beim Stoppen schläft er wieder normal.
Hinweis: `caffeinate -i` verhindert **Idle-Sleep**. Bei **zugeklapptem Deckel** schläft der Mac
trotzdem, außer er hängt am Strom + externem Monitor (Clamshell) oder du stellst in
Systemeinstellungen → Batterie den Ruhezustand entsprechend.

## Auto-Start des Dashboards beim Login (optional, du installierst es selbst)

Installieren:
```bash
cp deploy/com.sinan.commandcenter.dashboard.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.sinan.commandcenter.dashboard.plist
```
Danach läuft das Dashboard nach jedem Login automatisch auf http://localhost:4321.
Den Bot/Outreach startest du weiterhin bewusst per „Bot starten"-Button.

Wieder entfernen:
```bash
launchctl unload ~/Library/LaunchAgents/com.sinan.commandcenter.dashboard.plist
rm ~/Library/LaunchAgents/com.sinan.commandcenter.dashboard.plist
```

Prüfen, ob es läuft:
```bash
launchctl list | grep commandcenter
```
