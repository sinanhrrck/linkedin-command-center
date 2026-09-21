# NextLead im Server-Modus (Heimserver, kein Bildschirm). Siehe MIGRATION.md.
#
# Basis = offizielles Playwright-Image, EXAKT die Version aus package.json (playwright 1.61.1):
# es bringt Chromium + alle Systembibliotheken + Node 24 mit. Bei einem Playwright-Update in
# package.json MUSS dieser Tag mitziehen, sonst fehlt der passende Browser.
FROM mcr.microsoft.com/playwright:v1.61.1-noble

ENV NODE_ENV=production \
    TZ=Europe/Berlin \
    NEXTLEAD_SERVER=1 \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=4321 \
    # Browser liegt im Image bereits unter /ms-playwright – nichts nachladen.
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# better-sqlite3 hat für Node 24/Linux kein fertiges Binärpaket und wird bei `npm ci` kompiliert.
# Dafür braucht es python3, make, g++ (live gescheitert 2026-09-22: "gyp ERR! not ok").
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Erst nur die Abhängigkeiten (Docker-Cache: ändert sich der Code, muss npm nicht neu laufen).
# devDependencies bleiben drin, weil `tsx` den TypeScript-Code direkt ausführt (wie `npm run crm`).
# Electron wird bewusst NICHT gebraucht → Download unterbinden, spart ~100 MB und Zeit.
COPY package.json package-lock.json ./
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund \
 && npm cache clean --force

# Nur der Anwendungscode. Datenbank, Sitzung und .env kommen NIE ins Image (siehe .dockerignore),
# sie liegen ausschließlich im Volume /data.
COPY tsconfig.json profil.example.json ./
COPY src ./src

# Datenordner als Volume; Inhalt kommt vom Host (./data).
VOLUME ["/data"]
EXPOSE 4321

# Lebt das Dashboard? (Basic-Auth antwortet 401 = Server steht.)
HEALTHCHECK --interval=60s --timeout=5s --start-period=40s --retries=3 \
  CMD sh -c 'code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4321/api/state); [ "$code" = 200 ] || [ "$code" = 401 ]'

# Dashboard-Server startet im Server-Modus die Engine selbst (Autostart + Watchdog).
CMD ["npm", "run", "server"]
