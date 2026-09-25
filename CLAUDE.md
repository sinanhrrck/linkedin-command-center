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
- `core/safetyGovernor.ts` — Herzstück: Drosselung + Circuit-Breaker. WOCHENEND-REGEL
  (2026-07-18): `withinWorkingHours(type)` ist typ-abhängig — am Sa/So sind nur
  `config.safety.weekendActions` (connect/like/profileView) erlaubt, message+comment NICHT
  (Nachrichten wirken werktags menschlicher). Vernetzen läuft also 7 Tage, DMs nur Mo-Fr.
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
- `core/profileUrl.ts` + `db/dataIntegrity.ts` — kanonische LinkedIn-Profil-URLs und
  idempotente Dubletten-Reparatur. Alle abhängigen Kontakte, Aufgaben, Entwürfe, Aktionen und
  Versand-Sperren werden vor dem Löschen einer Dublette auf den Gewinner umgebogen.
- `modules/campaigns.ts` + `modules/campaignRunner.ts` — Event-Kampagnen mit fester
  Zielgruppen-Momentaufnahme, getrennt nach bestehendem Netzwerk und externen Kontakten.
  Externe Kontakte laufen zuerst durch den normalen Vernetzungsprozess; nach Annahme entsteht
  ein freizugebender `kind='event'`-Nachrichtenentwurf. Versand bleibt governor-gated.
  BEARBEITEN + KONTEXT (2026-08-04): Kampagnen sind im Cockpit editierbar (dasselbe Formular legt
  an und ändert). Neue Felder `event_time`, `location`, `briefing` plus Tabelle `campaign_assets`
  (Flyer/Link + vom Nutzer gepflegte Kernaussagen; Datei liegt lokal unter `config.paths.uploadDir`,
  Upload läuft als JSON+Base64 über `/api/campaign-asset`, max. 8 MB). `campaignContext(id)` baut
  daraus einen Prompt-Baustein, den `regenerateText` beim NEUSCHREIBEN von Event-Entwürfen einspeist
  ("nichts dazuerfinden") — der Erstentwurf bleibt bewusst Template, das schont das Gemini-Limit.
  Template kennt zusätzlich `{zeit}`, `{ort}`, `{briefing}`. Beim Speichern läuft
  `pruneCampaignTargets`: verengte Filter entfernen nur Kontakte OHNE Entwurf/Versand.
  LÖSCHEN + EIGENER PRÜFPLATZ (2026-08-04): `deleteCampaign(id)` entfernt Kampagne, Zielgruppe,
  Material samt lokalen Dateien und ALLE Entwürfe mit `incoming='campaign:<id>'` (auch bereits
  freigegebene); Kontakte bleiben und verlieren nur `campaign_id`. `actions` bleibt unangetastet –
  das Versandprotokoll darf nie von einer Aufräumaktion abhängen. Kampagnen-Entwürfe erscheinen
  NICHT mehr im Arbeitskorb „Heute" (Gruppe `eventInvites` raus, `attention.total` zählt
  `kind='event'` nicht mit), sondern werden in der Kampagne selbst geprüft: `reviewCampaign` im
  Dashboard-JS schaltet denselben Prüf-Bereich auf den Container `#campaign-reviewer` um und
  filtert nach `incoming`.
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
- `context.ts` + `profil.ts` — ZENTRALER Standpunkt für ALLE KI-Texte. Seit 2026-07-18 kommt
  der INHALT (PERSONA, ZIEL, TABUS, STIL_REGELN, BEISPIEL_NACHRICHTEN, Winkel) aus dem
  NUTZER-PROFIL statt fest aus dem Code: `profil.ts` lädt `profil.local.json` → sonst
  `profil.example.json` → sonst neutraler Default. context.ts hält nur noch die LOGIK
  (`promptKontext()`, `saubern()`, `erstnachrichtAngle()`, Exporte unverändert). Damit kann
  JEDER das Tool lokal mit eigenem Profil nutzen (Ziel: an Laien verteilbar). `profil.local.json`
  ist gitignored (bleibt lokal wie .env/.session); `profil.example.json` = mitgelieferte Blaupause.
  Sinans Werte stehen in seiner lokalen profil.local.json; sein `promptKontext()` ist byte-
  identisch zu vorher (einzige Abweichung: Erstnachricht-Winkel sagt "keine Werbung" statt
  "keine Werbung für Fin.Co" — die Marke gehört ins Profil, nicht in den geteilten Grundtext).
- `web/command-center.html` + `.css` + `.js` — aktives lokales CRM-Cockpit (seit 2026-08-04).
  Fünf eindeutige Bereiche: Heute, Kampagnen, Kontakte, Auswertung, Einstellungen. „Heute"
  ist ein priorisierter Arbeitskorb und zeigt nur echte Entscheidungen; die Entwurfsprüfung
  ist bewusst einzeln und fokussiert. Kampagnen zeigen Zielgruppen-Vorschau und Fortschritt.
  `crmServer.ts` liefert diese Seite aus.
- **Entwurfsfeedback (2026-08-04):** `drafts.phase='approach'` ist eine nicht sendbare
  Richtungswahl. `draft_feedback` speichert Ablehnungsgrund, Freitext, Wortlaut und gewählten
  `approach_key`. `draftDirections.ts` bietet je Nachrichtenart echte Gesprächsrichtungen und
  priorisiert noch nie verworfene. `approveDraft`/`sendDraft` blockieren Richtungswahlen hart.
- **Aktivitätsleitstand (2026-08-04):** `bot_activity` protokolliert Start, Abschluss und Fehler
  aller seriellen Engine-Jobs. Das Dashboard zeigt „Jetzt", die bedarfsabhängig geplanten
  nächsten Arbeiten und die letzten Abschlüsse. Sendende Aktionen bleiben zusätzlich in
  `actions` als unveränderliches Safety-/Metrik-Protokoll.
- **EINHEITLICHES MESSMODELL (2026-08-12, Phase 5.1):** `crm_stage_events` ist die EINZIGE Wahrheit
  für jede Funnel-Zahl. Vorher lagen die vorderen Stufen als Zeitstempel auf `contacts` und die
  hinteren als Ereignisse — zwei Wahrheiten, die sich nicht fair vergleichen ließen. Jetzt trägt die
  Tabelle die volle Kette (`FUNNEL_STAGES`: found → suitable → invited → accepted → messaged →
  replied → qualified → meeting → won/lost/not_fit) plus `reply_quality` (`REPLY_QUALITIES`).
  DREI REGELN, die nicht aufgeweicht werden dürfen:
  1. **Ein Ereignis zählt einmal.** `dedupe_key` ist FACHLICH (`contact:<id>:<stage>`), nie zeitlich.
     Ein Neustart, ein zweiter Tick oder ein erneuter Lead-Fund schreibt denselben Schlüssel und
     wird ignoriert. Wer `Date.now()` in einen Dedupe-Key schreibt, zerstört genau diese Zusage.
  2. **Zuordnung wird beim Schreiben eingefroren** (`campaign_id`, `source_id`, `goal_code`,
     `occurred_at`). Niemals über `contacts` joinen: ein späterer Kampagnenwechsel würde sonst die
     Historie rückwirkend umschreiben. Fehlende Zuordnung wird NACHGETRAGEN, belegte nie geändert.
  3. **`aus_netzwerk=1` bekommt kein `invited`/`accepted`** — diese Verbindungen kosteten nie eine
     Anfrage und würden die Annahmequote nach oben verfälschen.
  Schreibpfad: `recordCrmStage()` in `crmStages.ts` (Hooks in `crm.ts` upsert/markAccepted/
  markInboundReply und `outreach.ts` nach bestätigter Einladung). Lesepfad: `modules/funnel.ts`
  (`funnelReport`, `funnelByCampaign`, `funnelBySource`, `contactsForStage`) mit Filtern nach
  Kampagne/Ziel/Quelle/Zielgruppe/Zeitraum/Route/Automatik-Status. API: `GET /api/funnel` und
  `GET /api/funnel/contacts?stage=…` — beide mit identischen Filtern, damit die Drilldown-Liste
  nie von der Kennzahl abweichen kann (das ist die Abnahme „jeder Wert ist rückführbar").
  `backfillCrmStages()` übernimmt den Altbestand idempotent aus den vorhandenen Zeitstempeln.
  COCKPIT: Bereich „Von der Quelle zum Ergebnis" in der Auswertung (`.wirkung` in
  command-center.html/.css/.js). Der ALTE 5-Stufen-Funnel wurde ERSETZT, nicht ergänzt, und auch
  der Mini-Funnel auf „Heute" (`dashboard.ts`) liest jetzt aus `funnelReport` — zwei Funnel mit
  abweichenden Zahlen auf derselben Seite waren genau das Problem. Die Wirkungs-Ansicht hat einen
  EIGENEN Ladepfad (`ladeWirkung`), nicht `/api/state`, damit Filter sofort reagieren; sie wird
  einmal geholt und danach nur bei Filteränderung. WICHTIG: `ladeWirkung` nutzt eine laufende
  Nummer (`wirkungAnfrage`), KEINE Lade-Sperre. Eine Sperre verwarf Filteränderungen während eines
  laufenden Requests still — die Ansicht zeigte dann Zahlen, die nicht zu den sichtbaren Filtern
  passten. Neue asynchrone Ansichten hier bitte genauso bauen.
- `web/crm.html` — vorheriges CRM-Cockpit, nur noch als Altbestand im Repository. HELLES SaaS-Design (2026-07-18, inspiriert von
  Donezo/Nexus/Zentra): App-Shell mit linker Sidebar (`.app > .sidebar + .wrap`), grüner
  Marken-Akzent, weiche Schatten, Card-Layout, grosse Zahlen. WICHTIG bei Umbauten: das CSS
  nutzt durchgängig CSS-Variablen mit BEIBEHALTENEN Namen (`--accent`, `--green`, `--amber`,
  `--red`, `--ink`, `--panel` …), weil die render-Funktionen Inline-Styles wie
  `style="color:var(--amber)"` setzen — Werte in `:root` ummappen wirkt überall, Namen NICHT
  umbenennen. Sidebar-Nav = `.nav-item[data-jump]` (scrollt zur Sektion, rein visuell/Anker).
  Start/Stop-Button (POST /api/engine) + Modus-Umschalter (POST /api/mode) + Post-Freigabe
  (POST /api/post). "Command Center starten.command" = Doppelklick-Launcher.
  SMART-FEATURES (2026-07-18): Action-Center oben (`renderActionCenter`, zeigt was JETZT
  Hand braucht: Hot Leads/Eskalationen/Entwürfe, springt hin), Sammel-Freigabe (`#bulk-send`
  klickt jeden Senden-Knopf → nutzt dieselbe serialisierte Queue), Lead-Score-Pills
  (`scorePill`, aus contacts.lead_score). CHARTS: Verlauf-Linienchart (`renderTrend`, SVG,
  `dashboard.trend` = 28 Tage connect+accepted) + Wochenbalken (`renderChart`,
  `dashboard.weekActivity`) zusammen in EINEM Panel (.analytics-big, weniger Kacheln);
  Conversion-Funnel als horizontale Balken (`#funnel`, Conversion-% je Stufe); KPI-Trend-
  Badges (`deltaBadge`, `dashboard.deltas` = Woche vs. Vorwoche). Neue State-Felder in
  dashboard.ts: weekActivity, trend, deltas, contacts.lead_score.
  FREIGABE-WORKFLOW (2026-07-18, Sinans Vorgabe): Der Nutzer entscheidet im Dashboard nur
  GENEHMIGEN oder ABLEHNEN, das SENDEN macht die ENGINE. `dc-approve` → /api/draft
  action=approve → `approveDraft` setzt status='approved'. Der Engine-Cron `sendApprovedDrafts`
  (index.ts, alle 10 Min 9-19 + Morgen-Routine 9:00 + Start-Tick) sendet approved-Drafts
  governor-gedrosselt. `dc-reject` → action=reject → `rejectDraft` verwirft + erzeugt SOFORT
  einen neuen Entwurf (`regenerateText`, KI-Aufruf). Kein Direktversand mehr aus dem Dashboard.
  Entwurfskarten zeigen wichtige Intents (chance/einwand/meeting) als `dc-flag`. Action-Center
  hat eindeutige Ziele je Punkt (Entwürfe→Bearbeiten, Hot Leads→Anrufen), Eskalation als
  "N× wichtig"-Tag beim Entwürfe-Punkt statt eigener (verwirrender) Doppel-Zeile.
  ACHTUNG bei langen Seiten: der In-App-Browser-Pane paintet weit unten nach Scroll teils
  nicht (Artefakt) — DOM/oberer Bereich sind maßgeblich, nicht der Leerscreenshot.

## SERVER-MODUS / DOCKER (2026-09-21) — Heimserver ohne Bildschirm
Anleitung für Laien: `MIGRATION.md`. Alles hängt an `NEXTLEAD_SERVER=1` (`npm run server`, Dockerfile);
ohne das Flag sind Mac-App und Dev-Modus byte-identisch zu vorher (verifiziert: `config.paths` liefert
ohne DATA_DIR exakt die alten Defaults, 94/94 Tests grün).
- **EIN Datenordner.** `config.paths` (config.ts) leitet ALLE Pfade aus `DATA_DIR` ab (Standard
  `./data` im Server-Modus): DB+Backups, `.session`, `.env`, `profil.local.json`, `.uploads`, `.live`,
  `engine.log`. Spezifische Variablen (`DB_PATH`, `SESSION_DIR`, `ENV_PATH`, `PROFIL_PATH`, `LIVE_DIR`,
  `ENGINE_LOG`) gewinnen immer. `dotenv` lädt `.env` aus dem Datenordner. Neue Pfade NIE mehr über
  `process.cwd()` hart verdrahten, immer `config.paths`.
- **`core/serverMode.ts`:** Startverweigerung (Exit 78) ohne `DASHBOARD_TOKEN` (min. 12 Zeichen);
  Basic-Auth (`anmeldungOk`, zeitkonstanter Vergleich, gilt in JEDEM Modus sobald ein Token gesetzt
  ist, vor jeder Route); `logZeitzone()` (Governor-Arbeitszeiten!); `serverErststart()` = einmal je
  Datenordner Not-Aus AN (`send_stop=1`) + `start_date=jetzt` (Warm-up zurück auf Tag 1, LinkedIn
  sieht ein neues Gerät) + Warnung, wenn `data.db` jünger ist als `umzug-info.json.exportedAt`.
- **Engine-Autostart + Watchdog** nur im Server-Modus (crmServer.ts, nach `listen`): Engine startet
  1,5 s nach dem Dashboard, sofern `engine_gewollt` ≠ 0; alle 2 Min Neustart ohne Heartbeat.
  Start/Stop-Knopf setzt `engine_gewollt`. `modules/sitzungsCheck.ts` läuft als erster Engine-Job:
  Feed aufrufen, bei Login/Checkpoint/Authwall → `governor.pause()` + `linkedin_connected=0`.
  NICHT live gegen LinkedIn getestet (Mac-App lief parallel) – beim ersten Serverstart Log prüfen.
- **Sitzungs-Umzug = storageState, NICHT Profilordner-Kopie** (`scripts/umzug.ts`, `npm run umzug --
  export|import`). Grund, gemessen in playwright-core: Chromium läuft auf dem Mac mit
  `--use-mock-keychain`, auf Linux mit `--password-store=basic` → die Cookie-DB ist je Plattform
  anders verschlüsselt, kopierte Dateien ergäben eine leere Anmeldung. Der Export ist eigenständig
  (importiert weder config.ts noch db), liest den userData-Ordner der App, filtert auf
  `*.linkedin.com`, verlangt `li_at`, verweigert bei laufender App (`--trotzdem`). Import entfernt
  Mac-Pfadzeilen aus der `.env` (dort standen `SESSION_DIR`/`DB_PATH`), überschreibt Vorhandenes nur
  mit `--ueberschreiben`, prüft die Sitzung mit EINEM Feed-Aufruf (`--ohne-pruefung` für Tests).
- **Docker:** `mcr.microsoft.com/playwright:v1.61.1-noble` (Node 24, exakt die Playwright-Version aus
  package.json – bei Playwright-Update Tag mitziehen). Läuft als root, Playwright setzt `--no-sandbox`
  selbst. `shm_size` 512m + `--disable-dev-shm-usage` (nur Server-Modus, session.ts). `env_file:
  ./data/.env`, Volume `./data:/data`, `TZ=Europe/Berlin`. Image enthält NIE Daten (.dockerignore).
  Docker ist auf dem Mac nicht installiert → Build wurde NICHT lokal geprüft.

## TAGES-/WOCHENBERICHT (2026-09-22) — `modules/berichte.ts`
`bericht("tag"|"woche", datum)` rechnet EINEN Zeitraum (Tag bzw. Kalenderwoche Mo–So, lokale Zeit)
plus Vergleichszeitraum davor, nichts wird gespeichert. Quellen: `actions` (Anfragen/Nachrichten/
Kommentare), `crm_stage_events` (found/accepted/messaged/replied+reply_quality/qualified/meeting/won),
`drafts`. Quoten darin sind EREIGNIS-Quoten im Zeitraum (Annahmen der Woche ÷ Anfragen der Woche),
bewusst nicht die Kohorten-Quoten der Wirkungs-Auswertung. API `GET /api/bericht?art=&datum=`;
Cockpit-Panel „Bericht“ in der Auswertung (eigener Ladepfad `ladeBericht` mit laufender Nummer wie
`ladeWirkung`). Telegram: Cron 22:05 `bericht:tag`, Montag START_STUNDE+10 `bericht:woche` (Vorwoche),
Befehle /tag /woche /vorwoche; die KI-Trefferquoten-Bilanz heißt jetzt /bilanz bzw. /kibilanz.
Geschäftszeit seit 2026-09-22: 7–22 Uhr; alle Morgen-Crons hängen an `START_STUNDE` in index.ts.

## UPDATE 2026-09-25 — ZIELGRUPPEN steuern Sammeln UND Ansprache
Auslöser: automatische Erstnachrichten an Filialleiter, Geschäftsstellenleiter und Bankkaufleute mit
20 Berufsjahren („wie ging's nach der Ausbildung weiter?“). Vor der Erstnachricht gab es keinerlei
Zielgruppen-Schranke; der alte „Fokus“ steuerte nur, welche Quellen durchsucht werden.
Sinans Vorgabe: Zielgruppe bestimmen → daraus Leads sammeln → nur sie anschreiben; Ändern/Pausieren
stoppt den Versand an sie; mehrere gleichzeitig möglich.
- **Regel an EINER Stelle:** `core/zielgruppenRegel.ts` (rein, Wörterlisten statt Regex: Erkennung
  = mind. ein Wort, Ausschluss = keins, optional max. Jahre im aktuellen Job aus Profil-Fakten
  `seit`). `db/index.ts` registriert sie als SQLite-Funktion `zg_passt`; `zgBedingung(alias)` ist der
  SQL-Baustein für JEDE Auswahl automatischer Ansprache: `nextNewContacts`, Acceptance-Nachholung,
  `messagedAwaitingFollowup`, `reaktivierbareKontakte`, `autoFreigabe`, `sendApprovedDrafts` (nur
  auto-freigegebene), `leadBewertung`, Warteschlangen-Zahlen. Einzelprüfung vor
  `deliverFirstMessage`: `zielgruppenPruefung(contactId)` mit Klartext-Grund im Log. Die UDF darf
  KEINE Abfragen machen (better-sqlite3 verbietet das während einer laufenden Abfrage) – alle Werte
  kommen als Argumente. NEUE AUSWAHL-ABFRAGEN FÜR AUTOMATISCHE ANSPRACHE BRAUCHEN `zgBedingung`.
- **Bewusst NICHT gesperrt:** Antworten in laufenden Gesprächen (Agent, `message`-Entwürfe), alles was
  Sinan selbst freigibt/sendet (Telegram „Senden“, `freigabe_quelle='mensch'`), „Wiederbeleben“-Knopf.
- **Zuordnung** `contacts.zielgruppe_id`: aus der Quelle beim ersten Fund (eingefroren wie
  `source_id`), sonst `ordneZielgruppenZu()` über die Regel (Start + alle 10 Min + Cockpit-Abruf).
  Wer nirgends passt, bleibt NULL = nie automatisch angeschrieben. `lead_sources.zielgruppe_id`:
  durchsucht werden NUR Quellen aktiver Zielgruppen (ersetzt `getFocus` in leadFeed.ts).
  Erststart-Migration legt „Azubis“ (aktiv) und „Studenten“ (aktiv nur bei Fokus student/beides) an.
  ACHTUNG: Missions-Quellen (`createMission`, Kampagnen-Bereich, derzeit aus) bekommen keine
  Zielgruppe → werden nicht durchsucht, bis man sie im Cockpit zuordnet.
- **Erstnachricht je Zielgruppe** (`zielgruppen.erstnachricht`, NULL = `STANDARD_ERSTNACHRICHT`):
  Aufbau + Beispiele, im Cockpit editierbar, „Mit KI verbessern“ (speichert nie selbst) und „Probe
  schreiben“ (3 echte Kontakte, nichts gesendet/gespeichert; `firstMessage(..., aufbauOverride)`).
  Standard jetzt OHNE „nützlichen Gedanken“ (las sich wie Pitch-Vorbereitung); feste Regel + schlechtes
  Beispiel gegen Lebensweisheiten im Code. Eigene Anleitung = kein Stil-Test (`waehleArm` entfällt).
- **Cockpit:** Einstellungen → „Zielgruppen“ (Liste mit Schalter, Zahlen passend/wartend/angeschrieben,
  Editor mit „Wirkung prüfen“-Vorschau), Lead-Quellen mit Zielgruppen-Auswahl. Blockade-Hinweis, wenn
  keine Zielgruppe aktiv ist. API `POST /api/zielgruppe` (save|aktiv|delete|vorschau|ki|probe),
  `/api/source` action zielgruppe|toggle.
- **TEST-FALLE (gefunden am selben Tag):** `empfaengerName.test.ts` lief OHNE eigene `DB_PATH` und
  schrieb bei jedem Testlauf `verlauf_belege="00000"` in die ECHTE DB → Cockpit-Warnung „0 von 5
  Versänden im Verlauf“ ohne einen einzigen Versand. JEDER Test, der Module mit DB importiert, setzt
  `DB_PATH` auf ein Temp-Verzeichnis VOR dem ersten Import. Tests im Container nur mit eigenem
  `/data`-Mount laufen lassen (`docker compose run -v /tmp/leer:/data …`), nie per `exec` im
  laufenden Container. `core/testZielgruppe.ts` stellt in Tests, die etwas anderes prüfen, alle
  Kontakte in eine offene Zielgruppe.
- Tests: `src/core/zielgruppen.test.ts` (6 Fälle). Gesamt 161 grün (+ updateCheck, der im
  Server-Image mangels `desktop/` nicht laufen kann), `tsc --noEmit` sauber.

## UPDATE 2026-09-23 — Vertrieblicher (Hormozi), Warteschlange, Selbstlernen
Sinans Vorgabe: „Nachrichten besser und vertrieblicher, im Hintergrund muss mehr gehen.“
Fünf Phasen, alle live. Leitplanken unverändert: Versand nur über den Governor, Caps und
Lese-Budget nicht angehoben, Messregeln von `crm_stage_events`, lieber kein Entwurf als ein falscher.
- **SERVER-DNS.** Proxmox trägt im LXC nur Tailscale-MagicDNS ein; fiel das aus, scheiterte JEDER
  Job mit `ERR_NAME_NOT_RESOLVED`/`page.goto Timeout`. `dns:` in docker-compose.yml (Router + 1.1.1.1)
  und auf dem Host `nameserver 192.168.0.1` vor dem PVE-Block.
- **WARTESCHLANGE** (`modules/warteschlange.ts`, Block „Was noch rausgeht“ auf „Heute“): je Kanal
  Status mit Grund, nächster Versuch, Tageslimit, wartende Entwürfe, nächste fünf Kontakte. Der Grund
  kommt aus `governor.canDoAction()` – dieselbe Prüfung wie beim echten Versand, nie nachgebaut.
- **AUSBILDUNGSSTAND** (`core/ausbildungsStand.ts`): „Bankkaufmann bei X“ ist der ABSCHLUSS. Fester
  Code (nicht die KI) bestimmt in_ausbildung/nicht/unklar; harte Prompt-Vorgabe + Nachprüfung
  (`behauptetLaufendeAusbildung`, ein Neuversuch, sonst kein Entwurf). Quelle ist die frische Rolle
  aus den Profil-Fakten, sonst die Headline.
- **ANGEBOT** (`modules/angebot.ts`, Cockpit-Karte „Dein Angebot“, `/api/angebot`): strukturierte
  Lead Magnets im Profil (`leadMagnete[{route: karriere|finanzen, nutzen, ablauf, cta, …}]`, `beweise`,
  `buchungslink`). `getProfil()` lädt bei Dateiänderung neu (Dashboard und Engine sind getrennte
  Prozesse). Der Agent wählt in den Angebotsphasen nach Signal (vorher IMMER Potenzialanalyse, auch bei
  Geldfragen) und bekommt zwei ECHTE Terminvorschläge (`zweiTermine`) bzw. den Buchungslink.
  Angeboten wird nur, was aktiv ist; Unterlagen nur mit Link. Speichern fasst nur diese drei Felder an.
- **PLAYBOOK** (`modules/playbook.ts`): Nachfass-Plan einstellbar (State `followup_plan`, 1–3 Stufen,
  2–30 Tage, letzte IMMER `abschied`), Zwecke wert/beweis/anknuepfen/abschied statt „wollte nochmal
  nachfragen“. Stufe am Entwurf eingefroren (`drafts.sequence_stage`); `followupStufe()` ist die eine
  Quelle (vorher schickte die Voll-Automatik Stufe 2 als Stufe 1). Erstnachricht: Bezug MIT einem
  nützlichen Gedanken, dann eine leichte Frage – weiter kein Pitch, kein Link.
- **AUSGANGSPRÜFUNG** (`core/ausgehendCheck.ts`): Fragenzahl, Länge, Emoji, Gedankenstrich, Floskeln
  und Verkaufssprache (Listen aus dem Agent-Validator exportiert), Platzhalter, falsche Anrede, nicht
  hinterlegte Links. `drafts.mitAusgangsCheck`: ein Neuversuch mit den Gründen, sonst kein Entwurf.
- **FREIGABE-STAU** (`modules/freigabe.ts`): `pendingDrafts()` nach Wert sortiert; ungeprüfte
  Nachfassungen verfallen nach 10 Tagen (`expired`, blockiert nichts, kein Lernsignal);
  Schnellprüfung mit Häkchen + `/api/drafts/bulk`; Tastenkürzel A/R/J/K. AUTOMATISCHE FREIGABE ist
  Opt-in (Standard AUS): Karenz, Ausgangsprüfung, Tageslimit und „verdientes Vertrauen“ (≥10 eigene
  Entscheidungen, ≥80 % UNVERÄNDERT genehmigt). `drafts.freigabe_quelle` trennt mensch/auto – die
  Automatik erzeugt weder Lernsignale noch eigenes Vertrauen. Läuft in index.ts vor jedem
  `sendApprovedDrafts`; gesendet wird unverändert über den Governor.
- **SELBSTLERNEN** (`modules/varianten.ts`, Tabelle `message_variants`, Panel „Was wirkt“): 2–3 Stile
  je Slot, Thompson Sampling auf POSITIVE Antworten. Regeln wie beim Funnel: fachlicher Dedupe-Key
  `variant:contact:<id>:<kind>:<stufe>`, Zuordnung beim Schreiben eingefroren, Antwort/Termin genau
  einmal über den Hook in `recordCrmStage` an die letzte Variante VOR dem Ereignis. Misserfolg erst
  nach 10 Tagen ohne Antwort; mind. 15 ausgewertete Versände je Stil; Sinans Veto (≥50 % abgelehnt).
  Verbucht wird erst nach nachgewiesenem Versand. Kein Nachrichtentext gespeichert.
- **PROFIL-FAKTEN** (`modules/profilFakten.ts`, Tabelle `contact_profile_facts`): beim Vernetzen und
  Anschreiben EIN `innerText` von `main` – kein Klick, keine Navigation, Lese-Budget unberührt.
  Überschriften statt CSS-Klassen. Nur Rolle/Firma/seit/Info-Auszug (≤500 Zeichen, ohne
  Kontaktdaten/Links); beim Merge mitgenommen, beim Löschen mitgelöscht. Selektorfrei, aber NICHT
  live getestet – `engine.log` auf „[profil-fakten]“ prüfen.
- **KI-AUSBAU (gleicher Tag, Sinan: „mehr KI“)** – alle über `generateText` (Claude, bezahlt;
  `max_tokens` je Aufruf einstellbar, Sammel-JSON brauchte mehr als 1024), alle mit KI-Stub getestet:
  * `angebot.ts` `kiAngebotsVorschlaege`/`kiAngebotSchaerfen` (Hormozi-Wertformel, Tabuwörter der
    Ausgangsprüfung als Regel): speichern NIE selbst, Vorschläge sind nie automatisch aktiv. `/api/angebot/ki`.
  * `assistent.ts` – Chat unten rechts: Handbuch (Alltagssprache) + frische Lage aus denselben
    Funktionen wie das Cockpit; rein lesend; Verlauf nur im Browser-Tab. `/api/assistent`.
    NEUE FUNKTIONEN IMMER AUCH INS HANDBUCH SCHREIBEN, sonst kennt der Assistent sie nicht.
  * `coach.ts` – KI-Coach im Einzel-Prüfer: Urteil + verbesserter Text, Vorschlag läuft durch die
    Ausgangsprüfung; Übernehmen füllt nur das Textfeld. `/api/draft/coach`.
  * `kiAnalyse.ts` – Wochenanalyse (Mo START_STUNDE:20, Telegram, `/analyse`, Cockpit): laufende Woche
    + Vorwoche, Stil-Test, Ablehnungen, echte Antworten OHNE Namen → 3 Empfehlungen mit Ort; der
    Prompt listet, was das Tool wirklich kann (sonst empfahl sie Nicht-Existentes).
  * `leadBewertung.ts` – stündlich (:40) bis 60 neue Kontakte in 20er-Gruppen: `contacts.ki_score/
    ki_fit/ki_grund`; Outreach + Warteschlange sortieren danach; nur `keiner` UND Note < 20 → skipped.
  * `kiStile.ts` – Mo START_STUNDE:30: bei klarem Gewinner (≥30 reif, ≥80 % Chance) EIN
    KI-Herausforderer je Slot (`variant_arme_ki`), klarer Verlierer (≥40 reif, <5 %) wird beendet.
    `varianten.armeFuer()` = feste + aktive KI-Arme; Versand eines beendeten Arms zählt noch.
- **ARBEITSWEISE:** Das Repo liegt in iCloud-Dokumente; bei voller Platte werden Dateien sekundenschnell
  „dataless“ (ETIMEDOUT beim Lesen). Gearbeitet wurde in einem Klon außerhalb von iCloud, Deploy per
  Bundle. Beim Deploy das Bundle in einem EIGENEN ssh-Aufruf übertragen – `docker compose exec` frisst stdin.
- Tests: 158/158 grün, `tsc --noEmit` sauber.

## UPDATE 2026-09-22 (2) — Lautlose Neustarts sichtbar, „warum steht der Bot?"
Auslöser: „Läuft der Bot? Ich habe seit 2h nichts auf Telegram bekommen." Die Diagnose dauerte
eine SSH-Sitzung, obwohl alle Daten im System lagen. Zwei getrennte Ursachen, beide behoben.
- **DER GRUND EINES NEUSTARTS LANDETE IM MÜLL.** Der Watchdog (crmServer.ts) killt die Engine per
  Signal — das hinterlässt keinen Stacktrace — und schrieb seine Begründung mit `console.warn`
  nach STDOUT. stdout ist `docker logs` und wird bei jedem `docker compose up` weggeworfen;
  `engine.log` überlebt, sah die Meldung aber nie. Real gemessen: am 22.09. lief die Engine
  FÜNFMAL an (00:29, 08:14, 11:48, 12:05, 14:27), und für 08:14 + 11:48 gab es NIRGENDS eine
  Begründung. Jetzt: Tabelle `engine_neustarts` + `modules/engineWatch.ts`. Die Datenbank ist der
  einzige Ort, den Dashboard-Prozess (Watchdog) und Engine-Prozess (Telegram) teilen UND der
  einen Container-Neubau überlebt. Ablauf: Watchdog schreibt `grund/detail/letzter_job/
  heartbeat_alter` → die frisch gestartete Engine liest `offeneNeustartMeldungen()` und pusht sie
  per Event `engine:neustart` nach Telegram → `markiereNeustartsBerichtet`. `autostart` wird
  bewusst NICHT gemeldet (ein gewollter Start ist keine Störung).
- **ABSTÜRZE HINTERLASSEN JETZT EINE SPUR.** `index.ts` hatte KEINEN `unhandledRejection`-Handler —
  in Node 24 beendet eine einzige unbehandelte Promise den Prozess, und der Watchdog startete
  wortlos neu. Jetzt wird der Grund VOR dem Beenden in `engine_neustarts` geschrieben. Danach
  wird bewusst beendet: eine Engine mit unklarem Zustand darf nicht weitersenden.
- **`engine.log` ROTIERT** (8 MB, eine Vorgängerdatei). docker-compose begrenzt sorgfältig
  `max-size: 10m` — das gilt aber nur für stdout, also für die Hälfte, die nicht zählt.
- **STILLSTANDS-MELDUNG.** `stillstandGrund()` setzt zusammen, warum nichts rausgeht, in der
  Reihenfolge, in der die Sperren wirklich greifen: Not-Aus → Pause → Zeitfenster → Lese-Budget →
  offene Entwürfe → Caps. Die erste zutreffende Erklärung gewinnt. WICHTIG: offene Entwürfe
  kommen VOR den Caps, sobald Nachrichten-Kontingent frei ist — sonst liest der Nutzer
  „Cap erreicht" und wartet auf den Bot, obwohl der auf IHN wartet. Richtungswahlen
  (`phase='approach'`) zählen nicht mit, die sind nicht sendbar.
  Cron `20 <START_STUNDE>-21` meldet, wenn seit 3 h nichts rausging; EIN Merker `stillstand_gemeldet`
  (Datum|Grund) verhindert Wiederholung, statt pro Tag einen State-Schlüssel anzulegen.
  Dazu Telegram `/warum` (Alias `/stillstand`) für die Antwort auf Zuruf.
  An echten Daten geprüft: „125 Entwürfe warten auf deine Freigabe (3/16 Nachrichten heute)" —
  genau die Antwort, die gefehlt hat.
- Tests: `src/core/engineWatch.test.ts` (7 Fälle). Gesamt 111/111 grün, `tsc --noEmit` sauber.

## UPDATE 2026-09-22 — Kampagnen stillgelegt, CRM wird zum Arbeitsplatz
Sinans Vorgabe: Kampagnen raus, Leads in EINE Liste, alles penibel tracken wie in HubSpot,
angeschrieben wird weiter individuell über die bestehende Strecke.
- **KAMPAGNEN STILLGELEGT, NICHT ENTFERNT** (`config.campaigns.enabled=false`). EIN Schalter,
  sonst nichts: er gated den `campaignTick` (Start-Tick + Cron in index.ts) und über
  `dashboard.kampagnenAktiv` den Kampagnen-Bereich im Cockpit (Navigation weg, `showView`
  leitet auf „Heute" um, `renderCampaigns` läuft gar nicht erst). Module, Tabellen und vor
  allem `crm_stage_events.campaign_id` bleiben UNANGETASTET — die Zuordnung ist beim Schreiben
  eingefroren (Messregel 2) und darf nie rückwirkend verschwinden. Auf `true` zurückstellen
  reaktiviert alles ohne weitere Änderung. Geprüft: keine `kind='event'`-Entwürfe und keine
  offenen `incoming='campaign:*'` vorhanden, es wird also nichts im versteckten Bereich gefangen.
  Auch `campaignQueued`/`campaignConnections` in dashboard.ts hängen am Schalter — geplante
  Arbeit anzukündigen, die der abgeschaltete Tick nie erledigt, ist derselbe Fehler wie 2026-08-17,
  nur andersherum.
- **KONTAKTE = DIE EINE LISTE.** `view-contacts` ist jetzt die HubSpot-artige Tabelle:
  Kontakt · Status · Stufe · Score · Quelle · Letzte Berührung · Nächster Schritt · Offen ·
  Aktionen, klickbare Sortierung je Spalte (`contactSort`), waagerechter Scroll statt Quetschen.
  OHNE Klick bleibt bewusst die serverseitige Dringlichkeit (Antworten zuerst) stehen —
  ein fester Standard-Sortierschlüssel hätte genau die Priorisierung zerstört, für die „Heute" da ist.
  Neue Felder in der Kontaktabfrage (dashboard.ts): `quelle` (JOIN lead_sources), `letzte_beruehrung`,
  `offene_aufgaben`, `naechste_faelligkeit`, `notizen`.
- **ARBEITSBEREICH JE KONTAKT** (`#contact-desk`, `zeichneKontaktArbeitsbereich`) sitzt im
  vorhandenen Kontaktspur-Dialog ÜBER der Timeline — wer etwas festhält, hat den Verlauf daneben.
  Drei Blöcke: Stufe, Aufgaben, Notizen. `getConversationWorkspace` liefert dafür zusätzlich
  `notes` und `stufen` (erreichte Stufen kommen AUSSCHLIESSLICH aus `crm_stage_events`).
- **STUFE VON HAND: NUR, WAS KEIN AUTOMAT WEISS.** `setStageManually` (crmStages.ts) erlaubt
  ausschliesslich `MANUELLE_STUFEN` = qualified/meeting/won/lost/not_fit und weist
  found/suitable/invited/accepted/messaged/replied hart ab. GRUND: wer `accepted` klicken darf,
  schönt die Annahmequote, und die ganze Auswertung wäre wertlos. Geschrieben wird über
  `recordCrmStage(..., "manual")` — gleicher fachlicher Dedupe-Schlüssel, gleiches Einfrieren
  der Zuordnung, gleiches Vorwärts-Only auf `sales_outcomes`. API `POST /api/stage` gibt den
  Ablehnungsgrund unter `reason` zurück, weil der Cockpit-`post()` bei HTTP 400 wirft und
  genau diesen Schlüssel liest (sonst stünde dort nur „HTTP 400").
- **NOTIZEN** = neue Tabelle `contact_notes` + `modules/contactNotes.ts` + `POST /api/note`.
  Bewusst eigene Tabelle statt weiterer Spalte: eine Notiz ist ein EREIGNIS mit Zeitpunkt.
  `contacts.notes` (Einzelfeld aus dem Import) bleibt unangetastet. Notizen laufen über
  `backfillContactTimeline` (dedupe `note:<id>`) in die Kontaktspur.
- **AUFGABEN** waren komplett fertig, aber tot: `sales_tasks`, `salesDesk.ts` und `POST /api/task`
  existierten seit Längerem, wurden im Cockpit aber NIRGENDS aufgerufen (0 Treffer in
  command-center.js). Jetzt angebunden, inkl. Fälligkeit und rot markierter Überfälligkeit.
- **`kurzDatum()`** im Cockpit: reine Tagesangaben (`due_at` = "2026-09-25") dürfen NICHT durch
  `localDate` laufen — das hängt ein "Z" an und ergibt ein ungültiges Datum.
- Tests: `src/core/crmArbeitsbereich.test.ts` (6 Fälle, u. a. dass Bot-Tatsachen nicht setzbar
  sind und Notizen die Spur nicht verdoppeln). Gesamt 104/104 grün, `tsc --noEmit` sauber.
- Live am echten Datenbestand geprüft (Kopie via `VACUUM INTO`, nie gegen die laufende DB):
  1224 Kontakte, Sortierung, Stufe setzen, Notiz und Aufgabe schreiben, Ablehnungsgründe.

## In-App-Update (desktop/main.cjs + desktop/preload.cjs + Dashboard-Banner)
Bewusst OHNE electron-updater/Squirrel: lautloses Auto-Update auf macOS bräuchte ein bezahltes
Apple-Developer-Zertifikat (Squirrel.Mac verifiziert die Signatur; unsere Ad-hoc-Signatur reicht
NICHT). Stattdessen fragt der Hauptprozess die GitHub-Releases direkt ab (`/releases/latest`,
`istNeuer()` numerischer Semver-Vergleich gegen `app.getVersion()`) und installiert per Knopf:
- **Windows**: NSIS-Installer laden + starten (schliesst App, installiert drüber) → echtes Ein-Klick.
- **macOS**: .dmg laden + öffnen, Nutzer zieht NextLead einmal in „Programme" → Ein-Klick-Download.
`preload.cjs` gibt dem Dashboard (läuft über http, contextIsolation an) `window.nextlead`
{isApp, version, check, install, onStatus}. `crm.html` zeigt `#update-bar` nur wenn `window.nextlead`
existiert (im Browser unsichtbar). Check: 8s nach Start + alle 6h + manuell. Nur `app.isPackaged`.
WICHTIG für Releases: `mac.artifactName=NextLead-mac-${arch}.${ext}` / `win.artifactName=
NextLead-Setup-win.${ext}` = STABILE Dateinamen → Landing-Page-Links (`/releases/latest/download/
NextLead-mac-arm64.dmg` bzw. `-Setup-win.exe`) und der Update-Check (pickt per Endung) brechen NICHT
mehr beim Versionssprung. Release muss VERÖFFENTLICHT sein (nicht Draft), sonst greift `releases/latest`
weder für Download noch Update-Check.

## UPDATE 2026-08-17 — Kampagnen-Qualität, Erstkontakt-Wahrheit, Lese-Budget-Zählung
Auslöser: neun wortgleiche Event-Einladungen „Hi [Name], danke fürs Vernetzen!“, acht davon an
Kontakte, deren Erstnachricht keine sechs Minuten alt war. Dazu „Kampagnen AEC/P1 laufen nicht“.
- **KEIN STILLER VORLAGEN-VERSAND.** `inviteText` (campaignRunner.ts) wirft jetzt
  `KiNichtVerfuegbar`, statt bei KI-Ausfall die rohe Vorlage als Entwurf abzulegen. Ursache war ein
  leeres Anthropic-Guthaben — seit 2026-07-26 laufen ALLE Texte über Claude (`core/textLlm.ts`),
  ohne Guthaben entsteht kein einziger personalisierter Text. Das Ziel geht ohne Fehlversuch zurück
  auf `queued`, der Tick bricht ab (jeder weitere Versuch hätte dasselbe Ergebnis). Ein Text mit
  ungefülltem Platzhalter wird ebenso hart blockiert. REGEL: lieber kein Entwurf als ein
  wortgleicher Massentext mit sichtbarem Platzhalter.
- **PLATZHALTER-NORMALISIERUNG.** `normalisierePlatzhalter` übersetzt `[Name]`, `{{Vorname}}`,
  `<Datum>`, `%Uhrzeit%` (auch deutsche Wörter) auf die Schlüssel, die `renderMessage` kennt.
  Menschen tippen Serienbrief-Syntax; vorher blieb `[Name]` wörtlich stehen.
- **ERSTKONTAKT IST NUR EINER OHNE HISTORIE.** `conversationMemory` kannte ausschließlich
  EINGEHENDE Nachrichten → der Prüfbereich meldete „Kein früherer Gesprächskontext“, obwohl gerade
  erst geschrieben wurde. Neu: `outboundHistory(contactId)` (gesendete Entwürfe + `messaged_at`,
  Kommentare zählen nicht) steckt in `DraftContextEvidence.outbound` und im Cockpit.
  `MINDESTABSTAND_TAGE = 3` in campaignRunner.ts: wer gerade angeschrieben wurde, bekommt keine
  Einladung. Muss doch geschrieben werden, sagt `outboundContext()` der KI ausdrücklich, dass es
  KEIN Erstkontakt ist (keine Begrüßung, kein „danke fürs Vernetzen“).
- **KAMPAGNEN-FAKTEN WIRKEN JETZT AUCH AUF ERSTNACHRICHTEN.** `campaignContext(id)` ging vorher nur
  in Event-Einladungen; `firstMessage`/`reaktivierungMessage` liefen mit dem generischen
  Auftragssatz aus goals.ts (bei AEC wörtlich „erfinde keine Bedeutung für AEC“). Deshalb wirkte
  gepflegter Kampagneninhalt wie wirkungslos. Neuer Parameter `kampagnenFakten`, gesetzt über
  `auftragMitFakten()` in drafts.ts. Die Fakten steuern die ANKNÜPFUNG; erwähnt wird in Nachricht 1
  weiterhin nichts.
- **ZWEI KAMPAGNENARTEN, ZWEI ORTE FÜR DEN NACHWEIS** (`campaignArt()` in campaignWorkflow.ts).
  `event`/Legacy → eigene Entwürfe (kind='event', incoming='campaign:<id>'). `auftrag` (B1/P1/AEC)
  → `campaignTick` überspringt diese Ziele bewusst (sonst doppelte Ansprache), die Arbeit macht die
  normale Strecke (first/followup/message/reaktivierung) PLUS `contacts.messaged_at` für den
  Halb-Automatik-Versand, der ganz ohne Entwurfszeile sendet. Vorher fand der Abgleich für
  Auftrags-Kampagnen nie einen Beleg: 42 Ziele von AEC/P1 standen dauerhaft auf `queued`, und
  `dashboard.ts` versprach daraus endlos „42 Kampagnenkontakte in 10 Minuten“. `campaignQueued`
  filtert jetzt mit derselben Bedingung wie campaignTick.
- **LESE-BUDGET ZÄHLTE DOPPELT.** `framenavigated` (session.ts) feuert auch für LinkedIns
  Weiterleitung `/in/name` → `/in/name/`. Real gemessen: 60 Protokollzeilen für 30 Profile, 113 für
  72 Seiten → der Bot stand mittags mit „60/60“, obwohl er die Hälfte verbraucht hatte. `heute()`
  in leseBudget.ts zählt jetzt VERSCHIEDENE Ziele (`schluessel()`, Profile über
  `canonicalProfileUrl`). Bewusst beim LESEN korrigiert: `actions` bleibt das lückenlose
  Safety-Protokoll. CAPS UNVERÄNDERT (60/120) — das ist die Linie, an der das Konto gesperrt wurde.
- **TEST-SEAM:** `setTextGeneratorForTests()` in core/textLlm.ts. Tests, die durch die
  Entwurfs-Pipeline laufen, brauchen einen KI-Stub — vorher verließen sie sich auf genau den
  stillen Fallback, der den Vorfall verursacht hat.

## UPDATE 2026-07-24 — 3-Modul-UI, Netzwerk-Reaktivierung, zweistufige Follow-Ups
- **NAVIGATION = 3 Module** (`crm.html`, `.nav-group[data-group]` + `.nav-grp` Kopf + `.nav-sub`):
  Lead Engine (leadsuche/vernetzen/contacts) · Sales Agent (erstnachricht/gespraech/followups/
  termine) · Brand Engine (beitraege/kommentare/likes/analytics). Übersicht + Live-Ansicht stehen
  ausserhalb. `VIEWS`-Map hat pro Eintrag ein `grp`; `zeigeAnsicht()` klappt das Modul der aktiven
  Seite auf (`.open`) und markiert es (`.has-active`). Ausklappen via `max-height` (nicht grid-0fr,
  das braucht ein einzelnes Kind).
- **Modul-Views sind GEFILTERTE Sichten auf dieselben Entwürfe** (`kind`) – EINE Wahrheit, kein
  zweiter Datenpfad. Dafür wurden die Karten-Renderer aus `renderDrafts`/`renderPosts` in
  `zeichneEntwuerfe(list, grid)` / `zeichnePosts(list, grid)` ausgelagert; `renderModulViews(v)`
  zeichnet nur die aktive Seite, `aktuelleView` merkt sie fürs Nachziehen bei jedem `load()`.
- **Safety Governor**: Geschäftszeiten-Toggle sitzt jetzt DORT (`#gov-zeitfenster`), nicht mehr im
  Bot-Status. Warm-up-Anzeigen (`#st-warm-wrap`, `#m-warmlab`) werden bei 100% komplett
  ausgeblendet (Conditional Rendering) statt dauerhaft "fertig" zu zeigen. Dazu eine einklappbare
  `.safe-box` "Warum das sicher ist" (8 konkrete Schutzmechanismen) gegen die Ban-Sorge der Nutzer.
- **NETZWERK REAKTIVIEREN** (`modules/netzwerk.ts`): `scanNetzwerk()` liest die eigene Kontaktliste
  (rein lesend, KEIN Governor – wie acceptance.ts), legt Verbindungen als `status='accepted'` +
  neue Spalte `contacts.aus_netzwerk=1` an → sie verbrauchen KEIN Vernetzungs-Kontingent.
  `generateReaktivierung()` erzeugt `kind='reaktivierung'`-Entwürfe für nie angeschriebene
  Verbindungen (eigener Prompt in personalize.ts: stille Vernetzung offen ansprechen, kein Pitch).
  Auslöser: `POST /api/netzwerk` → state `netzwerk_now` → Loop alle 2 Min + wöchentlich Di 9:30.
  `sendDraft` behandelt 'reaktivierung' wie 'first' (sendMessage). Namen-Parsing aus Kartentext –
  ohne erkannten Namen wird KEIN Kontakt angelegt (Empfänger-Verifikation braucht ihn). NICHT
  live getestet – beim ersten Lauf prüfen.
- **FOLLOW-UPS ZWEISTUFIG** (vorher: genau einer, danach nie wieder). Stufe 1 nach 4 Tagen,
  Stufe 2 nach weiteren 7 Tagen (sehr kurz, ehrlicher Schlussstrich). DANACH NIE WIEDER – wer
  zweimal nicht antwortet, will nicht (Ruf + Report-Risiko). `messagedAwaitingFollowup(days, limit,
  days2)` in crm.ts kennt beide Wartezeiten; ein OFFENER Follow-up-Entwurf blockiert den nächsten.
  `followupMessage(c, stufe)` in personalize.ts. Logik gegen SQLite mit 5 Fällen verifiziert.
- OFFEN / als Nächstes: Echtzeit-Chat im Postfach, Multi-Kampagnen-Ordner (Datenmodell:
  Kampagne je Kontakt/Entwurf), Beitrags-Planer.

## UPDATE 2026-07-23 — EIN Bot, Not-Aus, Doppel-Versand-Sperre, Browser-Posten
- **EIN Regler statt zwei.** Dashboard hat jetzt EINE „Automatik-Stufe" (`#automatikseg`, 4 Stufen:
  vorschlaege/halb/agent_test/agent_live) statt der zwei verwirrenden Schalter (Modus + Sales-Agent).
  Jede Stufe setzt intern `mode` + `agent_mode` (POST /api/automatik). Ableitung im Dashboard:
  `automatikLevel()` aus (mode, agentMode). Der ALTE Autopilot (`runAutopilot`/autopilot.ts) ist
  STILLGELEGT (Cron raus) — der Sales-Agent (`agent/`) ist die EINZIGE Gesprächs-Engine. Migration
  beim Engine-Start: `mode==='full'` → semi + agent live. generateInboxDrafts-Gate jetzt nur noch
  `getAgentMode()==='off'`.
- **NOT-AUS** (`governor.setNotAus`/`notAusAktiv`, state `send_stop`): Dashboard-Knopf `#notaus-btn`
  (POST /api/notaus) blockiert JEDEN Versand mit einem Klick, UNABHÄNGIG vom Auto-Circuit-Breaker
  (`paused`) — canDoAction prüft `send_stop` ganz zuerst. Engine läuft weiter.
- **DOPPEL-VERSAND-SPERRE** (outreach.ts): persistentes `sent_ledger` (recipient + djb2-fingerprint
  + at). `tippenUndSenden` prüft `schonGesendet()` VOR dem Tippen → identische Nachricht geht in 24h
  nie zweimal an dieselbe Person; Eintrag erst nach bestätigtem Versand (`ledgerEintragen`).
  `DuplikatBlockiert extends GovernorBlocked` → alle bestehenden Catch-Blöcke behandeln es als
  „übersprungen, kein Drama", kein Resend, keine record()-Zählung.
- **POSTEN OHNE API** (`publishPostBrowser` in outreach.ts): eigene Beiträge über die Browser-Session
  (SEL.startPostBtn/postEditor/postSubmit, defensiv, NICHT live-testbar). `hatPosting` wählt nur noch
  den WEG (API `publishPost` bevorzugt, sonst Browser), schaltet Posten NICHT mehr ab. Publish-Cron
  in `einzeln("post")` + atomarer Status-Claim ('approved'→'posting'→'posted') gegen Doppel-Post +
  Ledger-Schlüssel „__eigener_post__". Post-Ideen (`generatePostIdeas`) laufen jetzt für jeden (nicht
  mehr an hatPosting gebunden) + beim Start 2 Ideen, falls keine offen. Freigabe bleibt Pflicht.

## Automatik-Modi (db state 'mode', default 'manual' + 'agent_mode', umschaltbar im Dashboard)
Historische Beschreibung — die drei `mode`-Werte existieren weiter, werden aber über die neue
Automatik-Stufe gesetzt (siehe UPDATE oben). `full` wird beim Start auf den Agent migriert.
- **manual**: vernetzt auto; Erstnachricht + Antworten + Follow-ups = Entwürfe zur Freigabe.
- **semi**: + Erstnachricht auto (deliverFirstMessage → sendMessage, Fallback Entwurf).
- **full**: (stillgelegt/migriert) früher Autopilot. `getMode()` in db/index.ts.
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
