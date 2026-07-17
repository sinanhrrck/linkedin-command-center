#!/bin/zsh
# Startskript fuer den LaunchAgent. Bewusst ein Skript statt einer plist-Einzeiler-Zeile:
# launchd startet mit minimalem PATH (/usr/bin:/bin:/usr/sbin:/sbin) und ohne Login-Profil,
# da scheitern Einzeiler still (Exit 78). Hier ist alles explizit und im Log nachvollziehbar.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd /Users/sinanharrack/Downloads/linkedin-command-center || exit 1

echo "[launchagent] $(date '+%F %T') Start – node: $(command -v node), npx: $(command -v npx)"

# caffeinate -i: Mac schlaeft nicht ein, solange der Bot laeuft.
exec /usr/bin/caffeinate -i /usr/local/bin/npx tsx src/index.ts
