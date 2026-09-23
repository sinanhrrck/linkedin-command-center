import type Database from "better-sqlite3";
import { canonicalProfileUrl, isLinkedInProfileUrl } from "../core/profileUrl.js";

type Contact = {
  id: number;
  profile_url: string;
  full_name: string | null;
  headline: string | null;
  status: string;
  notes: string | null;
  invited_at: string | null;
  accepted_at: string | null;
  messaged_at: string | null;
  replied_at: string | null;
  zielgruppe: string | null;
  lead_score: number | null;
  score_grund: string | null;
  source_id: number | null;
  campaign_id: number | null;
  aus_netzwerk: number | null;
  automation_status?: string | null;
  snoozed_until?: string | null;
  snooze_label?: string | null;
  snooze_reason?: string | null;
  do_not_contact?: number | null;
  last_meaningful_contact_at?: string | null;
  created_at: string;
};

const STATUS_RANK: Record<string, number> = {
  skipped: 0, new: 1, inviting: 2, invited: 3, accepted: 4, messaged: 5, replied: 6, closed: 7,
};
const first = <T>(rows: T[], pick: (row: T) => unknown): T | undefined => rows.find((row) => pick(row) != null && pick(row) !== "");
const minDate = (rows: Contact[], key: keyof Contact) => {
  const values = rows.map((row) => row[key]).filter((value): value is string => typeof value === "string" && !!value).sort();
  return values[0] ?? null;
};

function tableExists(db: Database.Database, name: string) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/**
 * Fuehrt historisch doppelt angelegte Kontakte verlustarm zusammen. Die Transaktion ist
 * wiederholbar: nach einem erfolgreichen Lauf existiert pro kanonischer Profil-URL nur eine Zeile.
 */
export function repairContactDuplicates(db: Database.Database): { groups: number; removed: number; draftDuplicates: number } {
  const rows = db.prepare("SELECT * FROM contacts ORDER BY id").all() as Contact[];
  const groups = new Map<string, Contact[]>();
  for (const row of rows) {
    const key = canonicalProfileUrl(row.profile_url);
    const list = groups.get(key) ?? [];
    list.push(row); groups.set(key, list);
  }
  const duplicates = [...groups.entries()].filter(([, list]) => list.length > 1);
  let removed = 0;

  db.transaction(() => {
    for (const [canonical, list] of duplicates) {
      const ordered = [...list].sort((a, b) =>
        (STATUS_RANK[b.status] ?? -1) - (STATUS_RANK[a.status] ?? -1) ||
        Number(!!b.invited_at) - Number(!!a.invited_at) || a.id - b.id,
      );
      const keep = ordered[0];
      const drop = ordered.slice(1);
      const dropIds = drop.map((row) => row.id);
      const urls = [...new Set(list.map((row) => row.profile_url))];
      const bestHeadline = [...list].filter((row) => row.headline).sort((a, b) => (b.headline?.length ?? 0) - (a.headline?.length ?? 0))[0];
      const bestScore = [...list].filter((row) => row.lead_score != null).sort((a, b) => (b.lead_score ?? 0) - (a.lead_score ?? 0))[0];
      const invitedAt = minDate(list, "invited_at");
      const acceptedAt = minDate(list, "accepted_at");
      const messagedAt = minDate(list, "messaged_at");
      const repliedAt = minDate(list, "replied_at");
      const status = ordered[0].status;
      const excluded = list.some((row) => row.do_not_contact || row.automation_status === "excluded");
      const manual = !excluded && list.some((row) => row.automation_status === "manual");
      const paused = !excluded && !manual && list.some((row) => row.automation_status === "paused");
      const automationStatus = excluded ? "excluded" : manual ? "manual" : paused ? "paused" : "active";
      const snoozed = [...list].filter((row) => row.snoozed_until).sort((a, b) => String(b.snoozed_until).localeCompare(String(a.snoozed_until)))[0];
      const lastMeaningful = [...list].map((row) => row.last_meaningful_contact_at).filter((value): value is string => !!value).sort().at(-1) ?? null;

      // Abhaengige Vertriebsdaten zuerst auf den Gewinner umhaengen.
      if (dropIds.length && tableExists(db, "sales_tasks")) {
        const q = dropIds.map(() => "?").join(",");
        db.prepare(`UPDATE sales_tasks SET contact_id=? WHERE contact_id IN (${q})`).run(keep.id, ...dropIds);
      }
      if (dropIds.length) {
        const q = dropIds.map(() => "?").join(",");
        for (const table of ["relationship_events", "crm_stage_events", "contact_timeline_events", "message_variants"] as const) {
          if (tableExists(db, table)) db.prepare(`UPDATE ${table} SET contact_id=? WHERE contact_id IN (${q})`).run(keep.id, ...dropIds);
        }
        if (tableExists(db, "drafts")) {
          const hasContactId = (db.prepare("PRAGMA table_info(drafts)").all() as Array<{ name: string }>).some((row) => row.name === "contact_id");
          if (hasContactId) db.prepare(`UPDATE drafts SET contact_id=? WHERE contact_id IN (${q})`).run(keep.id, ...dropIds);
        }
        if (tableExists(db, "campaign_targets")) {
          db.prepare(`INSERT OR IGNORE INTO campaign_targets(campaign_id,contact_id,route,status,reason,created_at,updated_at)
            SELECT campaign_id,?,route,status,reason,created_at,updated_at FROM campaign_targets WHERE contact_id IN (${q})`).run(keep.id, ...dropIds);
          db.prepare(`DELETE FROM campaign_targets WHERE contact_id IN (${q})`).run(...dropIds);
        }
        if (tableExists(db, "contact_profile_facts")) {
          // Eine Zeile je Kontakt: vorhandene Fakten des Gewinners bleiben, sonst die der Dublette.
          db.prepare(`INSERT OR IGNORE INTO contact_profile_facts(contact_id,rolle,firma,seit,ueber,captured_at)
            SELECT ?,rolle,firma,seit,ueber,captured_at FROM contact_profile_facts WHERE contact_id IN (${q}) ORDER BY captured_at DESC LIMIT 1`).run(keep.id, ...dropIds);
          db.prepare(`DELETE FROM contact_profile_facts WHERE contact_id IN (${q})`).run(...dropIds);
        }
        if (tableExists(db, "contact_identities")) {
          db.prepare(`DELETE FROM contact_identities WHERE contact_id IN (${q}) AND identity_type='profile_url'`).run(...dropIds);
          db.prepare(`UPDATE contact_identities SET contact_id=? WHERE contact_id IN (${q})`).run(keep.id, ...dropIds);
        }
      }
      if (tableExists(db, "sales_outcomes")) {
        const outcomes = db.prepare(`SELECT * FROM sales_outcomes WHERE contact_id IN (${list.map(() => "?").join(",")}) ORDER BY updated_at DESC`).all(...list.map((row) => row.id)) as Array<Record<string, unknown>>;
        if (outcomes.length) {
          db.prepare(`DELETE FROM sales_outcomes WHERE contact_id IN (${list.map(() => "?").join(",")})`).run(...list.map((row) => row.id));
          const outcome = outcomes[0];
          db.prepare("INSERT INTO sales_outcomes(contact_id,campaign_id,stage,note,value_cents,updated_at) VALUES(?,?,?,?,?,?)")
            .run(keep.id, outcome.campaign_id ?? null, outcome.stage, outcome.note ?? null, outcome.value_cents ?? null, outcome.updated_at);
        }
      }

      // URL-basierte Historie ebenfalls kanonisieren. Messaging-Thread-URLs sind nicht betroffen.
      for (const oldUrl of urls) {
        db.prepare("UPDATE drafts SET thread_url=? WHERE thread_url=?").run(canonical, oldUrl);
        db.prepare("UPDATE actions SET target=? WHERE target=?").run(canonical, oldUrl);
        if (tableExists(db, "sent_ledger")) db.prepare("UPDATE sent_ledger SET recipient=? WHERE recipient=?").run(canonical, oldUrl);
      }

      if (dropIds.length) {
        db.prepare(`DELETE FROM contacts WHERE id IN (${dropIds.map(() => "?").join(",")})`).run(...dropIds);
        removed += dropIds.length;
      }
      db.prepare(
        `UPDATE contacts SET profile_url=?, normalized_url=?, full_name=?, headline=?, status=?, notes=?,
           invited_at=?, accepted_at=?, messaged_at=?, replied_at=?, zielgruppe=?, lead_score=?,
           score_grund=?, source_id=?, campaign_id=?, aus_netzwerk=?,automation_status=?,snoozed_until=?,
           snooze_label=?,snooze_reason=?,do_not_contact=?,last_meaningful_contact_at=?,created_at=? WHERE id=?`,
      ).run(
        canonical, canonical,
        first(list, (row) => row.full_name)?.full_name ?? null,
        bestHeadline?.headline ?? null, status,
        first(list, (row) => row.notes)?.notes ?? null,
        invitedAt, acceptedAt, messagedAt, repliedAt,
        first(list, (row) => row.zielgruppe)?.zielgruppe ?? null,
        bestScore?.lead_score ?? null, bestScore?.score_grund ?? null,
        first(list, (row) => row.source_id)?.source_id ?? null,
        first(list, (row) => row.campaign_id)?.campaign_id ?? null,
        invitedAt ? 0 : Math.max(...list.map((row) => row.aus_netzwerk ?? 0)),
        automationStatus,snoozed?.snoozed_until ?? null,snoozed?.snooze_label ?? null,
        snoozed?.snooze_reason ?? first(list, (row) => row.snooze_reason)?.snooze_reason ?? null,
        excluded ? 1 : 0,lastMeaningful,
        minDate(list, "created_at") ?? keep.created_at, keep.id,
      );
    }

    // Auch eindeutige Altzeilen erhalten die kanonische URL und den neuen Schluessel.
    const remaining = db.prepare("SELECT id,profile_url FROM contacts").all() as Array<{ id: number; profile_url: string }>;
    for (const row of remaining) {
      const canonical = canonicalProfileUrl(row.profile_url);
      if (isLinkedInProfileUrl(row.profile_url)) db.prepare("UPDATE contacts SET profile_url=?, normalized_url=? WHERE id=?").run(canonical, canonical, row.id);
    }

    // Bereits vorhandene offene Doppelentwuerfe bleiben auditierbar, aber nur der aelteste
    // genehmigte bzw. neueste wartende Entwurf bleibt aktiv.
    const duplicateDrafts = db.prepare(
      `SELECT thread_url,kind,COALESCE(incoming,'') incoming,GROUP_CONCAT(id) ids
         FROM drafts WHERE status IN ('pending','approved','sending')
        GROUP BY thread_url,kind,COALESCE(incoming,'') HAVING COUNT(*)>1`,
    ).all() as Array<{ ids: string }>;
    for (const group of duplicateDrafts) {
      const ids = group.ids.split(",").map(Number);
      const candidates = db.prepare(`SELECT id,status FROM drafts WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY CASE status WHEN 'sending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,id DESC`).all(...ids) as Array<{ id: number }>;
      const discard = candidates.slice(1).map((row) => row.id);
      if (discard.length) db.prepare(`UPDATE drafts SET status='discarded' WHERE id IN (${discard.map(() => "?").join(",")})`).run(...discard);
    }
  })();

  const draftDuplicates = (db.prepare(
    `SELECT COALESCE(SUM(n-1),0) n FROM (SELECT COUNT(*) n FROM drafts WHERE status IN ('pending','approved','sending') GROUP BY thread_url,kind,COALESCE(incoming,'') HAVING COUNT(*)>1)`,
  ).get() as { n: number }).n;
  return { groups: duplicates.length, removed, draftDuplicates };
}
