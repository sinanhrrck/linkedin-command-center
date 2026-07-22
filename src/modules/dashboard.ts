import { db, getState, getMode, getFocus, getAgentMode } from "../db/index.js";
import { governor } from "../core/safetyGovernor.js";
import { pendingDrafts, approvedCount } from "./drafts.js";
import { pendingPosts } from "./content.js";
import { hotLeads } from "./crm.js";

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
  created_at: string;
  lead_score: number | null;
};

export function getDashboardData() {
  const contacts = db
    .prepare(
      `SELECT id, full_name, headline, profile_url, status, invited_at, accepted_at, created_at, lead_score
       FROM contacts ORDER BY
         CASE status WHEN 'replied' THEN 0 WHEN 'messaged' THEN 1 WHEN 'accepted' THEN 2
                     WHEN 'invited' THEN 3 WHEN 'new' THEN 4 ELSE 5 END,
         COALESCE(accepted_at, invited_at, created_at) DESC`,
    )
    .all() as ContactRow[];

  const counts: Record<string, number> = Object.fromEntries(PIPELINE.map((s) => [s, 0]));
  for (const c of contacts) counts[c.status] = (counts[c.status] ?? 0) + 1;

  // KUMULATIVER Funnel: wer hat JE diese Stufe erreicht (aus den Zeitstempeln), nicht wer
  // gerade in dem Status steht. Nur so ist es ein echter Funnel (jede Stufe ⊆ der vorigen)
  // und die Conversion-Raten stimmen: z.B. Angenommen/Eingeladen = echte Annahmequote.
  // Vorher zählte der Funnel den AKTUELLEN Status → "Angenommen 9" obwohl 18 angenommen
  // hatten (9 waren schon weiter zu angeschrieben/geantwortet). Das war der Zahlen-Widerspruch.
  const f = db
    .prepare(
      `SELECT
         COUNT(*) AS gesammelt,
         SUM(CASE WHEN invited_at  IS NOT NULL THEN 1 ELSE 0 END) AS eingeladen,
         SUM(CASE WHEN accepted_at IS NOT NULL THEN 1 ELSE 0 END) AS angenommen,
         SUM(CASE WHEN messaged_at IS NOT NULL THEN 1 ELSE 0 END) AS angeschrieben,
         SUM(CASE WHEN replied_at  IS NOT NULL THEN 1 ELSE 0 END) AS geantwortet
       FROM contacts`,
    )
    .get() as { gesammelt: number; eingeladen: number | null; angenommen: number | null; angeschrieben: number | null; geantwortet: number | null };
  const funnel = [
    { stage: "gesammelt", label: "Gesammelt", count: f.gesammelt },
    { stage: "eingeladen", label: "Eingeladen", count: f.eingeladen ?? 0 },
    { stage: "angenommen", label: "Angenommen", count: f.angenommen ?? 0 },
    { stage: "angeschrieben", label: "Angeschrieben", count: f.angeschrieben ?? 0 },
    { stage: "geantwortet", label: "Geantwortet", count: f.geantwortet ?? 0 },
  ];

  // Aktionen heute (lokale Zeit) pro Typ – Aktivitätspuls.
  const actionsToday = db
    .prepare(
      "SELECT type, COUNT(*) n FROM actions WHERE date(created_at)=date('now','localtime') GROUP BY type",
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
      .prepare("SELECT COUNT(*) n FROM drafts WHERE date(created_at)=date('now','localtime')")
      .get() as { n: number }
  ).n;
  const postsToday = (
    db
      .prepare(
        "SELECT COUNT(*) n FROM posts WHERE status='posted' AND date(created_at)=date('now','localtime')",
      )
      .get() as { n: number }
  ).n;
  const leadsToday = (
    db
      .prepare("SELECT COUNT(*) n FROM contacts WHERE date(created_at)=date('now','localtime')")
      .get() as { n: number }
  ).n;

  const leadSources = db
    .prepare("SELECT id, label, search_url, cursor_page, active, last_added, last_run, zielgruppe FROM lead_sources ORDER BY created_at")
    .all() as { id: number; label: string | null; active: number; last_added: number; cursor_page: number; zielgruppe: string | null }[];

  // 7-Tage-Aktivität fürs Balkendiagramm: pro Tag connect + message (+ Rest) zählen.
  // Flache Query, im JS zu einem lückenlosen 7-Tage-Fenster (heute rechts) aufgefüllt.
  const rawWeek = db
    .prepare(
      `SELECT date(created_at,'localtime') d, type, COUNT(*) n
         FROM actions
        WHERE created_at >= datetime('now','localtime','-6 days','start of day')
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
    const message = get("message") + get("comment") + get("like");
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
        WHERE type='connect' AND created_at >= datetime('now','localtime','-27 days','start of day') GROUP BY d`,
    ).all() as { d: string; n: number }[]).map((r) => [r.d, r.n]),
  );
  const accMap = Object.fromEntries(
    (db.prepare(
      `SELECT date(accepted_at,'localtime') d, COUNT(*) n FROM contacts
        WHERE accepted_at >= datetime('now','localtime','-27 days','start of day') GROUP BY d`,
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

  return {
    generatedAt: new Date().toISOString(),
    engine: { heartbeat, alive: engineAlive, startedAt: getState("engine_started") || null },
    recentActions,
    leadSources,
    todayDone: { drafts: draftsToday, posts: postsToday, leads: leadsToday },
    governor: governor.snapshot(),
    pipeline: PIPELINE.map((stage) => ({ stage, count: counts[stage] ?? 0 })), // AKTUELLER Status (für Chips/Tabellenfilter)
    funnel, // KUMULATIV (für den Conversion-Funnel) – echte Stufen-Zählung
    totals: { contacts: contacts.length },
    actionsToday: Object.fromEntries(actionsToday.map((a) => [a.type, a.n])),
    posts: Object.fromEntries(posts.map((p) => [p.status, p.n])),
    drafts: pendingDrafts(),
    approvedCount: approvedCount(),
    postDrafts: pendingPosts(),
    weekActivity,
    trend,
    deltas,
    hotLeads: hotLeads(),
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
