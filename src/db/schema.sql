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
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
  status      TEXT NOT NULL DEFAULT 'running', -- running | done | failed
  detail      TEXT,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bot_activity_time ON bot_activity(started_at DESC);

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
  status      TEXT NOT NULL DEFAULT 'queued',  -- queued | awaiting_connection | drafted | sent | excluded
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(campaign_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_targets_status ON campaign_targets(campaign_id,status);

-- Einfacher Key/Value-State (z.B. globaler Pause-Schalter, Startdatum)
CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
