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
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at   TEXT
);

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
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | approved | sent | discarded
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status, created_at);

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

-- Einfacher Key/Value-State (z.B. globaler Pause-Schalter, Startdatum)
CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
