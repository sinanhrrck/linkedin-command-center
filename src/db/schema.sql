-- Protokoll jeder sendenden Aktion (für Caps, Warm-up, Akzeptanzrate)
CREATE TABLE IF NOT EXISTS actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,          -- connect | message | comment | profileView
  target      TEXT,                   -- Profil-URL / URN
  status      TEXT NOT NULL DEFAULT 'done',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_actions_type_time ON actions(type, created_at);

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
  draft        TEXT NOT NULL,                   -- generierter Entwurf
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

-- Einfacher Key/Value-State (z.B. globaler Pause-Schalter, Startdatum)
CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
