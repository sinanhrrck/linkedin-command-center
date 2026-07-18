# LinkedIn Command Center — Projektkontext für Claude Code

## Was das ist
Lokales All-in-One-Tool für Sinans LinkedIn: Posting (offizielle API), Cold Outreach
(Vernetzen + DMs), Inbox-Entwürfe, Lead-CRM, Analytics. Läuft komplett **lokal** auf
seinem Rechner mit seiner echten Browser-Session. Die **Runtime muss kostenlos bleiben**
(Node, Playwright, Gemini Free Tier, offizielle LinkedIn-API — keine bezahlten Tools).

## Oberstes Prinzip (nicht verhandelbar)
JEDE sendende Aktion (`connect`, `message`, `comment`, `profileView`) MUSS durch
`governor.execute()` aus `src/core/safetyGovernor.ts` laufen. Niemals direkt senden,
niemals den Governor umgehen. Er erzwingt Tages-/Wochen-Caps, Warm-up-Ramp,
Arbeitszeitfenster, zufällige Delays und einen Circuit-Breaker.
Das Posting über die offizielle API (`src/modules/posting.ts`) ist bewusst getrennt und
braucht den Governor NICHT.

## Architektur
- `core/safetyGovernor.ts` — Herzstück: Drosselung + Circuit-Breaker
- `core/session.ts` — persistenter Playwright-Kontext (echte Session) + Checkpoint-Erkennung.
  Fenster läuft VERSTECKT (`config.browser.hidden`, macOS via System Events), stört Sinan nicht.
  `getContext({visible:true})` nur fürs manuelle Login.
- `core/humanize.ts` — Delays, menschliches Tippen, Scrollen
- `core/gemini.ts` — Gemini (Free Tier) Textgenerierung — treibt ALLE Tests + Entwürfe (gratis)
- `core/claude.ts` — Anthropic/Claude (BEZAHLT), `generateClaude()` + `claudeAvailable()`. NUR
  vom Voll-Autopilot (`converseStep`) genutzt. Getrennt gehalten, damit das Guthaben geschont
  bleibt: Manuell/Halb-Modus fasst Claude nie an.
- `core/events.ts` — interner Event-Bus (z.B. "draft:new" → Telegram-Push, ohne Import-Zyklen)
- `modules/telegram.ts` — Telegram-Steuerung (grammy): /status, /entwuerfe (Freigeben/Senden
  per Inline-Button), /pause, /resume; pusht neue Entwürfe automatisch in den Chat. Läuft im
  Engine-Prozess (index.ts → startTelegram), teilt sich die Browser-Session.
- `modules/posting.ts` — offizielle LinkedIn Posts-API
- `modules/leads.ts` — Suchergebnisse scrapen → CRM (kostenloser Apollo-Ersatz)
- `modules/leadFeed.ts` — automatische Lead-Fütterung: gespeicherte Such-Quellen (lead_sources),
  blättert seitenweise (cursor_page), 2x/Tag im Loop. Hält die Pipeline gefüllt.
  Optionaler `keep_filter` (Regex) pro Quelle: speichert nur Kontakte, deren Name/Headline
  passt (z.B. Azubi-Quelle mit /ausbildung|azubi/i → CRM bleibt dauerhaft trainee-only).
  CLI: `npm run source -- add "<url>" "<label>" ["<filter-regex>"]`.
- `modules/crm.ts` — SQLite-Kontakte
- `modules/personalize.ts` — Gemini: Vernetzungsnotiz + Erstnachricht
- `modules/outreach.ts` — connect/message über echte Session, governor-gated
- `modules/outreachTick.ts` — Loop: neue Leads → personalisieren → vernetzen
- `modules/acceptance.ts` — Phase 4: liest Kontaktliste, setzt `accepted_at` (rein lesend)
- `modules/inbox.ts` — liest Messaging-Threads (rein lesend, klickt Zeilen an für stabile URL)
- `modules/drafts.ts` — DM-Entwürfe: Inbox→Gemini→drafts-Tabelle; `sendDraft` sendet via Governor
- `modules/autopilot.ts` — VOLL-AUTONOME Gespräche (config.autopilot.enabled, default AUS):
  `converseStep` (1 Gemini-Call klassifiziert+antwortet) → Routine autonom senden (governor),
  Termin-Zusage/Kontakt → Handoff-Event `lead:booked` (Telegram-Push mit Nummer), Einwand/
  Unsicher/Limit → Eskalation als pending-Draft. Zustand je Thread in `conversations`-Tabelle.
  NUR mit bezahltem KI-Key (20/Tag-Gratis reicht nicht) + Immer-an-Maschine sinnvoll.
- `modules/dashboard.ts` — stellt Dashboard-State als JSON zusammen (rein lesend)
- `core/safetyGovernor.ts` → `snapshot()` — read-only Telemetrie (Caps/Warm-up/Rate/Pause)
- `context.ts` — ZENTRALER Standpunkt für ALLE KI-Texte: PERSONA (Finanzmakler Fin.Co),
  ZIEL (Mehrwert-first/Mentoring), STIL_REGELN (per Du, keine Emojis, keine Gedankenstriche),
  BEISPIEL_NACHRICHTEN (few-shot). `promptKontext()` + `saubern()`. Hier ändern wirkt überall.
- `web/crm.html` — lokales CRM-Cockpit. HELLES SaaS-Design (2026-07-18, inspiriert von
  Donezo/Nexus/Zentra): App-Shell mit linker Sidebar (`.app > .sidebar + .wrap`), grüner
  Marken-Akzent, weiche Schatten, Card-Layout, grosse Zahlen. WICHTIG bei Umbauten: das CSS
  nutzt durchgängig CSS-Variablen mit BEIBEHALTENEN Namen (`--accent`, `--green`, `--amber`,
  `--red`, `--ink`, `--panel` …), weil die render-Funktionen Inline-Styles wie
  `style="color:var(--amber)"` setzen — Werte in `:root` ummappen wirkt überall, Namen NICHT
  umbenennen. Sidebar-Nav = `.nav-item[data-jump]` (scrollt zur Sektion, rein visuell/Anker).
  Start/Stop-Button (POST /api/engine) + Modus-Umschalter (POST /api/mode) + Post-Freigabe
  (POST /api/post). "Command Center starten.command" = Doppelklick-Launcher.

## Automatik-Modi (db state 'mode', default 'manual', umschaltbar im Dashboard)
- **manual**: vernetzt auto; Erstnachricht + Antworten + Follow-ups = Entwürfe zur Freigabe.
- **semi**: + Erstnachricht auto (deliverFirstMessage → sendMessage, Fallback Entwurf).
- **full**: + Autopilot (Antworten/Follow-ups autonom, Termin-Handoff). `getMode()` in db/index.ts.
  index.ts: generateInboxDrafts nur wenn !full; runAutopilot self-gated auf full.
- `db/` — SQLite-Schema + Zugriff
- `index.ts` — Cron-Loop (Posting + Outreach + Acceptance-Check + Draft-Generierung + Status).
  Schreibt jede Minute `engine_heartbeat` in state → Dashboard erkennt "Bot arbeitet".
  Dashboard zeigt Heartbeat, Tages-Bilanz und Aktivitäts-Timeline (aus `actions` + Kontaktnamen).
- `scripts/` — `login`, `scrape`, `accept`, `crmServer` (CLI)

## Stand
Fertig: Phase 0 (Governor+Session), Phase 1 (Posting), Phase 2 (Leads+CRM+Personalisierung),
Outreach-Loop, **Phase 4 (Acceptance-Tracking)**.

Phase 4: `modules/acceptance.ts` liest die eigene Kontaktliste (rein lesend, kein Governor)
und setzt `contacts.accepted_at` + Status `accepted` für erkannte Annahmen. Läuft 3x täglich
im Cron-Loop (`index.ts`) und manuell via `npm run accept`. Damit ist der Akzeptanzraten-
Circuit-Breaker scharf. `accepted_at` = Erkennungszeitpunkt (nicht exakter Annahme-Moment),
für das 7-Tage-Fenster ausreichend.

DM-Entwürfe (fertig): Inbox lesen → Gemini-Draft → im Dashboard freigeben/editieren/verwerfen
→ `npm run send -- <id>` sendet governor-gated in den Thread. Loop generiert 2x tägl. neue Drafts.

Telegram-Steuerung (fertig): `modules/telegram.ts`, aktiv sobald TELEGRAM_BOT_TOKEN gesetzt.
Chat-ID via /start abfragen, in TELEGRAM_CHAT_ID eintragen (für Push + Zugriffsschutz).

Lead-Gen (fertig): Antwort-Erkennung (generateInboxDrafts → markRepliedByName, Kontakt→'replied'
= Hot Lead) + Follow-up-Sequenz (generateFollowups: messaged >=4 Tage ohne Antwort → kind='followup'
Entwurf; nicht bei Hot Leads). Hot Leads im Dashboard-Panel + Telegram /leads + /status.
contacts.messaged_at/replied_at neu. Draft-kinds: message (Thread-Antwort), first (Erstnachricht
nach Annahme), followup — first/followup senden via sendMessage, message via sendThreadReply.

Als Nächstes, nach Priorität:
1. Kommentar-Entwürfe (drafts.kind='comment' existiert schon, Generierung/Feed-Reader fehlt).
2. Funnel-Analytics (Conversion-Raten je Stufe), bessere/mehr Lead-Quellen (letztes Lehrjahr).
3. Optional: n8n self-hosted als visuelles Cockpit.

Lead-Scraping (`leads.ts`): LinkedIn verschleiert die Karten-CSS-Klassen → Selektoren
brechen. Deshalb parst `leads.ts` den KARTEN-TEXT (Anchor-innerText): 1. Zeile = Name,
"Aktuell:"-Zeile = Jobbezeichnung (headline). Robuster als Klassen. Bei UI-Änderung dort prüfen.
Kontakte löschbar über Dashboard (Button je Zeile → `/api/contact` delete) bzw. `crm.deleteContact`.

Kleinere offene Punkte:
- `LINKEDIN_REFRESH_TOKEN` bleibt leer (App ohne Member-Data-Programm); Access-Token ~60 Tage,
  danach `npm run auth` erneut. Auto-Refresh in `linkedinToken.ts` läuft ohne Refresh-Token ins Leere.

## Browser-Modus: "embedded" (alles live gemessen 2026-07-16, nicht raten)
Ziel des Nutzers: KEIN aufpoppendes Fenster, Seite stattdessen IM Dashboard sehen. Der Bot
steuert Chrome über CDP, nicht über echte Maus (anders als LinkedIn Helper = Extension im
Nutzer-Fenster), braucht also gar kein Fenster.

**Lösung: `config.browser.mode="embedded"` = headless + Fingerprint-Härtung + Live-Ansicht.**
Headless erzeugt kein Fenster (kann nicht aufpoppen) UND Screenshots funktionieren → Live-Bild
im Dashboard (`/api/live.jpg`, Engine schreibt `.live/screen.jpg` im Heartbeat).

Gemessene Sackgassen (nicht nochmal probieren):
- `--window-position=-32000,-32000` wirkt NICHT: macOS klemmt das Fenster auf (0,38) zurück.
- Fenster via System Events verstecken (Prozess heißt "Google Chrome for Testing", NICHT
  "Chromium" → sonst Fehler -10006) funktioniert zwar und der Bot arbeitet weiter (rAF +
  `locator.click()` getestet OK, dank der drei `--disable-*backgrounding*`-Flags), ABER ein
  verstecktes Fenster liefert keine Frames → `page.screenshot()` UND CDP
  `Page.captureScreenshot{fromSurface:false}` hängen bis in den Timeout. Verstecken und
  Live-Ansicht schließen sich auf macOS aus → verworfen.

Headless-Härtung (Marker, die LinkedIn sonst verraten; alle in `core/session.ts`):
- UA: `config.browser.userAgent` überschreibt `HeadlessChrome/149...` → `Chrome/149.0.0.0`.
- `STEALTH`-InitScript: `navigator.plugins` 0→5, `navigator.mimeTypes`, `window.chrome`.
- `locale: de-DE`, `timezoneId: Europe/Berlin` (headless meldet sonst en-US/UTC).
- Verifiziert gegen echtes LinkedIn: Feed erreicht, eingeloggt, Live-Bild 1280x900.
`BROWSER_MODE=visible` in `.env` = echtes Fenster (Zuschauen). `npm run login` erzwingt immer
ein Fenster (`getContext({visible:true})`), sonst kannst du dich nicht einloggen.

## Tempo: der Cap ist die Decke, nicht die Geschwindigkeit
Messung 2026-07-16: am 15.07. 10 Vernetzungen = bei Warm-up 57% praktisch der volle Tages-Cap
(~11). Der Bot war NICHT langsam, er war 21h aus (Lücke von 76.185s in `actions`). Rechnung:
LinkedIn sperrt ab ~100 Invites/Woche → mehr Tempo bringt KEINE Leads, nur Ban-Risiko. Caps und
`delayBetweenActionsMs` NICHT hochdrehen. Der Hebel für mehr Leads ist Conversion (Annahme,
Antwort, Follow-up) + die Engine dauerhaft laufen lassen, nicht Speed.

**Gefixt (2026-07-16): überlappende Ticks.** Der Governor hält den 20-75s-Abstand nur INNERHALB
eines Durchlaufs. Start-Tick (`setTimeout 4s`) + 12-Min-Cron konnten sich überlappen → zwei
Vernetzungen 8s auseinander, obwohl Minimum 20s (real in `actions` gemessen). Jetzt läuft jeder
Job durch `einzeln(name, fn)` in `index.ts` (Set-Sperre, überlappender Durchlauf wird
übersprungen). Bei neuen Cron-Jobs IMMER `einzeln()` benutzen.

Acceptance läuft jetzt STÜNDLICH (`5 9-19 * * *`) statt 3x/Tag: rein lesend, kein Governor →
kostet keine Sicherheit, verkürzt aber "hat angenommen" → "Erstnachricht-Entwurf liegt bereit"
von bis zu 8h auf max. 1h. Drafts bleiben bewusst 2x/Tag – Grund ist das Gemini-Free-Limit
(~20/Tag), nicht Vorsicht.

## Telegram meldet JEDE Aktion
`governor.record()` ist der einzige Choke-Point aller Sends → feuert `events.emit("action:done",
{type,target})`. `telegram.ts` hört darauf und pusht mit Klarname (aus dem CRM) + Tages-/Wochenstand.
Neue Sendewege brauchen NICHTS extra, solange sie über den Governor laufen.

## Akzeptanzrate: Kohorten-Messung (BUG GEFIXT 2026-07-16)
`governor.acceptanceRate()` war kaputt und hätte den Outreach grundlos stillgelegt:
- Nenner zählte ALLE `actions` vom Typ connect der letzten 7 Tage – auch die von vor Minuten,
  die niemand annehmen konnte (Menschen brauchen 1-3 Tage). Je fleißiger der Bot, desto
  schlechter die Quote.
- Zähler kam aus `contacts.accepted_at`, also aus einer ANDEREN Gruppe als der Nenner.
- `actions` überlebt das Löschen von Kontakten → jeder gelöschte Lead (Nicht-Azubi-Aufräumen)
  verschlechterte die Quote dauerhaft.
- Real gemessen: 13% bei n=16, Pause ab n=20 → Bot hätte sich in 4 Anfragen abgeschaltet,
  obwohl es 0 reife Einladungen gab.

Jetzt: Kohorte aus `contacts` – Einladungen im Fenster `[now-7d ... now-{acceptanceMaturityDays}d]`
(default 2 Tage Reifezeit), davon der Anteil mit `accepted_at`. Gleiche Gruppe oben wie unten,
frische Invites zählen erst mit, wenn sie eine faire Chance hatten. Breaker bleibt scharf.

## Senden MUSS verifiziert werden (BUG GEFIXT 2026-07-16)
Der Bot hat Versände gemeldet, die nie stattfanden: `sendMessage` tippte, drückte Enter und
markierte dann BEDINGUNGSLOS `status='messaged'` → `governor.record()` → Telegram-Push
"✉️ Nachricht gesendet". Real passiert: Jonas Jüppner (09:43) + Ben Endress (10:06) als
gesendet gemeldet, im Postfach kam nie etwas an (Texte verpufften ins Leere; nachweislich
KEINE Fehlleitung an Dritte). Beide Kontakte wurden auf 'accepted' zurückgesetzt.

Jetzt läuft jeder Versand über `tippenUndSenden(page, text)` in `outreach.ts` mit ZWEI
unabhängigen Belegen: (1) LinkedIn leert das Eingabefeld nach erfolgreichem Senden – ist der
Text noch drin, ging nichts raus; (2) der Text taucht im Verlauf auf (`SEL.threadItem =
.msg-s-event-listitem`). Schlägt einer fehl → throw → Aufrufer macht einen Entwurf daraus.
REGEL: niemals einen Status auf 'gesendet' setzen, ohne den Versand belegt zu haben. Lieber
kein Versand als eine Falschmeldung.

**URSACHE (live bewiesen): `keyboard.press("Enter")` SENDET NICHT.** LinkedIns "Mit Enter senden"
ist bei Sinan aus → Enter macht nur einen Zeilenumbruch, der Text bleibt im Feld stehen.
Gegenexperiment aus den echten Daten: `sendThreadReply` klickte `.msg-form__send-button` → die
Nachricht an Marc Westphal (Entwurf 9) kam nachweislich an. `sendMessage` drückte Enter → Jonas +
Ben verpufften. Gemessen: der Senden-Knopf existiert, ist bei leerem Feld `disabled` und wird nach
dem Tippen `enabled`. IMMER den Button klicken, Enter höchstens als Fallback.

## Nach Code-Änderungen BEIDE Prozesse neu starten
Engine (`index.ts`) und Dashboard (`crmServer.ts`) sind getrennte Node-Prozesse und laden
Module beim Start. Eine Code-Änderung wirkt erst nach Neustart. Hat 2026-07-16 zweimal
Verwirrung gestiftet: (1) `/api/live.jpg` gab 404, weil der laufende crmServer die Route noch
nicht kannte; (2) das Dashboard zeigte stundenlang "Akzeptanzrate 24% (n=21)" aus der alten,
kaputten Formel, während der Code längst korrekt "STANDBY (n=0)" berechnete – der Prozess lief
seit vor dem Fix. Beim Debuggen von "die Anzeige stimmt nicht" IMMER zuerst prüfen, ob der
Prozess älter ist als die Datei (`ps -p <pid> -o lstart=` vs `stat -f '%Sm' <datei>`).
Neustart: `POST /api/engine {"action":"stop"}` + `{"action":"start"}` bzw. crmServer killen
und `npm run crm`.

## Bekannte Watchouts
- **UI-SELEKTOREN BRECHEN.** Gebündelt in `outreach.ts`/`leads.ts`/`inbox.ts` (SEL-Konstanten).
  Stand 2026-07-15 alle live verifiziert. WICHTIG: Der "Vernetzen"-Button des Hauptprofils ist
  ein `<a>` (kein `<button>`) und wird über `aria-label*="als Kontakt einladen"` getroffen;
  Sidebar-Vorschläge tragen dasselbe Label, stehen aber später im DOM → `.first()` = Hauptprofil.
  Der finale Klick+Senden konnte nicht automatisiert getestet werden (System sperrt reale Sends) –
  beim ersten echten Lauf `engine.log` prüfen, ob Vernetzungen als `invited` durchgehen.
- **BUG GEFIXT 2026-07-16 (Nachricht-Button):** `button:has-text("Nachricht")` traf mit `.first()`
  den Umschalter des Nachrichten-OVERLAYS (unten rechts, außerhalb `main`) → die Erstnachricht wäre
  in einen FREMDEN Chat getippt worden. Jetzt `SEL.messageBtn = 'main a[href*="/messaging/compose"]
  :not([aria-label])'`: der echte Button ist ein `<a>` auf den Compose-Link mit der `profileUrn`
  dieser Person; `:not([aria-label])` filtert die Vorschlags-Kacheln fremder Leute raus (die tragen
  `aria-label="Nachricht an <fremder Name> senden"`). Live verifiziert: genau 2 Treffer je Profil
  (Kopfbereich + Sticky-Header), beide mit IDENTISCHER URN → `.first()` immer korrekt. Fehlt der
  Button, wirft `sendMessage` jetzt lieber, statt blind zu klicken.
- `npm run login` EINMAL ausführen und manuell einloggen, bevor sonst etwas läuft.
- Niemals `./.session` oder `.env` committen (stehen in `.gitignore`).
- **DSGVO:** Das CRM enthält personenbezogene Daten Dritter. Rechtsgrundlage/Löschkonzept
  ist Sinans Verantwortung — keine eigenmächtigen „Compliance-Features" ohne Rücksprache.

## Setup
Vollständige Schritt-für-Schritt-Anleitung in `SETUP.md`. Kurzfassung:
```
npm install && npx playwright install chromium
cp .env.example .env      # GEMINI_API_KEY + LINKEDIN_CLIENT_ID/SECRET eintragen
npm run auth              # OAuth-Flow: holt ACCESS/REFRESH-Token + PERSON_URN automatisch
npm run login             # einmalig manuell in LinkedIn einloggen (Browser-Session fürs Outreach)
npm run scrape -- "<LinkedIn-Such-URL>"
npm run dev
```
Scripts: `auth` (OAuth), `urn` (Person-URN nachholen), `login` (Browser-Session),
`scrape` (Leads einmalig), `source -- add|list|feed` (Lead-Quellen für Auto-Fütterung),
`post` (Test-Post), `accept` (Acceptance-Check), `drafts` (DM-Entwürfe
erzeugen), `send -- <id>` (freigegebenen Entwurf senden), `crm` (CRM-Cockpit auf
http://localhost:4321), `dev`/`start` (Loop). Token-Refresh läuft automatisch über
`src/core/linkedinToken.ts` bei 401.

## Dual-LLM: Gemini (gratis) + Claude (bezahlt)
Zwei KI-Kanäle, bewusst getrennt (`src/config.ts` → `gemini` / `llm`):
- **Gemini (Free Tier)** = alle Tests + jeder Entwurf (Notiz, Erstnachricht, Follow-up, DM-Draft).
  `core/gemini.ts generate()`.
- **Claude (bezahlt, `core/claude.ts generateClaude()`)** = NUR `converseStep` (Autopilot-Herz).
  Router in `personalize.ts generateAutopilot()`: `config.llm.autopilotProvider==="claude"` &&
  Key vorhanden → Claude, sonst Gemini-Fallback. `converseStep` läuft ausschließlich in
  `runAutopilot` (Voll-Modus, default AUS) → **im Manuell/Halb-Modus wird der bezahlte Key nie
  angefasst**, Guthaben bleibt geschont. `.env`: `ANTHROPIC_API_KEY` + optional
  `LLM_AUTOPILOT_PROVIDER=gemini` (erzwingt Gratis auch im Voll-Modus). Modell
  `config.llm.model` (default `claude-opus-4-8`; für Budget-Sparen → `claude-haiku-4-5`).

## Gemini-Modell & Free-Tier-Limit (WICHTIG)
`config.gemini.model = "gemini-flash-latest"`. Der Free Tier dieses Keys erlaubt **nur ~20
generateContent/Tag** und NUR auf diesem Alias – alle gepinnten 2.x-Modelle liefern
`limit: 0` (kein Gratis-Kontingent). Deshalb KI-Aufrufe sparsam: `config.gemini.connectNotes=false`
(keine KI-Notiz an Vernetzungsanfragen; LinkedIn lässt Notizen eh meist nicht zu). Das 20/Tag-
Budget bleibt für Erstnachrichten (bei Annahme) + DM-Antworten. 429 = Tageslimit erreicht → wartet auf Reset.

## Auto-Erstnachricht bei Annahme
`acceptance.ts` erzeugt bei jeder neu erkannten Annahme via `drafts.createFirstMessageDraft`
einen personalisierten Erstnachricht-Entwurf (kind='first', Ziel=Profil-URL) → Dashboard zur
Freigabe → `sendDraft` sendet via `sendMessage`. Winkel/Story in `context.ts ERSTNACHRICHT_ANGLE`
(Sinan hat selbst Bank-Ausbildung gemacht; Ziel: Plan nach der Ausbildung erfragen).

## Konventionen
- TypeScript, ESM, deutsche Kommentare.
- Selektoren gebündelt, nie inline verstreuen.
- Kein Bypass des Governors. Kein Cloud-Sending. Fürs Senden deterministischer Code,
  keine LLM-Live-Klicks.
