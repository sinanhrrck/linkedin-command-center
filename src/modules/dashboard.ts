import { db, getState, getMode, getFocus } from "../db/index.js";
import { governor } from "../core/safetyGovernor.js";
import { pendingDrafts } from "./drafts.js";
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
};

export function getDashboardData() {
  const contacts = db
    .prepare(
      `SELECT id, full_name, headline, profile_url, status, invited_at, accepted_at, created_at
       FROM contacts ORDER BY
         CASE status WHEN 'replied' THEN 0 WHEN 'messaged' THEN 1 WHEN 'accepted' THEN 2
                     WHEN 'invited' THEN 3 WHEN 'new' THEN 4 ELSE 5 END,
         COALESCE(accepted_at, invited_at, created_at) DESC`,
    )
    .all() as ContactRow[];

  const counts: Record<string, number> = Object.fromEntries(PIPELINE.map((s) => [s, 0]));
  for (const c of contacts) counts[c.status] = (counts[c.status] ?? 0) + 1;

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
    .prepare("SELECT id, label, search_url, cursor_page, active, last_added, last_run FROM lead_sources ORDER BY created_at")
    .all() as { id: number; label: string | null; active: number; last_added: number; cursor_page: number }[];

  return {
    generatedAt: new Date().toISOString(),
    engine: { heartbeat, alive: engineAlive, startedAt: getState("engine_started") || null },
    recentActions,
    leadSources,
    todayDone: { drafts: draftsToday, posts: postsToday, leads: leadsToday },
    governor: governor.snapshot(),
    pipeline: PIPELINE.map((stage) => ({ stage, count: counts[stage] ?? 0 })),
    totals: { contacts: contacts.length },
    actionsToday: Object.fromEntries(actionsToday.map((a) => [a.type, a.n])),
    posts: Object.fromEntries(posts.map((p) => [p.status, p.n])),
    drafts: pendingDrafts(),
    hotLeads: hotLeads(),
    mode: getMode(),
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
