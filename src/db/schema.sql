-- Protokoll jeder sendenden Aktion (für Caps, Warm-up, Akzeptanzrate)
CREATE TABLE IF NOT EXISTS actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,          -- connect | message | comment | profileView
  target      TEXT,                   -- Profil-URL / URN
  status      TEXT NOT NULL DEFAULT 'done',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_actions_type_time ON actions(type, created_at);

-- Vertriebsinitiativen: Eine Kampagne bündelt Zielgruppe, Nutzenversprechen und Quellen.
-- Dadurch lässt sich später messen, welche Ansprache nicht nur Leads, sondern Gespräche erzeugt.
CREATE TABLE IF NOT EXISTS campaigns (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  audience      TEXT,
  value_prop    TEXT,
  goal          TEXT,
  kind          TEXT NOT NULL DEFAULT 'outreach', -- outreach | event
  event_url     TEXT,
  event_date    TEXT,
  audience_scope TEXT NOT NULL DEFAULT 'external', -- network | external | both
  filters_json  TEXT,
  message_template TEXT,
  daily_limit   INTEGER NOT NULL DEFAULT 10,
  event_time    TEXT,   -- z.B. "18:30 - 21:00"
  location      TEXT,   -- Ort / "Online"
  briefing      TEXT,   -- Ablauf, Referenten, Nutzen: Sachkontext für Menschen UND für die KI
  goal_code     TEXT,   -- B1 | P1 | AEC : verbindlicher Gesprächsweg dieses Auftrags
  search_brief  TEXT,   -- Freitext des Nutzers; daraus entstehen die LinkedIn-Suchquellen
  workflow_version INTEGER NOT NULL DEFAULT 1,
  entry_rules_json TEXT,
  exit_rules_json  TEXT,
  activated_at  TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at   TEXT
);

-- Wenn ein Gespräch erkennbar von seinem gewählten Ziel wegführt, hält der Bot an und meldet
-- die neue Richtung. Der Nutzer entscheidet; der Bot wechselt Ziele niemals still im Hintergrund.
CREATE TABLE IF NOT EXISTS goal_alerts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id    INTEGER,
  contact_id     INTEGER,
  thread_url     TEXT NOT NULL,
  participant    TEXT,
  current_goal   TEXT NOT NULL,
  suggested_goal TEXT,
  summary        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open', -- open | accepted | dismissed
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_alert_open_thread
  ON goal_alerts(thread_url) WHERE status='open';

-- Datenschutzfreundliche Lernspur. Sie enthält bewusst KEINE Namen, URLs oder Nachrichtentexte,
-- sondern nur abstrahierte Merkmale und Ergebnisse. Daraus entstehen lokale Prompt-Regeln und
-- optional anonyme, ausreichend große Aggregate für eine gemeinsame Wissensbasis.
CREATE TABLE IF NOT EXISTS learning_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key    TEXT UNIQUE NOT NULL,
  event_type    TEXT NOT NULL, -- approved | rejected | sent | reply | outcome
  goal_code     TEXT,          -- B1 | P1 | AEC | NULL (Altbestand)
  draft_kind    TEXT,
  intent        TEXT,
  change_key    TEXT,          -- unchanged | shorter | longer | question_removed | rewritten | ...
  reason_key    TEXT,          -- Ablehnungsgrund, niemals Freitext
  length_bucket TEXT,          -- short | medium | long
  has_question  INTEGER,
  has_cta       INTEGER,
  outcome       TEXT,          -- positive | negative | qualified | meeting | won | ...
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  synced_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_learning_goal_event ON learning_events(goal_code,event_type,created_at);

-- Kompakter, strukturierter Gesprächskontext pro Person. Anders als die Timeline ist dies der
-- aktuelle Arbeitsstand, den jede neue Ansprache vor Entwurf und Versand verbindlich prüft.
CREATE TABLE IF NOT EXISTS conversation_memories (
  contact_id        INTEGER PRIMARY KEY,
  intent            TEXT NOT NULL DEFAULT 'neutral', -- later | busy | not_interested | do_not_contact | interested | meeting | question | neutral
  last_statement    TEXT,
  commitment        TEXT,
  open_point        TEXT,
  next_contact_at   TEXT,
  source            TEXT NOT NULL,
  source_message_at TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS conversation_memory_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key        TEXT UNIQUE NOT NULL,
  contact_id        INTEGER NOT NULL,
  intent            TEXT NOT NULL,
  statement         TEXT,
  commitment        TEXT,
  open_point        TEXT,
  next_contact_at   TEXT,
  source            TEXT NOT NULL,
  source_message_at TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_events_contact ON conversation_memory_events(contact_id,source_message_at);

-- Material einer Kampagne (Flyer, Agenda, Bild) plus die vom Nutzer gepflegten Kernaussagen.
-- Die Datei liegt lokal unter config.paths.uploadDir; nur der Dateiname steht in der DB.
CREATE TABLE IF NOT EXISTS campaign_assets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'file', -- file | link
  file_name   TEXT,
  mime        TEXT,
  bytes       INTEGER,
  url         TEXT,
  summary     TEXT,   -- Kernaussagen: das ist der Teil, den die KI liest
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_campaign_assets ON campaign_assets(campaign_id);

-- A/B-Experimente vergleichen zwei Kampagnen/Varianten über echte Funnel-Ergebnisse.
-- Die Kampagnen bleiben dabei vollständig unabhängig und damit sauber attributierbar.
CREATE TABLE IF NOT EXISTS experiments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  hypothesis   TEXT,
  metric       TEXT NOT NULL DEFAULT 'reply', -- acceptance | reply | meeting
  status       TEXT NOT NULL DEFAULT 'active', -- active | paused | finished
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT
);
CREATE TABLE IF NOT EXISTS experiment_arms (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id INTEGER NOT NULL,
  campaign_id   INTEGER NOT NULL,
  label         TEXT NOT NULL,
  UNIQUE(experiment_id, campaign_id)
);
CREATE INDEX IF NOT EXISTS idx_experiment_arms_experiment ON experiment_arms(experiment_id);

-- CRM: Kontakte / Leads
CREATE TABLE IF NOT EXISTS contacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_url   TEXT UNIQUE NOT NULL,
  normalized_url TEXT,
  full_name     TEXT,
  headline      TEXT,
  status        TEXT NOT NULL DEFAULT 'new', -- new | invited | accepted | messaged | replied | closed
  notes         TEXT,
  invited_at    TEXT,
  accepted_at   TEXT,
  messaged_at   TEXT,   -- wann Erstnachricht raus (Follow-up-Timing)
  replied_at    TEXT,   -- wann der Kontakt geantwortet hat (Hot Lead)
  zielgruppe    TEXT,   -- azubi | student : steuert den Winkel der Erstnachricht (Sinan hat NICHT studiert)
  lead_score    INTEGER, -- 0-100: ICP-Passung aus Name+Headline (Priorisierung); NULL = noch nicht bewertet
  score_grund   TEXT,    -- kurze Begruendung des Scores (nachvollziehbar im Dashboard)
  campaign_id   INTEGER, -- Kampagne, aus der der Lead kam (optional für Altbestand)
  goal_code_override TEXT, -- bewusster B1/P1/AEC-Wechsel nur für diesen Kontakt
  retry_after    TEXT,   -- nach erfolglosem Profilversuch nicht bei jedem Tick erneut öffnen
  retry_reason   TEXT,
  automation_status TEXT NOT NULL DEFAULT 'active', -- active | paused | manual | excluded
  snoozed_until TEXT,    -- bis dahin keine proaktive Ansprache
  snooze_label  TEXT,    -- verständliches Zeitfenster, z.B. "Winter 2026"
  snooze_reason TEXT,    -- warum NextLead wartet
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  last_meaningful_contact_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Unveränderliche Beziehungssignale: was wurde erkannt und welche Schutzregel entstand daraus?
-- Der Nachrichtentext selbst bleibt in den bestehenden lokalen Gesprächsdaten; hier steht nur
-- die für die Steuerung notwendige, kurze Zusammenfassung.
CREATE TABLE IF NOT EXISTS relationship_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key  TEXT UNIQUE NOT NULL,
  contact_id  INTEGER NOT NULL,
  kind        TEXT NOT NULL, -- snoozed | do_not_contact | resumed | manual
  reason      TEXT,
  valid_until TEXT,
  source      TEXT NOT NULL DEFAULT 'conversation',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_relationship_events_contact ON relationship_events(contact_id,created_at);

-- Eine Person kann ueber mehrere technische Schluessel auftauchen: Profil-URL, LinkedIn-Thread
-- oder spaeter externe CRM-IDs. Alle Komponenten loesen diese Schluessel ueber dieselbe Tabelle
-- auf, statt Namen oder URL-Arten jeweils anders zu interpretieren.
CREATE TABLE IF NOT EXISTS contact_identities (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id       INTEGER NOT NULL,
  identity_type    TEXT NOT NULL, -- profile_url | thread_url | external_url
  identity_value   TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  confidence       TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | inferred
  source           TEXT NOT NULL DEFAULT 'system',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(identity_type, normalized_value)
);
CREATE INDEX IF NOT EXISTS idx_contact_identities_contact ON contact_identities(contact_id,identity_type);

-- Wenn ein Name nicht eindeutig ist, wird nicht geraten. Die offene Zuordnung erscheint als
-- Datenhinweis und kann spaeter bewusst aufgeloest werden.
CREATE TABLE IF NOT EXISTS contact_identity_conflicts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_type         TEXT NOT NULL,
  identity_value        TEXT NOT NULL,
  normalized_value      TEXT NOT NULL,
  participant           TEXT,
  candidate_contact_ids TEXT,
  reason                TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'open', -- open | resolved | ignored
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_conflicts_open
  ON contact_identity_conflicts(identity_type,normalized_value) WHERE status='open';

-- Kurze, unveraenderliche Kontaktspur. Nachrichtentexte bleiben in ihren Quelltabellen; hier
-- werden Status-, Kampagnen- und Beziehungsschritte fuer eine verlaessliche Timeline verbunden.
CREATE TABLE IF NOT EXISTS contact_timeline_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key  TEXT UNIQUE NOT NULL,
  contact_id  INTEGER NOT NULL,
  event_type  TEXT NOT NULL,
  title       TEXT NOT NULL,
  detail      TEXT,
  source      TEXT NOT NULL,
  source_id   TEXT,
  occurred_at TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contact_timeline_contact ON contact_timeline_events(contact_id,occurred_at);

-- Low-Read-Modus: nur anonyme Fingerabdrücke der sichtbaren Inbox-Vorschau. Dadurch muss ein
-- unveränderter Chat nicht alle 15 Minuten erneut geöffnet werden.
CREATE TABLE IF NOT EXISTS inbox_scan_cache (
  participant_key TEXT PRIMARY KEY,
  snippet_hash    TEXT NOT NULL,
  thread_url      TEXT,
  their_turn      INTEGER,
  last_opened_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Messbar machen, welche Navigationen der Low-Read-Modus vermieden hat.
CREATE TABLE IF NOT EXISTS read_savings (
  day   TEXT NOT NULL,
  kind  TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day,kind)
);

-- Content-Queue fürs Posting
CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft', -- draft | approved | scheduled | posted | failed
  scheduled_for TEXT,
  posted_urn    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Entwürfe für DMs/Kommentare (Gemini generiert, Mensch gibt frei, Versand über Governor)
CREATE TABLE IF NOT EXISTS drafts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id   INTEGER,
  kind         TEXT NOT NULL DEFAULT 'message', -- message | comment
  thread_url   TEXT,                            -- Konversations-/Ziel-URL (Idempotenz-Key)
  participant  TEXT,                            -- Name des Gegenübers
  incoming     TEXT,                            -- letzter eingehender Text (Kontext)
  draft        TEXT NOT NULL,                   -- aktueller Text (ggf. von Sinan editiert)
  ki_original  TEXT,                            -- was die KI URSPRUENGLICH vorschlug (nie ueberschrieben)
  intent       TEXT,                            -- chance | einwand | meeting | ... (Einordnung der KI)
  phase        TEXT NOT NULL DEFAULT 'message', -- message | approach: fertiger Text oder Richtungswahl
  parent_draft_id INTEGER,                      -- Herkunft bei Neu-Generierung
  approach_key TEXT,                            -- gewählte Gesprächsrichtung
  rejection_reason TEXT,                        -- warum dieser Entwurf abgelehnt wurde
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | approved | sent | discarded
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status, created_at);

-- Jede Ablehnung bleibt als Lernsignal erhalten. So kann eine neue Generierung nicht nur den
-- letzten Wortlaut, sondern die gesamte verworfene Richtungskette eines Kontakts vermeiden.
CREATE TABLE IF NOT EXISTS draft_feedback (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id      INTEGER NOT NULL,
  thread_url    TEXT,
  kind          TEXT NOT NULL,
  reason        TEXT NOT NULL,
  instruction   TEXT,
  rejected_text TEXT NOT NULL,
  approach_key  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_draft_feedback_thread ON draft_feedback(thread_url,kind,created_at);

-- Verständliches Arbeitsprotokoll der Engine. Anders als `actions` enthält es auch rein
-- lesende/planende Jobs wie Postfachprüfung, Kampagnenlauf und Annahmecheck.
CREATE TABLE IF NOT EXISTS bot_activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running', -- running | done | failed | timed_out | skipped | interrupted
  detail      TEXT,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bot_activity_time ON bot_activity(started_at DESC);

-- Bewusst vom Nutzer abgesendete Fehlerberichte und Feedback. Gespeichert werden ausschließlich
-- bereinigte Diagnosedaten; die lokale Warteschlange überlebt Offline-Zeiten und App-Neustarts.
CREATE TABLE IF NOT EXISTS user_reports (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id      TEXT UNIQUE NOT NULL,
  kind           TEXT NOT NULL, -- error | feedback
  message        TEXT,
  reply_email    TEXT,
  activity_job   TEXT,
  activity_detail TEXT,
  activity_at    TEXT,
  screenshot_base64 TEXT,
  screenshot_mime TEXT,
  screenshot_width INTEGER,
  screenshot_height INTEGER,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | sent
  attempts       INTEGER NOT NULL DEFAULT 0,
  next_attempt   TEXT,
  last_error     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_reports_pending ON user_reports(status,next_attempt,created_at);

-- Lead-Quellen: gespeicherte LinkedIn-Such-URLs, die der Loop automatisch abgrast.
-- cursor_page blättert seitenweise durch, damit stetig neue Leads reinkommen.
CREATE TABLE IF NOT EXISTS lead_sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT,
  search_url  TEXT UNIQUE NOT NULL,
  cursor_page INTEGER NOT NULL DEFAULT 1,
  active      INTEGER NOT NULL DEFAULT 1,
  keep_filter TEXT,                            -- optional: nur Kontakte speichern, deren Name/Headline dazu passt (Regex, i)
  zielgruppe  TEXT,                            -- azubi | student : Fokus-Steuerung + Winkel der Erstnachricht
  last_run    TEXT,
  last_added  INTEGER NOT NULL DEFAULT 0,
  campaign_id INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Autopilot: Zustand je Gespräch (voll-autonomer Modus)
CREATE TABLE IF NOT EXISTS conversations (
  thread_url  TEXT PRIMARY KEY,
  contact_id  INTEGER,
  participant TEXT,
  auto_count  INTEGER NOT NULL DEFAULT 0,          -- wie viele KI-Antworten schon raus
  status      TEXT NOT NULL DEFAULT 'active',      -- active | booked | escalated
  contact     TEXT,                                -- extrahierte Nummer/E-Mail bei Termin
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Das aktuelle vertriebliche Ergebnis eines Kontakts. Bewusst getrennt vom technischen
-- LinkedIn-Status: „geschlossen“ kann eine Absage sein, ein Gespräch kann trotzdem qualifiziert
-- oder ein Termin gebucht sein.
CREATE TABLE IF NOT EXISTS sales_outcomes (
  contact_id    INTEGER PRIMARY KEY,
  campaign_id   INTEGER,
  stage         TEXT NOT NULL, -- qualified | meeting | won | lost | not_fit
  note          TEXT,
  value_cents   INTEGER,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_outcomes_campaign ON sales_outcomes(campaign_id, stage);

-- Revisionssichere CRM-Historie: pro Kontakt und Stufe genau ein belegbares Ereignis.
-- Keine Nachrichtentexte, Namen oder URLs: Analytics braucht nur Zielweg, Stufe und Herkunft.
CREATE TABLE IF NOT EXISTS crm_stage_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key  TEXT UNIQUE NOT NULL,
  contact_id  INTEGER NOT NULL,
  goal_code   TEXT,
  stage       TEXT NOT NULL, -- messaged | replied | qualified | meeting | won | lost | not_fit
  source      TEXT NOT NULL, -- backfill | bot | agent | manual
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_crm_stage_goal ON crm_stage_events(goal_code,stage,created_at);
CREATE INDEX IF NOT EXISTS idx_crm_stage_contact ON crm_stage_events(contact_id,stage);

-- Persönliche nächste Schritte: Der Bot erkennt Signale, aber die Entscheidung und Beziehung
-- bleiben beim Menschen. Aufgaben machen diese Übergabe verbindlich und terminierbar.
CREATE TABLE IF NOT EXISTS sales_tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id   INTEGER NOT NULL,
  title        TEXT NOT NULL,
  due_at       TEXT,
  status       TEXT NOT NULL DEFAULT 'open', -- open | done
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sales_tasks_open ON sales_tasks(status, due_at);

-- Feste Zielgruppe einer Kampagne. Ein Kontakt kann historisch in mehreren Kampagnen liegen,
-- aber dieselbe Kampagne nimmt ihn nur einmal auf.
CREATE TABLE IF NOT EXISTS campaign_targets (
  campaign_id INTEGER NOT NULL,
  contact_id  INTEGER NOT NULL,
  route       TEXT NOT NULL DEFAULT 'network', -- network | external
  status      TEXT NOT NULL DEFAULT 'queued',  -- awaiting_connection | queued | generating | drafted | approved | sending | sent | completed | snoozed | excluded | failed
  reason      TEXT,
  draft_id    INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  next_attempt_at TEXT,
  completed_at TEXT,
  version     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(campaign_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_targets_status ON campaign_targets(campaign_id,status);

-- Jeder Schrittwechsel bleibt nachvollziehbar. `dedupe_key` macht Reconciliation und Neustarts
-- idempotent, selbst wenn Server und Engine denselben Zustand kurz nacheinander sehen.
CREATE TABLE IF NOT EXISTS campaign_target_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key  TEXT UNIQUE NOT NULL,
  campaign_id INTEGER NOT NULL,
  contact_id  INTEGER NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  reason      TEXT,
  source      TEXT NOT NULL,
  draft_id    INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_campaign_target_events_target ON campaign_target_events(campaign_id,contact_id,created_at);

-- Zentrale Fehlerbremse für Engine-Jobs. Wiederkehrende technische Fehler werden nicht bei jedem
-- Cron-Tick endlos wiederholt: erst Backoff, nach drei Fehlschlägen Dead-Letter mit manueller
-- Freigabe. Pro Job reicht eine Zeile; bot_activity bleibt das chronologische Betriebsprotokoll.
CREATE TABLE IF NOT EXISTS job_reliability (
  job                  TEXT PRIMARY KEY,
  status               TEXT NOT NULL DEFAULT 'ready', -- ready | backoff | dead | resolved
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  last_failed_at       TEXT,
  next_attempt_at      TEXT,
  dead_at              TEXT,
  resolved_at          TEXT,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_job_reliability_status ON job_reliability(status,next_attempt_at);

-- Einfacher Key/Value-State (z.B. globaler Pause-Schalter, Startdatum)
CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- NOTIZEN JE KONTAKT (2026-09-22). `contacts.notes` bleibt als einzelnes Importfeld bestehen;
-- hier landet jede von Hand festgehaltene Notiz MIT Zeitstempel. Ohne das gibt es keinen Ort
-- für das, was nach einem Telefonat wichtig ist, und die Kontaktspur bliebe lückenhaft.
CREATE TABLE IF NOT EXISTS contact_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contact_notes ON contact_notes(contact_id, created_at);

-- ENGINE-NEUSTARTS (2026-09-22). Vorher schrieb der Watchdog seinen Grund mit console.warn nach
-- stdout – und stdout wird bei jedem `docker compose up` weggeworfen. engine.log überlebt zwar,
-- sah die Meldung aber nie. Ergebnis: die Engine startete am 22.09. fünfmal, und für zwei dieser
-- Neustarts gab es NIRGENDS eine Begründung. Deshalb liegt der Grund jetzt in der Datenbank:
-- sie überlebt Container-Neubau und ist der einzige Ort, den beide Prozesse teilen.
-- `berichtet_at` NULL = noch nicht per Telegram gemeldet; die Engine holt das beim Start nach
-- (Telegram läuft im Engine-Prozess, der Watchdog im Dashboard-Prozess).
CREATE TABLE IF NOT EXISTS engine_neustarts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  at              TEXT NOT NULL DEFAULT (datetime('now')),
  grund           TEXT NOT NULL,   -- watchdog | absturz | autostart | manuell
  detail          TEXT,            -- Klartext oder Kopf des Stacktrace
  letzter_job     TEXT,            -- was zuletzt lief (engine_active_job)
  heartbeat_alter INTEGER,         -- Sekunden seit dem letzten Heartbeat
  berichtet_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_engine_neustarts_offen ON engine_neustarts(berichtet_at, at);
