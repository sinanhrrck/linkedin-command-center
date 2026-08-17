import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-integrity-"));
process.env.DB_PATH = join(dir, "integrity.sqlite");
const { db } = await import("../db/index.js");
const { repairContactDuplicates } = await import("../db/dataIntegrity.js");
const { createCampaign, listCampaigns } = await import("../modules/campaigns.js");
const { campaignTick } = await import("../modules/campaignRunner.js");
const { rejectDraft, deleteDraft, createFirstMessageDraft, deliverFirstMessage } = await import("../modules/drafts.js");
const { setTextGeneratorForTests } = await import("../core/textLlm.js");

// Die Kampagnen-Pipeline schreibt jeden Entwurf per KI. Ohne diesen Stub gaebe es hier gar
// keinen Entwurf mehr (seit 2026-08-17 wird bei KI-Ausfall bewusst nichts erzeugt, statt die
// rohe Vorlage samt Platzhaltern zur Freigabe zu legen).
setTextGeneratorForTests(async () => "Hey, ich melde mich kurz wegen eines Termins bei uns. Sag Bescheid, ob das fuer dich interessant ist.");

test("vereinigt kanonisch gleiche Profile und offene Entwürfe", () => {
  db.prepare("INSERT INTO contacts(profile_url,full_name,status,invited_at) VALUES(?,?,?,datetime('now','-3 days'))")
    .run("https://www.linkedin.com/in/test-person/", "Test Person", "invited");
  db.prepare("INSERT INTO contacts(profile_url,full_name,status,accepted_at,aus_netzwerk) VALUES(?,?,?,datetime('now'),1)")
    .run("https://www.linkedin.com/in/test-person", "Test Person", "accepted");
  db.prepare("INSERT INTO drafts(kind,thread_url,participant,incoming,draft) VALUES('first',?,?,?,?)")
    .run("https://www.linkedin.com/in/test-person/", "Test Person", "", "A");
  db.prepare("INSERT INTO drafts(kind,thread_url,participant,incoming,draft) VALUES('first',?,?,?,?)")
    .run("https://www.linkedin.com/in/test-person", "Test Person", "", "B");

  const result = repairContactDuplicates(db);
  assert.equal(result.removed, 1);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM contacts").get() as { n: number }).n, 1);
  const contact = db.prepare("SELECT profile_url,status,aus_netzwerk,invited_at,accepted_at FROM contacts").get() as Record<string, unknown>;
  assert.equal(contact.profile_url, "https://www.linkedin.com/in/test-person");
  assert.equal(contact.status, "accepted");
  assert.equal(contact.aus_netzwerk, 0, "ein selbst eingeladener Kontakt bleibt Outreach");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM drafts WHERE status='pending'").get() as { n: number }).n, 1);
});

test("Event-Kampagne trennt Netzwerk und externe Leads", async () => {
  db.prepare("INSERT INTO contacts(profile_url,normalized_url,full_name,headline,status,accepted_at,lead_score) VALUES(?,?,?,?,?,datetime('now'),?)")
    .run("https://www.linkedin.com/in/network", "https://www.linkedin.com/in/network", "Net Work", "Bankkaufmann Heidelberg", "accepted", 80);
  db.prepare("INSERT INTO contacts(profile_url,normalized_url,full_name,headline,status,lead_score) VALUES(?,?,?,?,?,?)")
    .run("https://www.linkedin.com/in/external", "https://www.linkedin.com/in/external", "Ex Ternal", "Bankkaufmann Heidelberg", "new", 80);
  const id = createCampaign({ name: "Testevent", kind: "event", eventUrl: "https://www.linkedin.com/events/test", audienceScope: "both", filters: { keywords: "Bankkaufmann", minScore: 50 }, dailyLimit: 5 });
  const campaign = listCampaigns().find((item) => item.id === id);
  assert.equal(campaign?.target_network, 1);
  assert.equal(campaign?.target_external, 1);
  assert.equal(await campaignTick(), 1, "nur die bereits vernetzte Person bekommt sofort einen Entwurf");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM drafts WHERE kind='event'").get() as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT status FROM campaign_targets WHERE campaign_id=? AND route='external'").get(id) as { status: string }).status, "awaiting_connection");
});

test("Ablehnen speichert Feedback und öffnet eine echte Richtungswahl", async () => {
  const profile = "https://www.linkedin.com/in/feedback-test";
  db.prepare("INSERT INTO contacts(profile_url,normalized_url,full_name,status) VALUES(?,?,?,'accepted')")
    .run(profile, profile, "Feedback Test");
  const info = db.prepare("INSERT INTO drafts(kind,thread_url,participant,incoming,draft) VALUES('first',?,?,?,?)")
    .run(profile, "Feedback Test", "", "Alter Ansatz");
  const result = await rejectDraft(Number(info.lastInsertRowid), "different_approach");
  assert.equal(result.choosingApproach, true);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM draft_feedback WHERE thread_url=?").get(profile) as { n: number }).n, 1);
  const choice = db.prepare("SELECT phase,draft FROM drafts WHERE thread_url=? AND status='pending'").get(profile) as { phase: string; draft: string };
  assert.equal(choice.phase, "approach");
  assert.equal(JSON.parse(choice.draft).length, 3);
});

test("Löschen entfernt den Entwurf aus dem Arbeitskorb und hinterlässt eine Wiederholungssperre", () => {
  const info = db.prepare("INSERT INTO drafts(kind,thread_url,participant,incoming,draft) VALUES('message',?,?,?,?)")
    .run("thread-delete", "Direkt beantwortet", "Bereits selbst beantwortete Nachricht", "Veraltete Antwort");
  const id = Number(info.lastInsertRowid);
  assert.equal(deleteDraft(id), true);
  const row = db.prepare("SELECT status,incoming FROM drafts WHERE id=?").get(id) as { status: string; incoming: string };
  assert.equal(row.status, "discarded");
  assert.equal(row.incoming, "Bereits selbst beantwortete Nachricht");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM drafts WHERE id=? AND status='pending'").get(id) as { n: number }).n, 0);
});

test("bestehendes Netzwerk kann nie in die automatische Erstnachricht rutschen", async () => {
  const profile = "https://www.linkedin.com/in/network-addon-guard";
  db.prepare("INSERT INTO contacts(profile_url,normalized_url,full_name,status,aus_netzwerk) VALUES(?,?,?,'accepted',1)")
    .run(profile, profile, "Network Addon");
  const contact = db.prepare("SELECT * FROM contacts WHERE profile_url=?").get(profile) as Parameters<typeof createFirstMessageDraft>[0];

  assert.equal(await createFirstMessageDraft(contact), false);
  await deliverFirstMessage(contact);
  assert.equal(
    (db.prepare("SELECT COUNT(*) n FROM drafts WHERE thread_url=? AND kind='first'").get(profile) as { n: number }).n,
    0,
  );
});

test("aktive Outreach-Kampagne erzeugt höchstens 20 prüfpflichtige Entwürfe pro Tag", async () => {
  db.prepare("UPDATE campaigns SET active=0").run();
  for (let i = 0; i < 22; i++) {
    const profile = `https://www.linkedin.com/in/campaign-daily-${i}`;
    db.prepare("INSERT INTO contacts(profile_url,normalized_url,full_name,headline,status,aus_netzwerk,lead_score) VALUES(?,?,?,?,'accepted',1,80)")
      .run(profile, profile, `Daily ${i}`, "Kampagnenziel Finanzierung");
  }
  const id = createCampaign({
    name: "Tageskampagne", kind: "outreach", audienceScope: "network",
    filters: { keywords: "Kampagnenziel" }, valueProp: "Ein persönliches Markt-Update", dailyLimit: 20,
  });
  assert.equal(await campaignTick(), 20);
  const dailyCount = (db.prepare(
    "SELECT COUNT(*) n FROM drafts WHERE kind='event' AND incoming=? AND date(created_at,'localtime')=date('now','localtime')",
  ).get(`campaign:${id}`) as { n: number }).n;
  assert.equal(dailyCount, 20, "das Tageslimit zählt die tatsächlich erzeugten Entwürfe");
  assert.equal(await campaignTick(), 0, "ein zweiter Tick am selben Tag legt nichts nach");
  const rows = db.prepare("SELECT status FROM drafts WHERE incoming=?").all(`campaign:${id}`) as Array<{ status: string }>;
  assert.equal(rows.length, 20);
  assert.ok(rows.every((row) => row.status === "pending"), "alle Kampagnentexte warten auf Freigabe");
});

test.after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
