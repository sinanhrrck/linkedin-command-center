import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-campaign-workflow-"));
process.env.DB_PATH = join(dir, "workflow.sqlite");
const { db } = await import("../db/index.js");
const {
  claimCampaignTargets,
  reconcileCampaignTarget,
  retryCampaignTarget,
  syncCampaignTargetForDraft,
  transitionCampaignTarget,
} = await import("../modules/campaignWorkflow.js");
const { previewCampaign } = await import("../modules/campaigns.js");

function fixture(name = "Ada Beispiel") {
  const campaignId = Number(db.prepare("INSERT INTO campaigns(name,kind,event_url) VALUES(?,'event','https://example.test/event')").run(`Event ${name}`).lastInsertRowid);
  const contactId = Number(db.prepare(
    "INSERT INTO contacts(profile_url,full_name,headline,status,accepted_at,lead_score) VALUES(?,?,?,'accepted','2026-08-01 10:00:00',80)",
  ).run(`https://example.test/${name.replaceAll(" ", "-")}`, name, "Bankkauffrau in Ausbildung").lastInsertRowid);
  db.prepare("INSERT INTO campaign_targets(campaign_id,contact_id,route,status) VALUES(?,?,'network','queued')").run(campaignId, contactId);
  return { campaignId, contactId };
}

test("beansprucht jeden Kampagnenkontakt nur einmal und lässt laufender Erstellung Zeit", () => {
  const { campaignId, contactId } = fixture();
  assert.equal(claimCampaignTargets(campaignId, 10).length, 1);
  assert.equal(claimCampaignTargets(campaignId, 10).length, 0, "ein paralleler Tick darf dasselbe Ziel nicht übernehmen");
  assert.equal(reconcileCampaignTarget(campaignId, contactId), "generating", "ein zweiter Prozess darf die laufende Erstellung nicht abbrechen");

  db.prepare("UPDATE campaign_targets SET updated_at=datetime('now','-20 minutes') WHERE campaign_id=? AND contact_id=?").run(campaignId, contactId);
  assert.equal(reconcileCampaignTarget(campaignId, contactId), "queued", "eine verwaiste erste Erstellung wird wieder eingeplant");
  assert.equal(claimCampaignTargets(campaignId, 10).length, 1);
  db.prepare("UPDATE campaign_targets SET updated_at=datetime('now','-20 minutes') WHERE campaign_id=? AND contact_id=?").run(campaignId, contactId);
  assert.equal(reconcileCampaignTarget(campaignId, contactId), "failed", "erst zwei echte abgebrochene Versuche werden zum Fehler");
  assert.equal(retryCampaignTarget(campaignId, contactId), true);
  const retried = db.prepare("SELECT status,attempt_count,last_error FROM campaign_targets WHERE campaign_id=? AND contact_id=?").get(campaignId, contactId) as
    { status: string; attempt_count: number; last_error: string | null };
  assert.deepEqual(retried, { status: "queued", attempt_count: 0, last_error: null });
});

test("ein bewusst gelöschter Kampagnenentwurf wird beendet und nicht als Fehler wiederholt", () => {
  const { campaignId, contactId } = fixture("Gelöscht Beispiel");
  assert.equal(claimCampaignTargets(campaignId, 10).length, 1);

  const first = Number(db.prepare(
    "INSERT INTO drafts(contact_id,kind,thread_url,participant,incoming,draft,status) VALUES(?,'event','https://example.test/Gelöscht-Beispiel','Gelöscht Beispiel',?,'Einladung 1','pending')",
  ).run(contactId, `campaign:${campaignId}`).lastInsertRowid);
  assert.equal(transitionCampaignTarget({ campaignId, contactId, to: "drafted", source: "test", draftId: first }), true);
  db.prepare("UPDATE drafts SET status='discarded' WHERE id=?").run(first);
  syncCampaignTargetForDraft(first, "discarded", "Entwurf wurde gelöscht");
  const target = db.prepare("SELECT status,last_error FROM campaign_targets WHERE campaign_id=? AND contact_id=?").get(campaignId, contactId) as
    { status: string; last_error: string | null };
  assert.equal(target.status, "cancelled");
  assert.equal(target.last_error, null);
  assert.equal(claimCampaignTargets(campaignId, 10).length, 0);
});

test("markiert eine Antwort erst nach nachgewiesenem Kampagnenversand als abgeschlossen", () => {
  const { campaignId, contactId } = fixture("Berta Beispiel");
  const draftId = Number(db.prepare(
    `INSERT INTO drafts(contact_id,kind,thread_url,participant,incoming,draft,status,sent_at)
     VALUES(?,'event','https://example.test/Berta-Beispiel','Berta Beispiel',?,'Einladung','sent','2026-08-10 10:00:00')`,
  ).run(contactId, `campaign:${campaignId}`).lastInsertRowid);
  transitionCampaignTarget({ campaignId, contactId, to: "sent", source: "test", draftId, force: true });
  assert.equal(reconcileCampaignTarget(campaignId, contactId), "sent");
  db.prepare("UPDATE contacts SET replied_at='2026-08-10 11:00:00' WHERE id=?").run(contactId);
  assert.equal(reconcileCampaignTarget(campaignId, contactId), "completed");
});

test("serverseitige Vorschau schließt laufende Gespräche und geschützte Kontakte aus", () => {
  const activeId = Number(db.prepare(
    "INSERT INTO contacts(profile_url,full_name,headline,status,messaged_at,lead_score) VALUES('https://example.test/aktiv','Aktiv Gespräch','Bank Ausbildung','messaged','2026-08-10',90)",
  ).run().lastInsertRowid);
  const protectedId = Number(db.prepare(
    "INSERT INTO contacts(profile_url,full_name,headline,status,accepted_at,lead_score,automation_status,snoozed_until) VALUES('https://example.test/pause','Pause Kontakt','Bank Ausbildung','accepted','2026-08-01',90,'paused','2026-12-01')",
  ).run().lastInsertRowid);
  assert.ok(activeId > 0 && protectedId > 0);
  const preview = previewCampaign({ name: "Sicher", kind: "event", eventUrl: "https://example.test/event", audienceScope: "network", filters: { keywords: "Bank", minScore: 50 } });
  assert.ok(preview.exclusions.activeConversation >= 1);
  assert.ok(preview.exclusions.protected >= 1);
});

test.after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
