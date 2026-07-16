# LinkedIn Command Center

Lokales All-in-One-Tool für dein LinkedIn: Posting (offizielle API), Cold Outreach,
Inbox-Drafts, CRM und Analytics — alles auf deinem Rechner, mit deiner echten Session.

## Prinzip

Jede **sendende** Aktion (Vernetzen, Nachricht, Kommentar) läuft zwingend durch den
`SafetyGovernor`. Kein Direktaufruf. Der Governor drosselt, jittert, rampt hoch und
zieht bei Gefahr (Verifizierungs-Checkpoint, niedrige Akzeptanzrate) die Handbremse.

Das Posting läuft komplett getrennt über die **offizielle LinkedIn-API** (ToS-konform,
kein Ban-Risiko) und braucht den Governor nicht.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env      # Werte eintragen (Gemini-Key, LinkedIn-App-Credentials, ...)
npm run login             # einmalig: Browser öffnet sich, du loggst dich manuell in LinkedIn ein
npm run dev               # startet Scheduler + Telegram-Steuerung
```

Die Session wird in `./.session` gespeichert (persistenter Browser-Kontext = deine echten Cookies).
Dieser Ordner ist geheim — niemals committen (steht in .gitignore).

## Wichtig

- Der Rechner muss laufen, damit Outreach/Inbox arbeiten (wie bei Linked Helper).
- Cold Outreach + Profil-Scraping ist DSGVO-relevant. Führe eine Rechtsgrundlage /
  Löschkonzept für dein CRM. Das ist dein Thema, nicht das des Tools.
- Halte die Defaults in `config.ts` konservativ. Sie sind bewusst niedrig.

## Bau-Status

- [x] Phase 0: Safety-Governor + persistente Session
- [x] Phase 1: Posting (offizielle API) + Queue-Anbindung
- [ ] Phase 2: CRM + Gemini-Personalisierung
- [ ] Phase 3: Outreach-Engine (Grundgerüst vorhanden, gated)
- [ ] Phase 4: Inbox-Monitor + Reply-Drafts
- [ ] Phase 5: Analytics-Dashboard
