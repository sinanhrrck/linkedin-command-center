import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { repairContactDuplicates } from "./dataIntegrity.js";
import { pruefeZielgruppe } from "../core/zielgruppenRegel.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const db = new Database(config.paths.dbPath);
db.pragma("journal_mode = WAL");
db.exec(readFileSync(join(__dirname, "schema.sql"), "utf-8"));

for (const [column, definition] of [
  ["screenshot_base64", "TEXT"],
  ["screenshot_mime", "TEXT"],
  ["screenshot_width", "INTEGER"],
  ["screenshot_height", "INTEGER"],
] as const) {
  try { db.exec(`ALTER TABLE user_reports ADD COLUMN ${column} ${definition}`); } catch { /* existiert */ }
}

// Leichte Migration: Spalten für bestehende DBs nachrüsten (CREATE IF NOT EXISTS
// ergänzt keine Spalten). Wirft, wenn Spalte schon da → ignorieren.
try {
  db.exec("ALTER TABLE lead_sources ADD COLUMN keep_filter TEXT");
} catch {
  /* Spalte existiert bereits */
}
try {
  db.exec("ALTER TABLE contacts ADD COLUMN messaged_at TEXT"); // wann Erstnachricht raus (für Follow-up-Timing)
} catch {
  /* Spalte existiert bereits */
}
try {
  db.exec("ALTER TABLE contacts ADD COLUMN replied_at TEXT"); // wann der Kontakt geantwortet hat (Hot Lead)
} catch {
  /* Spalte existiert schon */
}
try {
  db.exec("ALTER TABLE contacts ADD COLUMN zielgruppe TEXT"); // azubi | student -> Winkel der Erstnachricht
} catch {
  /* Spalte existiert schon */
}
try {
  // Lead-Score aus Name+Headline (kein Profilbesuch -> kein profileView-Risiko). Priorisiert
  // die begrenzten Tages-Anfragen auf die besten Leads und sortiert echten Muell aus.
  db.exec("ALTER TABLE contacts ADD COLUMN lead_score INTEGER");
} catch {
  /* Spalte existiert schon */
}
try {
  db.exec("ALTER TABLE contacts ADD COLUMN score_grund TEXT");
} catch {
  /* Spalte existiert schon */
}
// KI-Lead-Bewertung (2026-09-23, modules/leadBewertung.ts): Note, Weg, kurzer Grund.
for (const [column, definition] of [["ki_score", "INTEGER"], ["ki_fit", "TEXT"], ["ki_grund", "TEXT"], ["ki_bewertet_at", "TEXT"]] as const) {
  try { db.exec(`ALTER TABLE contacts ADD COLUMN ${column} ${definition}`); } catch { /* existiert */ }
}
try {
  db.exec("ALTER TABLE lead_sources ADD COLUMN zielgruppe TEXT"); // azubi | student -> Fokus-Steuerung
} catch {
  /* Spalte existiert schon */
}
try {
  // Der ehrlichste Qualitaetsmassstab: schickt Sinan den KI-Vorschlag unveraendert raus, war er
  // gut. Schreibt er ihn um, zeigt genau diese Aenderung, was der KI fehlt. Das Original wird
  // deshalb NIE ueberschrieben - nach einer Woche laesst sich objektiv entscheiden, ob der Bot
  // den Tuer-Moment allein fahren darf.
  db.exec("ALTER TABLE drafts ADD COLUMN ki_original TEXT");
} catch {
  /* Spalte existiert schon */
}
try {
  db.exec("ALTER TABLE drafts ADD COLUMN intent TEXT"); // Einordnung der KI (chance/einwand/...)
} catch {
  /* Spalte existiert bereits */
}
for (const [column, definition] of [
  ["phase", "TEXT NOT NULL DEFAULT 'message'"],
  ["parent_draft_id", "INTEGER"],
  ["approach_key", "TEXT"],
  ["rejection_reason", "TEXT"],
  /**
   * Warum wurde ein Entwurf blockiert bzw. warum ist sein Versand unklar? (2026-08-06)
   * Der Grund stand bisher NUR im Log. Im Cockpit hieß es bei jedem Fall gleichlautend "von der
   * Sicherheitsprüfung gestoppt" – ob ein Textproblem, ein Duplikat oder ein technischer Abbruch
   * dahintersteckte, musste aus den Rohdaten rekonstruiert werden. Genau das ist der Unterschied
   * zwischen "erneut senden hilft" und "erneut senden läuft in denselben Fehler".
   */
  ["blockiert_grund", "TEXT"],
] as const) {
  try { db.exec(`ALTER TABLE drafts ADD COLUMN ${column} ${definition}`); } catch { /* existiert */ }
}
for (const [column, definition] of [
  ["context_evidence_json", "TEXT"],
  ["context_validation", "TEXT"],
  ["context_memory_version", "INTEGER"],
  // Nachfass-Stufe (1..3) laut Plan zum Zeitpunkt der Erzeugung – eingefroren, damit eine
  // spätere Planänderung die Auswertung nicht rückwirkend umschreibt (2026-09-23).
  ["sequence_stage", "INTEGER"],
  // Wer hat freigegeben: 'mensch' (Cockpit/Telegram) oder 'auto' (modules/freigabe.ts). Getrennt,
  // damit die Automatik nie ihr eigenes Vertrauen erzeugt und Lernregeln nur Menschen folgen.
  ["freigabe_quelle", "TEXT"],
  // Gewählte Variante {slot, arm} (modules/varianten.ts) – eingefroren am Entwurf.
  ["variant_json", "TEXT"],
  ["freigegeben_at", "TEXT"],
] as const) {
  try { db.exec(`ALTER TABLE drafts ADD COLUMN ${column} ${definition}`); } catch { /* existiert */ }
}

try {
  // Aus welcher Lead-Quelle stammt der Kontakt? Fuer den Quellen-Vergleich in der Analytics
  // (welche Suche bringt die besten Annahme-/Antwortquoten). Wird beim Scrapen gesetzt;
  // Altbestand bleibt NULL (unbekannt).
  db.exec("ALTER TABLE contacts ADD COLUMN source_id INTEGER");
} catch {
  /* Spalte existiert bereits */
}

try {
  // Stammt der Kontakt aus dem BESTEHENDEN Netzwerk (schon vernetzt, nie geschrieben)?
  // Diese Leute brauchen keine Vernetzungsanfrage mehr, sondern eine Reaktivierung.
  db.exec("ALTER TABLE contacts ADD COLUMN aus_netzwerk INTEGER DEFAULT 0");
} catch {
  /* Spalte existiert bereits */
}

// Migration 2026-08-04: Ein früherer Acceptance-Backfill behandelte bestehende Verbindungen
// fälschlich wie frisch angenommene Akquise-Leads. Offene Texte bleiben erhalten, werden aber in
// den separaten, immer freizugebenden Netzwerk-Zusatz verschoben. Existiert dort bereits ein
// offener Entwurf, wird nur die doppelte First-Zeile als erledigt markiert.
db.exec(
  `UPDATE drafts
      SET status='discarded', rejection_reason='network_duplicate'
    WHERE kind='first' AND status='pending'
      AND EXISTS (SELECT 1 FROM contacts c WHERE c.profile_url=drafts.thread_url AND COALESCE(c.aus_netzwerk,0)=1)
      AND EXISTS (SELECT 1 FROM drafts r WHERE r.thread_url=drafts.thread_url AND r.kind='reaktivierung' AND r.status IN ('pending','approved','sent'));
   UPDATE drafts
      SET kind='reaktivierung', intent=COALESCE(intent,'network_addon')
    WHERE kind='first' AND status='pending'
      AND EXISTS (SELECT 1 FROM contacts c WHERE c.profile_url=drafts.thread_url AND COALESCE(c.aus_netzwerk,0)=1);`,
);

try {
  db.exec("ALTER TABLE lead_sources ADD COLUMN campaign_id INTEGER");
} catch {
  /* Spalte existiert bereits */
}
try {
  db.exec("ALTER TABLE contacts ADD COLUMN campaign_id INTEGER");
} catch {
  /* Spalte existiert bereits */
}
try {
  db.exec("ALTER TABLE contacts ADD COLUMN goal_code_override TEXT");
} catch {
  /* Spalte existiert bereits */
}
try {
  db.exec("ALTER TABLE contacts ADD COLUMN normalized_url TEXT");
} catch {
  /* Spalte existiert bereits */
}
for (const [column, definition] of [["retry_after", "TEXT"], ["retry_reason", "TEXT"]] as const) {
  try { db.exec(`ALTER TABLE contacts ADD COLUMN ${column} ${definition}`); } catch { /* existiert */ }
}
for (const [table, column] of [["drafts", "contact_id"], ["conversations", "contact_id"]] as const) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER`); } catch { /* existiert */ }
}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_drafts_contact ON drafts(contact_id,created_at)"); } catch { /* existiert */ }
for (const [column, definition] of [
  ["automation_status", "TEXT NOT NULL DEFAULT 'active'"],
  ["snoozed_until", "TEXT"],
  ["snooze_label", "TEXT"],
  ["snooze_reason", "TEXT"],
  ["do_not_contact", "INTEGER NOT NULL DEFAULT 0"],
  ["last_meaningful_contact_at", "TEXT"],
] as const) {
  try { db.exec(`ALTER TABLE contacts ADD COLUMN ${column} ${definition}`); } catch { /* existiert */ }
}

// Altbestand: Profil- und Thread-Entwürfe wurden historisch nicht über dieselbe URL gespeichert.
// Der eindeutige Name ist deshalb nur für diesen konservativen Aktivitäts-Backfill ein Fallback;
// bei mehrfach vorkommenden Namen wird bewusst nichts geraten.
db.exec(`
  UPDATE contacts
     SET last_meaningful_contact_at = COALESCE(
       (SELECT MAX(d.sent_at) FROM drafts d
         WHERE d.status='sent' AND d.sent_at IS NOT NULL
           AND (d.thread_url=contacts.profile_url OR d.thread_url=contacts.normalized_url
                OR (d.participant=contacts.full_name AND
                    (SELECT COUNT(*) FROM contacts same_name WHERE lower(trim(same_name.full_name))=lower(trim(contacts.full_name)))=1))),
       replied_at, messaged_at
     )
   WHERE last_meaningful_contact_at IS NULL;
`);

for (const [column, definition] of [
  ["kind", "TEXT NOT NULL DEFAULT 'outreach'"],
  ["event_url", "TEXT"],
  ["event_date", "TEXT"],
  ["audience_scope", "TEXT NOT NULL DEFAULT 'external'"],
  ["filters_json", "TEXT"],
  ["message_template", "TEXT"],
  ["daily_limit", "INTEGER NOT NULL DEFAULT 10"],
  // 2026-08-04: Kampagnen sollen echten Sachkontext tragen (Ort, Uhrzeit, Ablauf/Nutzen),
  // damit Einladungstexte und Neu-Generierungen nicht mehr raten müssen.
  ["event_time", "TEXT"],
  ["location", "TEXT"],
  ["briefing", "TEXT"],
  ["goal_code", "TEXT"],
  ["search_brief", "TEXT"],
  ["workflow_version", "INTEGER NOT NULL DEFAULT 1"],
  ["entry_rules_json", "TEXT"],
  ["exit_rules_json", "TEXT"],
  ["activated_at", "TEXT"],
] as const) {
  try { db.exec(`ALTER TABLE campaigns ADD COLUMN ${column} ${definition}`); } catch { /* existiert */ }
}
for (const [column, definition] of [
  ["draft_id", "INTEGER"],
  ["attempt_count", "INTEGER NOT NULL DEFAULT 0"],
  ["last_error", "TEXT"],
  ["next_attempt_at", "TEXT"],
  ["completed_at", "TEXT"],
  ["version", "INTEGER NOT NULL DEFAULT 0"],
] as const) {
  try { db.exec(`ALTER TABLE campaign_targets ADD COLUMN ${column} ${definition}`); } catch { /* existiert */ }
}
db.exec("UPDATE campaigns SET activated_at=COALESCE(activated_at,created_at) WHERE active=1");
// Geplante Sicherheitsstopps und saubere Neustarts sind keine Defekte. Alte Versionen haben
// beides rot als "failed" protokolliert und dadurch das Dashboard mit Scheinfehlern gefüllt.
db.exec(`UPDATE bot_activity SET status='skipped'
          WHERE status='failed' AND detail LIKE 'Tagesbudget für % erreicht (%';
         UPDATE bot_activity SET status='interrupted'
          WHERE status='failed' AND detail='Durch Neustart beendet';`);

// Bestehende Leads lassen sich automatisch ihrer Quelle und damit einer später zugeordneten
// Kampagne zuordnen. Unverknüpfte Alt-Leads bleiben bewusst unangetastet.
db.exec(
  `UPDATE contacts
      SET campaign_id = (SELECT campaign_id FROM lead_sources s WHERE s.id = contacts.source_id)
    WHERE campaign_id IS NULL
      AND source_id IS NOT NULL
      AND (SELECT campaign_id FROM lead_sources s WHERE s.id = contacts.source_id) IS NOT NULL`,
);

// MESSMODELL (Phase 5.1): Das Stufenprotokoll traegt seine Zuordnung selbst. Kampagne, Quelle
// und Ereigniszeit werden beim Schreiben eingefroren, statt sie spaeter ueber `contacts` zu
// joinen. Sonst wuerde eine spaetere Korrektur am Kontakt (andere Kampagne, geloeschte Quelle)
// rueckwirkend die Historie umschreiben und jede Auswertung waere nicht mehr belegbar.
for (const [column, definition] of [
  ["campaign_id", "INTEGER"],
  ["source_id", "INTEGER"],
  ["reply_quality", "TEXT"],
  ["occurred_at", "TEXT"],
] as const) {
  try { db.exec(`ALTER TABLE crm_stage_events ADD COLUMN ${column} ${definition}`); } catch { /* existiert */ }
}
// Altbestand kannte nur den Schreibzeitpunkt. Fuer Zeitraum-Filter ist er die einzige belegbare
// Naeherung an den Ereigniszeitpunkt; neue Ereignisse setzen occurred_at explizit.
db.exec("UPDATE crm_stage_events SET occurred_at=created_at WHERE occurred_at IS NULL");
try { db.exec("CREATE INDEX IF NOT EXISTS idx_crm_stage_attribution ON crm_stage_events(campaign_id,source_id,stage,occurred_at)"); } catch { /* existiert */ }

// Einmaliger und danach idempotenter Integritaetslauf. Der produktive Umbau legt vor dem ersten
// Lauf eine separate SQLite-Sicherung an; weitere Starts finden keine Gruppen mehr.
const integrity = repairContactDuplicates(db);
if (integrity.removed) console.info(`[daten] ${integrity.groups} doppelte Kontaktgruppen zusammengefuehrt (${integrity.removed} Altzeilen).`);
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_normalized_url ON contacts(normalized_url) WHERE normalized_url IS NOT NULL"); } catch { /* wird beim naechsten Start erneut versucht */ }

/** Rollen rund um Ausbildung und Personal – nie Zielgruppe „Azubis“ (Sinan 2026-09-25). */
const AUSBILDER_WOERTER = "Ausbilder, Ausbildungsleit, Ausbildungsbeauftragt, Ausbildungsverantwort, Ausbildungsreferent, Referent Ausbildung, Referentin Ausbildung, Ausbildungskoordinat, Ausbildungsberat, Ausbildungsbetreu, Ausbildungsmanag, Ausbildungsmarketing, Nachwuchsgewinnung, Nachwuchsförderung, Nachwuchsentwicklung, Personal, Recruiting, Prüfer, Prüfungsausschuss, Praxisanleit, Trainer, Lehrer, Dozent, Führungskraft";
// ZIELGRUPPEN (2026-09-25). `zg_passt` ist die Regel aus core/zielgruppenRegel.ts als SQL-Funktion,
// damit jede Auswahl-Abfrage direkt filtern kann. Sie bekommt alle Werte als Argumente und fragt
// selbst NICHTS ab – better-sqlite3 verbietet Abfragen innerhalb einer laufenden Abfrage.
for (const [column, definition] of [["erfahrung", "TEXT"], ["erstes_jahr", "INTEGER"]] as const) {
  try { db.exec(`ALTER TABLE contact_profile_facts ADD COLUMN ${column} ${definition}`); } catch { /* existiert */ }
}
// Der Info-Auszug enthielt bei Profilen ohne „Info“ den LinkedIn-Seitenfuß (2026-09-25 gefunden).
db.exec("UPDATE contact_profile_facts SET ueber=NULL WHERE ueber LIKE 'Barrierefreiheit%' OR ueber LIKE 'Accessibility%'");
db.function("zg_passt", (headline, rolle, seit, erfahrung, erstesJahr, erkennung, ausschluss, maxJahre) =>
  pruefeZielgruppe(
    {
      headline: headline as string | null, rolle: rolle as string | null, seit: seit as string | null,
      erfahrung: erfahrung as string | null, erstes_jahr: erstesJahr == null ? null : Number(erstesJahr),
    },
    { erkennung: erkennung as string | null, ausschluss: ausschluss as string | null, max_berufsjahre: maxJahre == null ? null : Number(maxJahre) },
  ).ok ? 1 : 0,
);
for (const tabelle of ["contacts", "lead_sources"]) {
  try { db.exec(`ALTER TABLE ${tabelle} ADD COLUMN zielgruppe_id INTEGER`); } catch { /* existiert */ }
}
/**
 * Erststart: Aus dem bisherigen „Fokus“ (azubi/student/beides) und der Quellen-Kennung zwei
 * Zielgruppen anlegen, damit nach dem Update nichts stillsteht. Nur wenn noch KEINE existiert –
 * danach gehören die Zielgruppen allein Sinan. Ausschlusswörter decken den Vorfall vom 25.09. ab.
 */
if (!(db.prepare("SELECT COUNT(*) n FROM zielgruppen").get() as { n: number }).n) {
  const fokus = (db.prepare("SELECT value FROM state WHERE key='focus'").get() as { value: string } | undefined)?.value || "azubi";
  const neu = db.prepare("INSERT INTO zielgruppen(name, aktiv, erkennung, ausschluss, max_berufsjahre) VALUES(?,?,?,?,?)");
  const azubi = Number(neu.run(
    "Azubis",
    fokus === "student" ? 0 : 1,
    "Ausbildung, Auszubildend, Azubi, Dual, Trainee, Lehrjahr, Angehend",
    `Leiter, Leitung, Manager, Direktor, Vorstand, Head of, Senior, Prokurist, Geschäftsführ, Inhaber, Recruit, Coach, Berater für, ${AUSBILDER_WOERTER}`,
    8,
  ).lastInsertRowid);
  const student = Number(neu.run(
    "Studenten",
    fokus === "azubi" ? 0 : 1,
    "Student, Studium, Studier, Bachelor, Master",
    "Professor, Dozent, Lehrbeauftragt, Recruit, Geschäftsführ, Inhaber, Coach, Alumni, Leiter, Manager, Senior",
    5,
  ).lastInsertRowid);
  db.prepare("UPDATE lead_sources SET zielgruppe_id=? WHERE zielgruppe_id IS NULL AND zielgruppe='student'").run(student);
  db.prepare("UPDATE lead_sources SET zielgruppe_id=? WHERE zielgruppe_id IS NULL").run(azubi);
}

/**
 * NACHSCHÄRFUNG „Azubis“ (2026-09-25, zweiter Schritt): Ausbilder und Personaler dürfen nie
 * angeschrieben werden. Einmalig (Merker im state): fehlende Wörter an die vorhandene Liste
 * ANHÄNGEN – Sinans eigene Änderungen bleiben –, und die Jahresgrenze von 5 auf 8, weil sie jetzt
 * ab dem frühesten Lebenslauf-Eintrag zählt (Abschluss/erste Stelle) statt ab der aktuellen Rolle.
 */
if (!db.prepare("SELECT 1 FROM state WHERE key='zielgruppen_ausbilder_v1'").get()) {
  const azubis = db.prepare("SELECT id, ausschluss, max_berufsjahre FROM zielgruppen WHERE name='Azubis'").get() as
    | { id: number; ausschluss: string | null; max_berufsjahre: number | null } | undefined;
  if (azubis) {
    const vorhanden = String(azubis.ausschluss || "").split(",").map((w) => w.trim()).filter(Boolean);
    const klein = new Set(vorhanden.map((w) => w.toLowerCase()));
    const neu = AUSBILDER_WOERTER.split(",").map((w) => w.trim()).filter((w) => w && !klein.has(w.toLowerCase()));
    db.prepare("UPDATE zielgruppen SET ausschluss=?, max_berufsjahre=CASE WHEN max_berufsjahre=5 THEN 8 ELSE max_berufsjahre END, updated_at=datetime('now') WHERE id=?")
      .run([...vorhanden, ...neu].join(", "), azubis.id);
  }
  db.prepare("INSERT OR REPLACE INTO state(key,value) VALUES('zielgruppen_ausbilder_v1', datetime('now'))").run();
}

/** Key/Value-State */
export const getState = (key: string): string | undefined =>
  (db.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | undefined)
    ?.value;

export const setState = (key: string, value: string) =>
  db.prepare(
    "INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, value);

/** Automatik-Modus: manual | semi | full. Steuert, was der Bot ohne Freigabe sendet. */
export type Mode = "manual" | "semi" | "full";
export const getMode = (): Mode => {
  const m = getState("mode");
  return m === "semi" || m === "full" ? m : "manual";
};
export const setMode = (m: Mode) => setState("mode", m);

/**
 * SALES-AGENT-Modus (der neue intelligente Kern), per Dashboard umschaltbar OHNE Neustart:
 *  - off    : Agent aus, alles läuft wie bisher (Default).
 *  - shadow : Agent denkt mit, legt nur Entwürfe an, SENDET NICHT (Beobachtung).
 *  - live   : Agent antwortet selbst (governor-gedrosselt + validiert).
 */
export type AgentMode = "off" | "shadow" | "live";
export const getAgentMode = (): AgentMode => {
  const m = getState("agent_mode");
  return m === "shadow" || m === "live" ? m : "off";
};
export const setAgentMode = (m: AgentMode) => setState("agent_mode", m);

/** Startdatum des Tools (für Warm-up-Berechnung), einmalig gesetzt. */
export function getStartDate(): Date {
  let iso = getState("start_date");
  if (!iso) {
    iso = new Date().toISOString();
    setState("start_date", iso);
  }
  return new Date(iso);
}

/**
 * FOKUS: auf welche Zielgruppen soll der Bot gerade gehen? Steuert, welche Lead-Quellen
 * abgegrast werden (leadFeed). Sinan stellt das im Dashboard ein, der Bot holt sich den
 * Nachschub dann von allein – ohne dass jemand Quellen an- und ausknipsen muss.
 * "beides" = alle Quellen. Default: azubi (Sinans Kern-Zielgruppe).
 */
export type Focus = "azubi" | "student" | "beides";

export function getFocus(): Focus {
  const v = getState("focus");
  return v === "student" || v === "beides" ? v : "azubi";
}

export function setFocus(f: Focus) {
  setState("focus", f);
}

/**
 * KATEGORIENWEISE AUTONOMIE – das Rueckgrat des Stufenmodells.
 * Statt eines Grobschalters (manual/semi/full) entscheidet pro Signal-Typ, ob der Bot
 * autonom handelt ("auto") oder Sinan uebergibt ("ask"). So laesst sich die Freigabe
 * kategorienweise anheben, sobald die Wochen-Bilanz zeigt, dass eine Kategorie sitzt –
 * genau Sinans Stufe 2 ("Kategorien, bei denen du ~immer gleich entscheidest, werden
 * freigegeben"). Greift nur im full-Modus (im Autopilot); manual/semi machen weiter Entwuerfe.
 *
 * Defaults bilden das heutige Verhalten ab: Routine + Abschiede laufen autonom, die
 * vertrieblich heiklen Momente (Tuer + Einwand) gehen erst mal zu Sinan.
 */
export type IntentKat = "absage" | "einwand" | "chance" | "positive" | "neutral";
const AUTONOMIE_DEFAULT: Record<IntentKat, "auto" | "ask"> = {
  absage: "auto",   // Abschied, nichts zu entscheiden
  neutral: "auto",  // Smalltalk
  positive: "auto", // interessiert, aber noch kein Tuer-Moment
  chance: "ask",    // DER Vertriebsmoment -> Sinans Wahl: erst beobachten
  einwand: "ask",   // heikel, ein falscher Satz verbrennt den Lead
};

export function autonomyFor(intent: string): "auto" | "ask" {
  const v = getState(`autonomy_${intent}`);
  if (v === "auto" || v === "ask") return v;
  return AUTONOMIE_DEFAULT[intent as IntentKat] ?? "ask";
}

export function setAutonomy(intent: IntentKat, val: "auto" | "ask") {
  setState(`autonomy_${intent}`, val);
}
