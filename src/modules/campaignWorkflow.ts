import { createHash } from "node:crypto";
import { db } from "../db/index.js";
import { proactiveDecision } from "./relationshipPolicy.js";

export type CampaignTargetStatus =
  | "awaiting_connection" | "queued" | "generating" | "drafted" | "approved" | "sending"
  | "sent" | "completed" | "snoozed" | "excluded" | "failed" | "cancelled";

type TargetRow = {
  campaign_id: number;
  contact_id: number;
  status: CampaignTargetStatus;
  route: "network" | "external";
  version: number;
  attempt_count: number;
  draft_id: number | null;
  updated_at: string;
};

const ALLOWED: Record<CampaignTargetStatus, Set<CampaignTargetStatus>> = {
  awaiting_connection: new Set(["queued", "snoozed", "excluded", "cancelled"]),
  queued: new Set(["generating", "snoozed", "excluded", "cancelled"]),
  generating: new Set(["drafted", "queued", "failed", "snoozed", "excluded", "cancelled"]),
  drafted: new Set(["approved", "sending", "queued", "failed", "snoozed", "excluded", "cancelled"]),
  approved: new Set(["sending", "queued", "failed", "snoozed", "excluded", "cancelled"]),
  sending: new Set(["sent", "approved", "failed", "snoozed", "excluded"]),
  sent: new Set(["completed"]),
  completed: new Set(),
  snoozed: new Set(["queued", "excluded", "cancelled"]),
  excluded: new Set(),
  failed: new Set(["queued", "snoozed", "excluded", "cancelled"]),
  cancelled: new Set(["queued"]),
};

function eventKey(row: TargetRow, to: CampaignTargetStatus, source: string, draftId?: number | null) {
  return createHash("sha256").update(`${row.campaign_id}|${row.contact_id}|${row.version + 1}|${row.status}|${to}|${source}|${draftId || ""}`).digest("hex");
}

function transitionInside(input: {
  campaignId: number;
  contactId: number;
  to: CampaignTargetStatus;
  reason?: string | null;
  source: string;
  draftId?: number | null;
  incrementAttempt?: boolean;
  force?: boolean;
}): boolean {
  const row = db.prepare("SELECT campaign_id,contact_id,status,route,version,attempt_count,draft_id,updated_at FROM campaign_targets WHERE campaign_id=? AND contact_id=?")
    .get(input.campaignId, input.contactId) as TargetRow | undefined;
  if (!row) return false;
  if (row.status === input.to) {
    db.prepare(`UPDATE campaign_targets SET reason=COALESCE(?,reason),draft_id=COALESCE(?,draft_id),
                 last_error=CASE WHEN ?='failed' THEN COALESCE(?,last_error) ELSE last_error END,updated_at=datetime('now')
                WHERE campaign_id=? AND contact_id=?`)
      .run(input.reason || null, input.draftId || null, input.to, input.reason || null, input.campaignId, input.contactId);
    return true;
  }
  if (!input.force && !ALLOWED[row.status]?.has(input.to)) return false;
  const changed = db.prepare(
    `UPDATE campaign_targets SET status=?,reason=?,draft_id=COALESCE(?,draft_id),
       attempt_count=attempt_count+?,last_error=CASE WHEN ?='failed' THEN ? ELSE NULL END,
       next_attempt_at=NULL,completed_at=CASE WHEN ?='completed' THEN datetime('now') ELSE completed_at END,
       version=version+1,updated_at=datetime('now')
     WHERE campaign_id=? AND contact_id=? AND version=?`,
  ).run(input.to, input.reason || null, input.draftId || null, input.incrementAttempt ? 1 : 0,
    input.to, input.reason || null, input.to, input.campaignId, input.contactId, row.version).changes;
  if (!changed) return false;
  db.prepare(
    `INSERT OR IGNORE INTO campaign_target_events
       (dedupe_key,campaign_id,contact_id,from_status,to_status,reason,source,draft_id)
     VALUES(?,?,?,?,?,?,?,?)`,
  ).run(eventKey(row, input.to, input.source, input.draftId), row.campaign_id, row.contact_id, row.status, input.to,
    input.reason || null, input.source, input.draftId || null);
  return true;
}

export function transitionCampaignTarget(input: {
  campaignId: number;
  contactId: number;
  to: CampaignTargetStatus;
  reason?: string | null;
  source: string;
  draftId?: number | null;
  incrementAttempt?: boolean;
  force?: boolean;
}): boolean {
  return db.transaction(() => transitionInside(input))();
}

/**
 * ZWEI ARTEN VON KAMPAGNEN, ZWEI ORTE FÜR DEN NACHWEIS (Sinan 2026-08-17).
 *
 * - `event`/Legacy: `campaignTick` schreibt eigene Entwürfe (kind='event', incoming='campaign:<id>').
 * - `auftrag` (B1/P1/AEC): `campaignTick` fasst diese Ziele bewusst NICHT an, sonst bekämen die
 *   Kontakte zusätzlich zur normalen Erstnachricht noch eine Kampagnennachricht. Die Arbeit
 *   erledigt die normale Pipeline (first/followup/message/reaktivierung).
 *
 * Der Abgleich suchte bisher IMMER nur nach Kampagnenentwürfen. Für Auftrags-Kampagnen fand er
 * deshalb nie einen Beleg: 42 Ziele von AEC und P1 standen dauerhaft auf 'queued', obwohl die
 * Kontakte längst vernetzt und angeschrieben waren. Das Cockpit versprach daraufhin endlos
 * „42 Kampagnenkontakte als Entwurf vorbereiten" – für Sinan sah die Kampagne tot aus.
 */
type CampaignArt = "event" | "auftrag";

export function campaignArt(campaignId: number): CampaignArt {
  const row = db.prepare("SELECT kind,goal_code FROM campaigns WHERE id=?").get(campaignId) as
    { kind: string; goal_code: string | null } | undefined;
  return row && row.goal_code && row.kind !== "event" ? "auftrag" : "event";
}

/** Alle Entwürfe, die für diese Kampagnenart als Beleg zählen. */
const BELEG_SQL: Record<CampaignArt, string> = {
  event: "kind='event' AND incoming=?",
  auftrag: "kind IN ('first','followup','message','reaktivierung') AND ?<>''",
};

function belegParam(campaignId: number, art: CampaignArt) {
  return art === "event" ? `campaign:${campaignId}` : "x";
}

function activeDraft(campaignId: number, contactId: number, art = campaignArt(campaignId)) {
  return db.prepare(
    `SELECT id,status,created_at,sent_at FROM drafts
      WHERE contact_id=? AND ${BELEG_SQL[art]}
        AND status IN ('pending','approved','sending','sent')
      ORDER BY CASE status WHEN 'sent' THEN 0 WHEN 'sending' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END,id DESC LIMIT 1`,
  ).get(contactId, belegParam(campaignId, art)) as { id: number; status: string; created_at: string; sent_at: string | null } | undefined;
}

export function reconcileCampaignTarget(campaignId: number, contactId: number): CampaignTargetStatus | null {
  const row = db.prepare(
    `SELECT t.status,t.route,t.attempt_count,t.updated_at,c.accepted_at,c.replied_at,c.messaged_at,c.automation_status,c.do_not_contact
       FROM campaign_targets t JOIN contacts c ON c.id=t.contact_id
      WHERE t.campaign_id=? AND t.contact_id=?`,
  ).get(campaignId, contactId) as { status: CampaignTargetStatus; route: "network" | "external"; attempt_count: number; updated_at: string; accepted_at: string | null; replied_at: string | null; messaged_at: string | null; automation_status: string | null; do_not_contact: number | null } | undefined;
  if (!row) return null;
  if (["completed", "excluded", "cancelled"].includes(row.status)) return row.status;

  const policy = proactiveDecision(contactId, row.route === "external" && !row.accepted_at ? "connect" : "campaign");
  if (!policy.ok && !["sent", "completed"].includes(row.status)) {
    const excluded = row.do_not_contact || row.automation_status === "excluded";
    transitionCampaignTarget({ campaignId, contactId, to: excluded ? "excluded" : "snoozed", reason: policy.reason, source: "reconcile", force: true });
    return excluded ? "excluded" : "snoozed";
  }
  const art = campaignArt(campaignId);
  const draft = activeDraft(campaignId, contactId, art);
  if (draft?.status === "sent") {
    if (row.replied_at && draft.sent_at && row.replied_at > draft.sent_at) {
      transitionCampaignTarget({ campaignId, contactId, to: "completed", reason: "Kontakt hat nach der Kampagnennachricht geantwortet", source: "reconcile", draftId: draft.id, force: true });
      return "completed";
    }
    transitionCampaignTarget({ campaignId, contactId, to: "sent",
      reason: art === "auftrag" ? "Über die normale Nachrichtenstrecke zugestellt" : "Nachricht nachweislich zugestellt",
      source: "reconcile", draftId: draft.id, force: true });
    return "sent";
  }
  if (draft) {
    const to = draft.status === "sending" ? "sending" : draft.status === "approved" ? "approved" : "drafted";
    transitionCampaignTarget({ campaignId, contactId, to,
      reason: art === "auftrag" ? "Entwurf liegt in der normalen Nachrichtenstrecke bereit" : "Aktiver Kampagnenentwurf",
      source: "reconcile", draftId: draft.id, force: true });
    return to;
  }
  /**
   * Zweiter Nachweis für Auftrags-Kampagnen: der Halb-Automatik-Versand (`deliverFirstMessage`)
   * sendet direkt und setzt nur `contacts.messaged_at` – ohne Entwurfszeile. Ohne diesen Zweig
   * blieben neun bereits angeschriebene AEC/P1-Kontakte auf 'queued' hängen (Sinan 2026-08-17).
   */
  if (art === "auftrag" && row.messaged_at && !["sent", "completed"].includes(row.status)) {
    const antwortDanach = row.replied_at && row.replied_at > row.messaged_at;
    transitionCampaignTarget({ campaignId, contactId, to: antwortDanach ? "completed" : "sent",
      reason: antwortDanach ? "Kontakt hat nach der Nachricht geantwortet" : "Direkt gesendet, ohne Entwurfsschritt",
      source: "reconcile", force: true });
    return antwortDanach ? "completed" : "sent";
  }
  if (row.status === "awaiting_connection") {
    if (row.accepted_at) transitionCampaignTarget({ campaignId, contactId, to: "queued", reason: "Vernetzung angenommen", source: "reconcile" });
    return row.accepted_at ? "queued" : row.status;
  }
  // Die KI-Erstellung kann mehrere Minuten dauern. CRM-Server und Engine sind getrennte
  // Prozesse; ein Reconcile darf einen gerade beanspruchten Kontakt deshalb nicht schon nach
  // Sekunden als Fehler markieren. Erst nach 15 Minuten gilt "generating" als verwaist.
  if (row.status === "generating") {
    const fresh = (db.prepare("SELECT ? >= datetime('now','-15 minutes') ok").get(row.updated_at) as { ok: number }).ok === 1;
    if (fresh) return "generating";
    if (row.attempt_count >= 2) {
      transitionCampaignTarget({ campaignId, contactId, to: "failed", reason: "Kein aktiver Entwurf nach zwei Versuchen – bitte prüfen", source: "reconcile", force: true });
      return "failed";
    }
    transitionCampaignTarget({ campaignId, contactId, to: "queued", reason: "Entwurfserstellung unterbrochen – wird erneut vorbereitet", source: "reconcile", force: true });
    return "queued";
  }
  const latest = db.prepare(
    `SELECT status,rejection_reason FROM drafts WHERE contact_id=? AND ${BELEG_SQL[art]}
      ORDER BY id DESC LIMIT 1`,
  ).get(contactId, belegParam(campaignId, art)) as { status: string; rejection_reason: string | null } | undefined;
  // Ein bewusst gelöschter Entwurf ist eine Nutzerentscheidung, kein technischer Fehler.
  // Ablehnungen mit Feedback dürfen dagegen einen Ersatz erhalten.
  if (["drafted", "approved", "sending", "failed"].includes(row.status) && latest?.status === "discarded") {
    const to = latest.rejection_reason ? "queued" : "cancelled";
    transitionCampaignTarget({ campaignId, contactId, to, reason: latest.rejection_reason
      ? "Abgelehnter Entwurf wird neu vorbereitet"
      : "Entwurf wurde bewusst gelöscht – kein automatischer Ersatz", source: "reconcile", force: true });
    return to;
  }
  if (["drafted", "approved", "sending"].includes(row.status)) {
    if (row.attempt_count >= 2) {
      transitionCampaignTarget({ campaignId, contactId, to: "failed", reason: "Kein aktiver Entwurf nach zwei Versuchen – bitte prüfen", source: "reconcile", force: true });
      return "failed";
    }
    transitionCampaignTarget({ campaignId, contactId, to: "queued", reason: "Entwurf fehlt – wird erneut vorbereitet", source: "reconcile", force: true });
    return "queued";
  }
  return row.status;
}

export function reconcileCampaignWorkflows(campaignId?: number): { checked: number; failed: number } {
  const targets = db.prepare(`SELECT campaign_id,contact_id FROM campaign_targets${campaignId ? " WHERE campaign_id=?" : ""}`)
    .all(...(campaignId ? [campaignId] : [])) as Array<{ campaign_id: number; contact_id: number }>;
  let failed = 0;
  for (const target of targets) if (reconcileCampaignTarget(target.campaign_id, target.contact_id) === "failed") failed++;
  return { checked: targets.length, failed };
}

/** Beansprucht Ziele atomar vor einem langsamen KI-Aufruf. Zwei Ticks koennen dadurch niemals
 * fuer denselben Kontakt parallel einen Entwurf erzeugen. */
export function claimCampaignTargets(campaignId: number, limit: number): Array<{ campaign_id: number; contact_id: number }> {
  return db.transaction(() => {
    const rows = db.prepare(
      `SELECT t.campaign_id,t.contact_id FROM campaign_targets t
        JOIN contacts c ON c.id=t.contact_id
        WHERE t.campaign_id=? AND t.status='queued'
          AND (t.next_attempt_at IS NULL OR t.next_attempt_at<=datetime('now'))
          AND NOT EXISTS (
            SELECT 1 FROM drafts open_draft
             WHERE open_draft.contact_id=t.contact_id
               AND NOT (open_draft.kind='reaktivierung' AND open_draft.status='pending')
               AND open_draft.status IN ('pending','approved','sending')
          )
        ORDER BY COALESCE(c.lead_score,0) DESC,t.created_at LIMIT ?`,
    ).all(campaignId, limit) as Array<{ campaign_id: number; contact_id: number }>;
    const claimed: Array<{ campaign_id: number; contact_id: number }> = [];
    for (const row of rows) if (transitionInside({ campaignId, contactId: row.contact_id, to: "generating", reason: "Entwurf wird vorbereitet", source: "campaign_tick", incrementAttempt: true })) claimed.push(row);
    return claimed;
  })();
}

export function syncCampaignTargetForDraft(draftId: number, draftStatus: string, reason?: string): boolean {
  const draft = db.prepare("SELECT id,contact_id,incoming,kind FROM drafts WHERE id=?").get(draftId) as
    { id: number; contact_id: number | null; incoming: string | null; kind: string } | undefined;
  if (!draft || draft.kind !== "event" || !draft.contact_id || !String(draft.incoming).startsWith("campaign:")) return false;
  const campaignId = Number(String(draft.incoming).slice("campaign:".length));
  if (!Number.isInteger(campaignId)) return false;
  const mapped: Record<string, CampaignTargetStatus> = { pending: "drafted", approved: "approved", sending: "sending", sent: "sent" };
  const to = mapped[draftStatus];
  if (to) return transitionCampaignTarget({ campaignId, contactId: draft.contact_id, to, reason: reason || `Entwurf ist ${draftStatus}`, source: "draft", draftId, force: true });
  if (draftStatus === "discarded" || draftStatus === "blockiert" || draftStatus === "unknown") {
    reconcileCampaignTarget(campaignId, draft.contact_id);
    return true;
  }
  return false;
}

export function retryCampaignTarget(campaignId: number, contactId: number): boolean {
  const policy = proactiveDecision(contactId, "campaign");
  if (!policy.ok) throw new Error(policy.reason);
  return db.transaction(() => {
    const changed = transitionInside({ campaignId, contactId, to: "queued", reason: "Manuell erneut eingeplant", source: "manual_retry" });
    if (changed) db.prepare("UPDATE campaign_targets SET attempt_count=0,last_error=NULL,next_attempt_at=NULL WHERE campaign_id=? AND contact_id=?")
      .run(campaignId, contactId);
    return changed;
  })();
}

export function retryFailedCampaignTargets(campaignId: number): number {
  const rows = db.prepare("SELECT contact_id FROM campaign_targets WHERE campaign_id=? AND status='failed' ORDER BY updated_at")
    .all(campaignId) as Array<{ contact_id: number }>;
  let retried = 0;
  for (const row of rows) {
    try { if (retryCampaignTarget(campaignId, row.contact_id)) retried++; } catch { /* Beziehungsschutz bleibt bestehen. */ }
  }
  return retried;
}

export function backfillCampaignWorkflows(): { checked: number; failed: number } {
  db.exec(`UPDATE campaign_targets SET version=COALESCE(version,0),attempt_count=COALESCE(attempt_count,0);
    INSERT OR IGNORE INTO campaign_target_events(dedupe_key,campaign_id,contact_id,from_status,to_status,reason,source,draft_id,created_at)
      SELECT 'backfill:'||campaign_id||':'||contact_id,campaign_id,contact_id,NULL,status,'Bestehender Kampagnenstand','backfill',draft_id,created_at
        FROM campaign_targets;`);
  return reconcileCampaignWorkflows();
}
