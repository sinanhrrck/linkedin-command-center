import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { db, getState, getMode, getFocus, getAgentMode } from "../db/index.js";
import { governor } from "../core/safetyGovernor.js";
import { leseStand } from "../core/leseBudget.js";
import { verlaufsBelegStand } from "./outreach.js";
import { config } from "../config.js";
import { pendingDrafts, approvedCount } from "./drafts.js";
import { pendingPosts } from "./content.js";
import { hotLeads } from "./crm.js";
import { listCampaigns } from "./campaigns.js";
import { openSalesTasks, salesDesk } from "./salesDesk.js";
import { getBackupStatus } from "../core/backups.js";
import { listExperiments } from "./experiments.js";
import { learningSummary } from "./learning.js";
import { crmDataQuality, goalFunnelEconomics } from "./crmStages.js";
import { funnelReport } from "./funnel.js";
import { readSavingsToday } from "./lowRead.js";
import { contactIdentityHealth } from "./contactIdentity.js";
import { sendHealthStand } from "../core/sendHealth.js";
import { openJobFailures } from "../core/jobReliability.js";

const APP_VERSION = (() => {
  try { return String(createRequire(import.meta.url)("../../package.json").version || "unbekannt"); }
  catch { return "unbekannt"; }
})();

// Pfad zur gebündelten app.asar-DATEI (nur in der gepackten App). Deren Änderungsdatum verrät ein
// frisch installiertes Update; liegt es NACH dem Engine-Start, läuft die Engine noch mit altem Code.
const ASAR_PFAD = (() => {
  try { const p = fileURLToPath(import.meta.url); const i = p.indexOf("app.asar"); return i >= 0 ? p.slice(0, i + 8) : null; }
  catch { return null; }
})();

/**
 * Läuft die Engine mit veraltetem Code, weil nach ihrem Start ein Update installiert wurde?
 * Reiner Datei-Stat der app.asar (kein asar-Content, daher kein Caching-Problem) vs. engine_started.
 */
function engineVeraltet(): boolean {
  if (!ASAR_PFAD) return false; // Dev / nicht gepackt → keine Prüfung
  try {
    const started = getState("engine_started");
    if (!started) return false;
    return statSync(ASAR_PFAD).mtimeMs > new Date(started).getTime() + 5000;
  } catch { return false; }
}

/**
 * Stellt den kompletten Dashboard-Zustand als JSON zusammen (rein lesend).
 * Quelle für das lokale CRM-Cockpit (scripts/crmServer.ts).
 */

// Reihenfolge der Pipeline-Stufen – bewusst als Funnel gedacht.
const PIPELINE = ["new", "invited", "accepted", "messaged", "replied", "closed"] as const;

type ContactRow = {
  id: number;
  full_name: string | null;
  headline: string | null;
  profile_url: string;
  status: string;
  invited_at: string | null;
  accepted_at: string | null;
  messaged_at: string | null;
  replied_at: string | null;
  aus_netzwerk: number | null;
  created_at: string;
  lead_score: number | null;
  campaign_id: number | null;
  campaign_name: string | null;
  outcome_stage: string | null;
  outcome_note: string | null;
  outcome_value_cents: number | null;
  open_draft_id: number | null;
  open_draft_kind: string | null;
  open_draft_status: string | null;
  automation_status: string | null;
  snoozed_until: string | null;
  snooze_label: string | null;
  snooze_reason: string | null;
  do_not_contact: number | null;
};

export function getDashboardData() {
  const sendHealth = sendHealthStand();
  const jobFailures = openJobFailures();
  const contacts = db
    .prepare(
      `SELECT c.id, c.full_name, c.headline, c.profile_url, c.status, c.invited_at, c.accepted_at,
              c.messaged_at,c.replied_at,c.aus_netzwerk,c.created_at,c.lead_score,c.campaign_id,ca.name AS campaign_name,
              c.automation_status,c.snoozed_until,c.snooze_label,c.snooze_reason,c.do_not_contact,
              o.stage AS outcome_stage,o.note AS outcome_note,o.value_cents AS outcome_value_cents,
              (SELECT d.id FROM drafts d WHERE d.thread_url=c.profile_url AND d.status IN ('pending','approved','sending') ORDER BY CASE d.status WHEN 'sending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,d.created_at DESC LIMIT 1) AS open_draft_id,
              (SELECT d.kind FROM drafts d WHERE d.thread_url=c.profile_url AND d.status IN ('pending','approved','sending') ORDER BY CASE d.status WHEN 'sending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,d.created_at DESC LIMIT 1) AS open_draft_kind,
              (SELECT d.status FROM drafts d WHERE d.thread_url=c.profile_url AND d.status IN ('pending','approved','sending') ORDER BY CASE d.status WHEN 'sending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,d.created_at DESC LIMIT 1) AS open_draft_status
       FROM contacts c
       LEFT JOIN campaigns ca ON ca.id=c.campaign_id
       LEFT JOIN sales_outcomes o ON o.contact_id=c.id
       ORDER BY
         CASE c.status WHEN 'replied' THEN 0 WHEN 'messaged' THEN 1 WHEN 'accepted' THEN 2
                     WHEN 'invited' THEN 3 WHEN 'new' THEN 4 ELSE 5 END,
         COALESCE(c.accepted_at, c.invited_at, c.created_at) DESC`,
    )
    .all() as ContactRow[];

  const counts: Record<string, number> = Object.fromEntries(PIPELINE.map((s) => [s, 0]));
  for (const c of contacts) counts[c.status] = (counts[c.status] ?? 0) + 1;

  // KUMULATIVER OUTREACH-Funnel: wer hat JE diese Stufe erreicht (aus den Zeitstempeln),
  // nicht wer gerade in dem Status steht. Bereits bestehende Netzwerk-Kontakte werden hier
  // bewusst ausgeschlossen: sie wurden nie eingeladen und würden sonst als Annahmen eine
  // unmögliche Quote erzeugen. Jede Folgestufe verlangt zudem explizit ihre Vorstufen.
  // Vorher zählte der Funnel den AKTUELLEN Status → "Angenommen 9" obwohl 18 angenommen
  // hatten (9 waren schon weiter zu angeschrieben/geantwortet). Das war der Zahlen-Widerspruch.
  // EINE WAHRHEIT (2026-08-12): Der Kurzüberblick liest aus demselben Ereignisprotokoll wie die
  // Auswertung. Vorher rechnete er eigenständig über Kontakt-Zeitstempel — dieselbe Kennzahl
  // konnte damit an zwei Stellen unterschiedlich aussehen. `route:"external"` hält die Definition
  // von vorher bei: bestehende Verbindungen gehören nicht in eine Vernetzungs-Conversion.
  const wirkung = funnelReport({ route: "external" });
  const funnel = [
    { stage: "gesammelt", label: "Gesammelt", count: wirkung.counts.found },
    { stage: "eingeladen", label: "Eingeladen", count: wirkung.counts.invited },
    { stage: "angenommen", label: "Angenommen", count: wirkung.counts.accepted },
    { stage: "angeschrieben", label: "Angeschrieben", count: wirkung.counts.messaged },
    { stage: "geantwortet", label: "Geantwortet", count: wirkung.counts.replied },
  ];
  // Dashboard braucht beide Wahrheiten: den historischen Funnel für Performance und die
  // aktuellen Status für die Arbeitspriorität. Sie werden bewusst getrennt ausgeliefert,
  // damit eine offene Annahme nicht wie alle jemals angenommenen Kontakte aussieht.
  const outreachOnly = "COALESCE(aus_netzwerk, 0) = 0";
  const activeAccepted = (db.prepare(`SELECT COUNT(*) n FROM contacts WHERE status='accepted' AND ${outreachOnly}`).get() as { n: number }).n;
  const activeReplies = (db.prepare(`SELECT COUNT(*) n FROM contacts WHERE status='replied' AND ${outreachOnly}`).get() as { n: number }).n;
  const closedReplies = (db.prepare(`SELECT COUNT(*) n FROM contacts WHERE status='closed' AND replied_at IS NOT NULL AND ${outreachOnly}`).get() as { n: number }).n;
  const connectEvents = (db.prepare("SELECT COUNT(*) n FROM actions WHERE type='connect'").get() as { n: number }).n;
  const uniqueConnectTargets = (db.prepare("SELECT COUNT(DISTINCT target) n FROM actions WHERE type='connect' AND target IS NOT NULL").get() as { n: number }).n;
  const metrics = {
    historical: {
      // Dieselbe Quelle wie der Funnel darüber: die KPI-Kacheln und die Kette dürfen nicht
      // auseinanderlaufen, sonst steht auf einer Seite zweimal dieselbe Kennzahl mit zwei Werten.
      invited: wirkung.counts.invited,
      accepted: wirkung.counts.accepted,
      messaged: wirkung.counts.messaged,
      replied: wirkung.counts.replied,
    },
    active: { accepted: activeAccepted, replies: activeReplies, closedReplies },
    connectEvents: { total: connectEvents, uniqueTargets: uniqueConnectTargets, duplicates: Math.max(0, connectEvents - uniqueConnectTargets) },
  };

  // Aktionen heute (lokale Zeit) pro Typ – Aktivitätspuls.
  const actionsToday = db
    .prepare(
      "SELECT type, COUNT(*) n FROM actions WHERE date(created_at,'localtime')=date('now','localtime') GROUP BY type",
    )
    .all() as { type: string; n: number }[];

  const posts = db
    .prepare("SELECT status, COUNT(*) n FROM posts GROUP BY status")
    .all() as { status: string; n: number }[];

  // Bot-Aktivität: letzte Aktionen (mit Kontaktname, falls vorhanden) + Heartbeat.
  const recentActions = db
    .prepare(
      `SELECT a.type, a.target, a.created_at, c.full_name
       FROM actions a LEFT JOIN contacts c ON c.profile_url = a.target
       ORDER BY a.created_at DESC LIMIT 30`, // 30 statt 15: der Feed fuellt jetzt die Kartenhoehe
    )
    .all() as { type: string; target: string | null; created_at: string; full_name: string | null }[];

  const heartbeat = getState("engine_heartbeat") || null;
  // Loop gilt als "arbeitend", wenn der Heartbeat < 150s alt ist.
  const engineAlive = heartbeat ? Date.now() - new Date(heartbeat).getTime() < 150_000 : false;

  // Heute erledigt: Entwürfe heute + Posts heute (Aktionen kommen aus actionsToday).
  const draftsToday = (
    db
      .prepare("SELECT COUNT(*) n FROM drafts WHERE date(created_at,'localtime')=date('now','localtime')")
      .get() as { n: number }
  ).n;
  const postsToday = (
    db
      .prepare(
        "SELECT COUNT(*) n FROM posts WHERE status='posted' AND date(created_at,'localtime')=date('now','localtime')",
      )
      .get() as { n: number }
  ).n;
  const leadsToday = (
    db
      .prepare("SELECT COUNT(*) n FROM contacts WHERE date(created_at,'localtime')=date('now','localtime')")
      .get() as { n: number }
  ).n;

  const leadSources = db
    .prepare(
      `SELECT s.id, s.label, s.search_url, s.cursor_page, s.active, s.last_added, s.last_run, s.zielgruppe,
              s.campaign_id, c.name AS campaign_name
         FROM lead_sources s LEFT JOIN campaigns c ON c.id=s.campaign_id
        ORDER BY s.created_at`,
    )
    .all() as { id: number; label: string | null; active: number; last_added: number; cursor_page: number; zielgruppe: string | null; campaign_id: number | null; campaign_name: string | null }[];

  // 7-Tage-Aktivität fürs Balkendiagramm: pro Tag connect + message (+ Rest) zählen.
  // Flache Query, im JS zu einem lückenlosen 7-Tage-Fenster (heute rechts) aufgefüllt.
  const rawWeek = db
    .prepare(
      `SELECT date(created_at,'localtime') d, type, COUNT(*) n
         FROM actions
        WHERE created_at >= datetime('now','localtime','-6 days','start of day','utc')
        GROUP BY d, type`,
    )
    .all() as { d: string; type: string; n: number }[];
  const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
  const weekActivity = Array.from({ length: 7 }, (_, i) => {
    const dt = new Date();
    dt.setDate(dt.getDate() - (6 - i));
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    const rows = rawWeek.filter((r) => r.d === key);
    const get = (t: string) => rows.find((r) => r.type === t)?.n ?? 0;
    const connect = get("connect");
    const message = get("message") + get("reply") + get("comment") + get("like");
    return { label: WD[dt.getDay()], connect, message, total: connect + message, today: i === 6 };
  });

  // 28-Tage-Verlauf fürs Linienchart: Vernetzungen (aus actions) + Annahmen (accepted_at) pro Tag.
  const dayKey = (offset: number) => {
    const dt = new Date();
    dt.setDate(dt.getDate() - offset);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  };
  const connMap = Object.fromEntries(
    (db.prepare(
      `SELECT date(created_at,'localtime') d, COUNT(*) n FROM actions
        WHERE type='connect' AND created_at >= datetime('now','localtime','-27 days','start of day','utc') GROUP BY d`,
    ).all() as { d: string; n: number }[]).map((r) => [r.d, r.n]),
  );
  const accMap = Object.fromEntries(
    (db.prepare(
      `SELECT date(accepted_at,'localtime') d, COUNT(*) n FROM contacts
        WHERE accepted_at >= datetime('now','localtime','-27 days','start of day','utc') GROUP BY d`,
    ).all() as { d: string; n: number }[]).map((r) => [r.d, r.n]),
  );
  const trend = Array.from({ length: 28 }, (_, i) => {
    const key = dayKey(27 - i);
    const d = new Date(key);
    return { date: key, label: `${d.getDate()}.${d.getMonth() + 1}.`, connect: connMap[key] ?? 0, accepted: accMap[key] ?? 0 };
  });

  // Woche-über-Woche-Deltas für die KPI-Trend-Badges (diese 7 Tage vs. die 7 davor).
  const wow = (sql: string) => {
    const cur = (db.prepare(sql).get("-7 days", "now") as { n: number }).n;
    const prev = (db.prepare(sql).get("-14 days", "-7 days") as { n: number }).n;
    return { cur, prev, delta: cur - prev };
  };
  const deltas = {
    leads: wow("SELECT COUNT(*) n FROM contacts WHERE created_at >= datetime('now',?) AND created_at < datetime('now',?)"),
    accepted: wow("SELECT COUNT(*) n FROM contacts WHERE accepted_at >= datetime('now',?) AND accepted_at < datetime('now',?)"),
    replied: wow("SELECT COUNT(*) n FROM contacts WHERE replied_at >= datetime('now',?) AND replied_at < datetime('now',?)"),
  };
  const openDrafts = pendingDrafts();
  const contactByUrl = new Map(contacts.map((contact) => [contact.profile_url, contact]));
  const contactByName = new Map<string, ContactRow>();
  for (const contact of contacts) {
    const key = String(contact.full_name || "").trim().toLocaleLowerCase("de-DE");
    if (key && !contactByName.has(key)) contactByName.set(key, contact);
  }
  const draftsForDashboard = openDrafts.map((draft) => {
    const nameKey = String(draft.participant || "").trim().toLocaleLowerCase("de-DE");
    const contact = contactByUrl.get(draft.thread_url) || contactByName.get(nameKey);
    return {
      ...draft,
      profile: contact ? {
        id: contact.id,
        fullName: contact.full_name,
        headline: contact.headline,
        profileUrl: contact.profile_url,
        status: contact.status,
        leadScore: contact.lead_score,
        campaignName: contact.campaign_name,
        networkContact: !!contact.aus_netzwerk,
      } : null,
    };
  });
  const draftCount = (...kinds: string[]) => openDrafts.filter((draft) => kinds.includes(draft.kind)).length;
  const goalDeviationDrafts = openDrafts.filter((draft) => draft.intent === "goal_deviation").length;
  const meetingAttention = (db.prepare("SELECT COUNT(*) n FROM conversations WHERE status='booked'").get() as { n: number }).n;
  const goalAlerts = db.prepare(
    `SELECT a.id,a.campaign_id campaignId,a.contact_id contactId,a.thread_url threadUrl,a.participant,
            a.current_goal currentGoal,a.suggested_goal suggestedGoal,a.summary,a.created_at createdAt,
            c.headline,ca.name campaignName
       FROM goal_alerts a
       LEFT JOIN contacts c ON c.id=a.contact_id
       LEFT JOIN campaigns ca ON ca.id=a.campaign_id
      WHERE a.status='open' ORDER BY a.created_at DESC`,
  ).all();
  // Eine Sicherheitsentscheidung (kein Interesse, Wiedervorlage, Duplikatschutz) ist kein
  // Systemfehler. Nur ein unklarer Versandstatus oder ein kaputter Sendeweg zählt hier rot.
  const systemIssues = Number(sendHealth.status === "broken") +
    (db.prepare("SELECT COUNT(*) n FROM drafts WHERE status='unknown'").get() as { n: number }).n;
  // Kampagnen-Einladungen zählen bewusst NICHT in den Arbeitskorb "Heute": sie werden in der
  // jeweiligen Kampagne geprüft, damit dort Zielgruppe, Kontext und Texte zusammen bleiben.
  const attention = {
    total: openDrafts.filter((draft) => draft.kind !== "event" && draft.intent !== "goal_deviation").length + meetingAttention + systemIssues + goalAlerts.length,
    replies: Math.max(0, draftCount("message", "pitchidee") - goalDeviationDrafts),
    firstMessages: draftCount("first"),
    followups: draftCount("followup"),
    reactivations: draftCount("reaktivierung"),
    comments: draftCount("comment"),
    eventInvites: draftCount("event"),
    meetings: meetingAttention,
    systemIssues,
    goalChanges: goalAlerts.length,
  };
  const governorState = governor.snapshot();
  const botActivity = db
    .prepare(
      `SELECT id,job,status,detail,started_at,finished_at
         FROM bot_activity
        WHERE status IN ('done','failed','timed_out')
          AND NOT (job='post' AND detail='Geprüft, nichts Neues')
        ORDER BY COALESCE(finished_at,started_at) DESC
        LIMIT 12`,
    )
    .all() as { id: number; job: string; status: string; detail: string | null; started_at: string; finished_at: string | null }[];
  const activeJob = getState("engine_active_job") || null;
  const activeActivity = activeJob
    ? db.prepare("SELECT job,detail,started_at FROM bot_activity WHERE status='running' AND job=? ORDER BY id DESC LIMIT 1")
        .get(activeJob) as { job: string; detail: string | null; started_at: string } | undefined
    : undefined;
  const approved = approvedCount();
  const campaignQueued = (db.prepare(
    `SELECT COUNT(*) n FROM campaign_targets t JOIN campaigns c ON c.id=t.campaign_id
      WHERE c.active=1 AND t.status='queued'`,
  ).get() as { n: number }).n;
  const campaignConnections = (db.prepare(
    `SELECT COUNT(*) n FROM campaign_targets t JOIN campaigns c ON c.id=t.campaign_id
      WHERE c.active=1 AND t.status='awaiting_connection'`,
  ).get() as { n: number }).n;
  const newContacts = counts.new ?? 0;
  const connectState = governorState.connect;
  const connectRemaining = Math.max(0, Number(connectState?.allowedCap || connectState?.effectiveCap || connectState?.hardCap || 0) - Number(connectState?.today || 0));
  const readBudget = leseStand();
  const upcoming: { job: string; detail: string; timing: string; blocked?: boolean }[] = [];
  if (!governorState.notAus) {
    if (approved) upcoming.push({ job: "sendApproved", detail: `${approved} freigegebene Nachricht${approved === 1 ? "" : "en"}`,
      timing: readBudget.erschoepft ? "morgen nach Rücksetzung des Lesebudgets" : "innerhalb von 10 Minuten", blocked: readBudget.erschoepft });
    if (campaignQueued) upcoming.push({ job: "campaign", detail: `${campaignQueued} Kampagnenkontakt${campaignQueued === 1 ? "" : "e"} als Entwurf vorbereiten`, timing: "innerhalb von 10 Minuten" });
    if (campaignConnections) upcoming.push({ job: "outreach", detail: `${campaignConnections} Kampagnenkontakt${campaignConnections === 1 ? " wartet" : "e warten"} auf Vernetzung`,
      timing: readBudget.erschoepft || !connectRemaining ? "morgen nach Sicherheitslimit" : "nach freiem Vernetzungskontingent", blocked: readBudget.erschoepft || !connectRemaining });
    if (newContacts && connectRemaining) upcoming.push({ job: "outreach", detail: `bis zu ${Math.min(newContacts, connectRemaining)} neue Vernetzung${Math.min(newContacts, connectRemaining) === 1 ? "" : "en"}`, timing: "innerhalb von 12 Minuten" });
    else if (newContacts && !connectRemaining) upcoming.push({ job: "outreach", detail: `${newContacts} Kontakte warten, Tageslimit erreicht`, timing: "morgen im Zeitfenster", blocked: true });
    upcoming.push({ job: getAgentMode() === "off" ? "drafts" : "agent", detail: "Neue Antworten im Postfach prüfen",
      timing: readBudget.erschoepft ? "morgen nach Rücksetzung des Lesebudgets" : "innerhalb von 15 Minuten", blocked: readBudget.erschoepft });
  }

  // PLANUNGSRECHNER: Der Nenner sind eindeutig angeschriebene Kontakte, nicht jede einzelne
  // Chatnachricht. Sonst würden Follow-ups und Antworten eine vermeintlich schlechtere Quote
  // erzeugen. Als Ergebnis zählt bewusst nur "won"; Termine und qualifizierte Kontakte sind
  // Zwischenstufen, noch kein verdienter B1/P1/AEC-Wert.
  const goalEconomics = goalFunnelEconomics();

  return {
    generatedAt: new Date().toISOString(),
    app: { version: APP_VERSION, channel: APP_VERSION.includes("beta") ? "Beta" : "Stabil" },
    engine: {
      heartbeat,
      alive: engineAlive,
      startedAt: getState("engine_started") || null,
      veraltet: engineVeraltet(),
      activeJob: getState("engine_active_job") || null,
      queuedJobs: Number(getState("engine_queue_length") || 0) || 0,
      nextJob: getState("engine_queue_next") || null,
    },
    recentActions,
    activity: {
      current: activeActivity ?? null,
      queue: {
        count: Number(getState("engine_queue_length") || 0) || 0,
        nextJob: getState("engine_queue_next") || null,
      },
      upcoming: upcoming.slice(0, 4),
      recent: botActivity,
      paused: !!governorState.notAus,
    },
    // Lese-Budget: die Kennzahl, die LinkedIn tatsächlich beobachtet. Muss sichtbar sein,
    // sonst wächst sie wieder unbemerkt (siehe core/leseBudget.ts).
    leseBudget: leseStand(),
    lowRead: readSavingsToday(),
    leadSources,
    campaigns: listCampaigns(),
    identityQuality: contactIdentityHealth(),
    goalAlerts,
    /**
     * Zuordnung Kontakt → Kampagne für das Kampagnen-CRM (2026-08-05). Bewusst als schlanke
     * Liste statt angereicherter Kontakte: Ein Kontakt kann in mehreren Kampagnen stecken, und
     * `contacts.campaign_id` hält nur die ERSTE fest. Die Wahrheit über die Zugehörigkeit steht
     * in campaign_targets. Das Cockpit verbindet beides über die Kontakt-ID.
     */
    campaignTargets: db
      .prepare(
        // `invitedAt` = wann die Einladung DIESER Kampagne nachweislich rausging. Ohne diesen
        // Zeitpunkt lässt sich eine Reaktion auf die Kampagne nicht von einer alten Antwort aus
        // dem CRM unterscheiden – genau daran ist die erste Fassung gescheitert (sie zeigte
        // Juli-Antworten als Kampagnen-Erfolg, teils für Leute ohne jede Einladung).
        `SELECT t.campaign_id campaignId, t.contact_id contactId, t.status, t.route,
                t.reason, t.last_error lastError, t.attempt_count attempts, t.draft_id draftId,
                (SELECT MAX(d.sent_at) FROM drafts d
                  WHERE d.thread_url=(SELECT profile_url FROM contacts WHERE id=t.contact_id)
                    AND d.kind='event' AND d.incoming='campaign:'||t.campaign_id AND d.status='sent') invitedAt
           FROM campaign_targets t`,
      )
      .all() as Array<{ campaignId: number; contactId: number; status: string; route: string; reason: string | null; lastError: string | null; attempts: number; draftId: number | null; invitedAt: string | null }>,
    experiments: listExperiments(),
    learning: learningSummary(),
    goalEconomics,
    crmDataQuality: crmDataQuality(),
    salesDesk: salesDesk(),
    salesTasks: openSalesTasks(),
    todayDone: { drafts: draftsToday, posts: postsToday, leads: leadsToday },
    attention,
    governor: governorState,
    // SYSTEMSTATUS + FEHLER SICHTBAR: der Selbst-Check-Zustand und was zuletzt schiefging.
    systemHealth: {
      sendeWeg: sendHealth.status,
      grund: sendHealth.reason,
      geprueft: sendHealth.checkedAt,
    },
    /**
     * WARUM STEHT ES GERADE? (2026-08-06, Sinans Kernanliegen)
     *
     * Der Bot hat heute mehrfach völlig korrekt blockiert – Checkpoint-Pause, Akzeptanz-Bremse,
     * leere Warteschlange, fehlende Freigaben – und dabei jedes Mal GESCHWIEGEN. Sichtbar war
     * nur ein Cockpit, in dem nichts passiert; die Ursache musste jedes Mal aus der Datenbank
     * gegraben werden. Diese Liste beantwortet die Frage an einer Stelle, in Klartext.
     * Rein lesend, reine Diagnose – sie ändert nichts am Verhalten.
     */
    /**
     * Blockierte und unklare Entwürfe waren bisher NUR eine Zahl im Arbeitskorb: `pendingDrafts()`
     * liefert ausschließlich 'pending', also tauchten sie nirgends auf. Man konnte sie weder
     * ansehen noch erledigen – der Zähler konnte konstruktionsbedingt nur wachsen (real auf 10).
     * Jetzt kommen sie mit Text und Grund ins Cockpit und lassen sich dort abhaken.
     */
    technischeFaelle: db.prepare(
      `SELECT id, kind, status, participant, thread_url, draft, created_at, blockiert_grund
         FROM drafts WHERE status IN ('blockiert','unknown') ORDER BY created_at DESC LIMIT 50`,
    ).all() as Array<{ id: number; kind: string; status: string; participant: string | null; thread_url: string; draft: string; created_at: string; blockiert_grund: string | null }>,
    blockaden: (() => {
      /**
       * `aktion` macht jeden Eintrag KLICKBAR (Sinans Vorgabe 2026-08-06): entweder wird die
       * Ursache direkt behoben ("sofort": Engine starten, Not-Aus lösen, Pause fortsetzen) oder
       * das Cockpit springt genau dorthin, wo man sie beheben kann ("gehe"). Erledigt sich die
       * Ursache, verschwindet der Eintrag beim nächsten Aktualisieren von selbst – die Liste
       * wird bei jedem Abruf neu berechnet, es gibt nichts zum Wegklicken.
       * `art: "warten"` = nichts zu tun, läuft von allein weiter (kein Knopf).
       */
      type Aktion =
        | { art: "sofort"; befehl: "engine_start" | "notaus_loesen" | "pause_loesen"; text: string }
        | { art: "gehe"; ziel: "today" | "settings" | "contacts" | "campaigns"; text: string }
        | { art: "kampagne"; id: number; text: string }
        | { art: "job"; name: string; text: string }
        | { art: "review"; kinds: string[]; text: string }
        | { art: "campaignReview"; id: number; text: string }
        | { art: "warten"; text: string };
      const liste: { was: string; grund: string; tun: string; aktion: Aktion }[] = [];
      if (governorState.notAus) liste.push({ was: "Jeder Versand", grund: "Not-Aus ist aktiv", tun: "Not-Aus lösen", aktion: { art: "sofort", befehl: "notaus_loesen", text: "Not-Aus lösen" } });
      if (governorState.paused) liste.push({ was: "Alle Aktionen", grund: governorState.pauseReason || "Sicherheitspause", tun: "Fortsetzen", aktion: { art: "sofort", befehl: "pause_loesen", text: "Fortsetzen" } });
      if (!engineAlive) liste.push({ was: "Alle Hintergrundarbeit", grund: "Die Engine läuft nicht", tun: "Engine starten", aktion: { art: "sofort", befehl: "engine_start", text: "Engine starten" } });
      const lese = leseStand();
      if (lese.erschoepft) liste.push({ was: "Lesen und damit fast alles", grund: lese.grund!, tun: "Läuft morgen automatisch weiter", aktion: { art: "warten", text: "Läuft morgen weiter" } });
      const acc = governorState.acceptance;
      if (acc.armed && acc.rate < config.safety.hardStopAcceptance) {
        liste.push({
          was: acc.protectionActive ? "Vernetzungen (Schutzmodus)" : "Annahmequote niedrig – Schutz ist aus",
          grund: acc.protectionActive
            ? `Annahmequote ${(acc.rate * 100).toFixed(0)}% – maximal ${acc.reducedCap} statt ${acc.normalCap} Anfragen pro Tag`
            : `Annahmequote ${(acc.rate * 100).toFixed(0)}% – derzeit gilt das normale Limit von ${acc.normalCap} Anfragen pro Tag`,
          tun: "Anfragen einstellen",
          aktion: { art: "gehe", ziel: "settings", text: "Anfragen einstellen" },
        });
      } else if (acc.armed && acc.rate < acc.minRate) {
        liste.push({ was: acc.protectionActive ? "Vernetzungen (Schutzmodus)" : "Annahmequote niedrig – Schutz ist aus", grund: acc.protectionActive ? `Annahmequote ${(acc.rate * 100).toFixed(0)}% – maximal ${acc.reducedCap} statt ${acc.normalCap} Anfragen pro Tag` : `Annahmequote ${(acc.rate * 100).toFixed(0)}% – normales Limit ${acc.normalCap} pro Tag`, tun: "Anfragen einstellen", aktion: { art: "gehe", ziel: "settings", text: "Anfragen einstellen" } });
      }
      if (sendHealth.status !== "ok") liste.push({ was: "Nachrichtenversand", grund: sendHealth.reason || "Sendeweg noch nicht geprüft", tun: "Sendeweg prüfen", aktion: { art: "gehe", ziel: "settings", text: "Sendeweg prüfen" } });
      for (const failure of jobFailures) {
        liste.push({
          was: `Hintergrundaufgabe „${failure.job}"`,
          grund: failure.status === "dead"
            ? `${failure.consecutiveFailures} technische Fehler – automatisch angehalten: ${failure.lastError || "Ursache unbekannt"}`
            : `Technischer Fehler, nächster Versuch nach Wartezeit: ${failure.lastError || "Ursache unbekannt"}`,
          tun: failure.status === "dead" ? "Nach Prüfung erneut versuchen" : "Jetzt erneut versuchen",
          aktion: { art: "job", name: failure.job, text: failure.status === "dead" ? "Erneut versuchen" : "Wartezeit aufheben" },
        });
      }
      // Zweiter Versandbeleg systematisch gebrochen? Dann meldet der Bot Erfolge, die er nicht
      // mehr nachweisen kann – der Fall, der im Juli zu falsch gemeldeten Versänden führte.
      const beleg = verlaufsBelegStand();
      if (beleg.verdaechtig) {
        liste.push({
          was: "Versandbestätigung",
          grund: `Nur ${beleg.bestaetigt} von ${beleg.geprueft} Versänden im Verlauf wiedergefunden – der Beleg-Selektor stimmt vermutlich nicht mehr`,
          tun: "Verlauf stichprobenartig prüfen",
          aktion: { art: "gehe", ziel: "settings", text: "Verlauf prüfen" },
        });
      }
      if (!approved && openDrafts.length) {
        const normaleEntwuerfe = openDrafts.filter((draft) => draft.kind !== "event");
        const ersterEvent = openDrafts.find((draft) => draft.kind === "event");
        const campaignId = Number(String(ersterEvent?.incoming || "").replace("campaign:", ""));
        const aktion: Aktion = normaleEntwuerfe.length
          ? { art: "review", kinds: ["message", "pitchidee", "first", "reaktivierung", "followup", "comment"], text: "Jetzt prüfen" }
          : Number.isInteger(campaignId) && campaignId > 0
            ? { art: "campaignReview", id: campaignId, text: "Jetzt prüfen" }
            : { art: "gehe", ziel: "campaigns", text: "Jetzt prüfen" };
        liste.push({ was: "Versand", grund: `${openDrafts.length} Entwürfe warten auf deine Freigabe`, tun: "Jetzt prüfen", aktion });
      }
      const kampagnenOhneZiel = db.prepare(
        `SELECT c.id, c.name FROM campaigns c WHERE c.active=1
           AND c.goal_code IS NULL
           AND NOT EXISTS (SELECT 1 FROM campaign_targets t WHERE t.campaign_id=c.id AND t.status='queued')`,
      ).all() as { id: number; name: string }[];
      for (const k of kampagnenOhneZiel) {
        liste.push({ was: `Kampagne „${k.name}"`, grund: "Kein Kontakt mehr in der Warteschlange", tun: "Zielgruppe bearbeiten", aktion: { art: "kampagne", id: k.id, text: "Zielgruppe bearbeiten" } });
      }
      const faelle = (db.prepare("SELECT COUNT(*) n FROM drafts WHERE status IN ('blockiert','unknown')").get() as { n: number }).n;
      if (faelle) liste.push({ was: "Vom Schutz gestoppte Entwürfe", grund: `${faelle} Nachrichten wurden bewusst nicht versendet`, tun: "Prüfen oder verwerfen", aktion: { art: "gehe", ziel: "settings", text: "Schutzfälle ansehen" } });
      return liste;
    })(),
    operations: {
      backup: getBackupStatus(),
      codeVersion: getState("engine_code_version") || null,
      processId: getState("engine_pid") || null,
    },
    jobFailures,
    sendeFehler: (() => {
      const errs = (() => {
        try {
          return db
            .prepare("SELECT teilnehmer, grund, ts FROM agent_send_errors WHERE ts >= datetime('now','-2 days') ORDER BY ts DESC LIMIT 8")
            .all() as { teilnehmer: string; grund: string; ts: string }[];
        } catch {
          return [];
        }
      })();
      const blockiert = (db.prepare("SELECT COUNT(*) n FROM drafts WHERE status='blockiert'").get() as { n: number }).n;
      const unklar = (db.prepare("SELECT COUNT(*) n FROM drafts WHERE status='unknown'").get() as { n: number }).n;
      return { letzte: errs, blockiertGesamt: blockiert, unklarGesamt: unklar };
    })(),
    pipeline: PIPELINE.map((stage) => ({ stage, count: counts[stage] ?? 0 })), // AKTUELLER Status (für Chips/Tabellenfilter)
    funnel, // KUMULATIV (für den Conversion-Funnel) – echte Stufen-Zählung
    metrics,
    totals: { contacts: contacts.length },
    actionsToday: Object.fromEntries(actionsToday.map((a) => [a.type, a.n])),
    posts: Object.fromEntries(posts.map((p) => [p.status, p.n])),
    drafts: draftsForDashboard,
    approvedCount: approvedCount(),
    postDrafts: pendingPosts(),
    weekActivity,
    trend,
    deltas,
    hotLeads: hotLeads(),
    // CHAT-ÜBERSICHT (Sinan 2026-07-27): alle Kontakte, mit denen ein Chat läuft, an EINEM Ort –
    // Überblick behalten, Chats wiederfinden, eingeschlafene wiederbeleben. Rein lesend.
    chatUebersicht: (() => {
      const offen = new Set(
        (db
          .prepare(
            "SELECT DISTINCT thread_url FROM drafts WHERE status IN ('pending','approved') AND kind IN ('message','first','followup','reaktivierung','event')",
          )
          .all() as { thread_url: string }[]).map((r) => r.thread_url),
      );
      return (
        db
          .prepare(
            `SELECT id, full_name, profile_url, headline, status, messaged_at, replied_at
               FROM contacts
              WHERE messaged_at IS NOT NULL OR replied_at IS NOT NULL OR status IN ('messaged','replied','closed')
              ORDER BY COALESCE(replied_at, messaged_at) DESC
              LIMIT 400`,
          )
          .all() as {
          id: number; full_name: string; profile_url: string; headline: string;
          status: string; messaged_at: string | null; replied_at: string | null;
        }[]
      ).map((c) => {
        const letzte = c.replied_at || c.messaged_at || null;
        const tage = letzte ? Math.floor((Date.now() - new Date(letzte.replace(" ", "T") + "Z").getTime()) / 86_400_000) : null;
        return { id: c.id, name: c.full_name, url: c.profile_url, headline: c.headline, status: c.status, letzte, tage, hatEntwurf: offen.has(c.profile_url) };
      });
    })(),
    mode: getMode(),
    agentMode: getAgentMode(),
    focus: getFocus(),
    // Wie viele Leads warten je Zielgruppe? Zeigt, ob der gewaehlte Fokus noch Sprit hat.
    fokusVorrat: Object.fromEntries(
      (db.prepare("SELECT COALESCE(zielgruppe,'?') z, COUNT(*) n FROM contacts WHERE status='new' GROUP BY z").all() as { z: string; n: number }[])
        .map((r) => [r.z, r.n]),
    ),
    bookedLeads: db
      .prepare("SELECT participant, contact, thread_url, updated_at FROM conversations WHERE status='booked' ORDER BY updated_at DESC")
      .all(),
    convStats: {
      active: (db.prepare("SELECT COUNT(*) n FROM conversations WHERE status='active'").get() as { n: number }).n,
      escalated: (db.prepare("SELECT COUNT(*) n FROM conversations WHERE status='escalated'").get() as { n: number }).n,
      booked: (db.prepare("SELECT COUNT(*) n FROM conversations WHERE status='booked'").get() as { n: number }).n,
    },
    contacts,
  };
}
