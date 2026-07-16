# SETUP — Schritt für Schritt

Alles, was nötig ist, damit das Tool läuft. Reihenfolge einhalten.

## 0. Voraussetzungen
- Node.js 20+ installiert
- Ein LinkedIn-Account

## 1. Installieren
```bash
npm install
npx playwright install chromium
cp .env.example .env
```

## 2. Gemini-Key (kostenlos)
- Auf https://aistudio.google.com einen API-Key erstellen (Free Tier).
- In `.env` bei `GEMINI_API_KEY=` eintragen.

## 3. LinkedIn Developer App (fürs Posting)
1. Auf https://developer.linkedin.com → **Create app**.
2. Die App mit einer LinkedIn-Company-Page verknüpfen (Pflicht; notfalls eine leere
   Placeholder-Page anlegen). App danach unter **Settings** verifizieren.
3. Unter **Products** aktivieren:
   - **Sign In with LinkedIn using OpenID Connect**
   - **Share on LinkedIn**
4. Unter **Auth**:
   - `Client ID` und `Client Secret` kopieren → in `.env` als
     `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET`.
   - Als **Authorized redirect URL** exakt eintragen: `http://localhost:5555/callback`

## 4. Tokens holen (automatisch)
```bash
npm run auth
```
Öffnet den Browser, du bestätigst den Zugriff. Danach stehen `LINKEDIN_ACCESS_TOKEN`,
`LINKEDIN_REFRESH_TOKEN` und `LINKEDIN_PERSON_URN` automatisch in `.env`.
(Token-Refresh passiert später von selbst, wenn er abläuft.)

Test:
```bash
npm run post -- "Erster Post über die API 🚀"
```

## 5. Browser-Session fürs Outreach (einmalig)
```bash
npm run login
```
Loggt dich manuell in LinkedIn ein (inkl. 2FA). Session bleibt in `./.session`.

## 6. Leads sammeln
```bash
npm run scrape -- "https://www.linkedin.com/search/results/people/?keywords=..."
```

## 7. Loslegen
```bash
npm run dev
```
Startet den Loop: fällige Posts raus (API) + Outreach-Tick (governor-gedrosselt) + Status.

---

## Sicherheits-Defaults (in `src/config.ts`)
Bewusst konservativ: ~18 Vernetzungen/Tag, ~90/Woche, 14-Tage-Warm-up, Arbeitszeit 9–19 Uhr,
Circuit-Breaker bei Akzeptanzrate < 30 %. Runter ist sicher, hoch ist dein Risiko.

## Reihenfolge der offenen Baustellen (siehe CLAUDE.md)
1. Phase 4 — Acceptance-Tracking (macht den Circuit-Breaker erst scharf)
2. DM-/Kommentar-Entwürfe
3. Telegram-Steuerung
4. Optional: n8n als Cockpit
