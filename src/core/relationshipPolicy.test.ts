import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-relationship-"));
process.env.DB_PATH = join(dir, "relationship.sqlite");
const { db } = await import("../db/index.js");
const {
  backfillRelationshipSignals,
  interpretRelationshipSignal,
  proactiveDecision,
} = await import("../modules/relationshipPolicy.js");

test("erkennt eine ausdrücklich gewünschte Wiedervorlage im Winter", () => {
  const signal = interpretRelationshipSignal(
    "Ich bin im Moment in der Prüfungsvorbereitung. Würde aber Richtung Winter darauf zurückkommen.",
    new Date("2026-08-06T10:00:00+02:00"),
  );
  assert.deepEqual(signal, {
    kind: "snoozed",
    until: "2026-12-01 08:00:00",
    label: "Winter 2026",
    reason: "Prüfung oder intensive Vorbereitung",
  });
});

test("Alexander-Fall: übernimmt die jüngste Zusage und entfernt allgemeine Kampagnenarbeit", () => {
  const campaignId = Number(db.prepare("INSERT INTO campaigns(name,kind,event_url) VALUES('Event','event','https://example.test/event')").run().lastInsertRowid);
  const contactId = Number(db.prepare(
    `INSERT INTO contacts(profile_url,full_name,status,replied_at,campaign_id)
     VALUES('https://example.test/alexander','Alexander Beispiel','replied','2026-07-28 08:17:14',?)`,
  ).run(campaignId).lastInsertRowid);
  db.prepare("INSERT INTO campaign_targets(campaign_id,contact_id,route,status) VALUES(?,?,'network','drafted')").run(campaignId, contactId);
  db.prepare(
    `INSERT INTO drafts(kind,thread_url,participant,incoming,draft,status,created_at,sent_at)
     VALUES('message','https://example.test/thread/alexander','Alexander Beispiel',?,?,'sent','2026-08-06 09:45:46','2026-08-06 09:45:46')`,
  ).run(
    "Klingt interessant. Ich bin im Moment in der Prüfungsvorbereitung. Würde aber Richtung Winter darauf zurückkommen.",
    "Alles klar, ich melde mich im Winter.",
  );
  const replyDraftId = Number(db.prepare(
    "INSERT INTO drafts(kind,thread_url,participant,incoming,draft,status,created_at) VALUES('message','https://example.test/thread/alexander','Alexander Beispiel',?,'Alles klar, ich melde mich im Winter.','pending','2026-08-06 09:46:00')",
  ).run("Klingt interessant. Ich bin im Moment in der Prüfungsvorbereitung. Würde aber Richtung Winter darauf zurückkommen.").lastInsertRowid);
  const eventDraftId = Number(db.prepare(
    "INSERT INTO drafts(kind,thread_url,participant,incoming,draft,status) VALUES('event','https://example.test/alexander','Alexander Beispiel','campaign:1','Allgemeine Einladung','pending')",
  ).run().lastInsertRowid);

  assert.equal(backfillRelationshipSignals(), 1);
  const contact = db.prepare(
    "SELECT automation_status,snoozed_until,snooze_label,snooze_reason,do_not_contact FROM contacts WHERE id=?",
  ).get(contactId);
  assert.deepEqual(contact, {
    automation_status: "paused",
    snoozed_until: "2026-12-01 08:00:00",
    snooze_label: "Winter 2026",
    snooze_reason: "Prüfung oder intensive Vorbereitung",
    do_not_contact: 0,
  });
  assert.equal((db.prepare("SELECT status FROM drafts WHERE id=?").get(eventDraftId) as { status: string }).status, "discarded");
  assert.equal((db.prepare("SELECT status FROM drafts WHERE id=?").get(replyDraftId) as { status: string }).status, "pending", "eine höfliche direkte Antwort bleibt erlaubt");
  assert.equal((db.prepare("SELECT status FROM campaign_targets WHERE contact_id=?").get(contactId) as { status: string }).status, "snoozed");
  const policy = proactiveDecision(contactId, "campaign", new Date("2026-08-11T12:00:00+02:00"));
  assert.equal(policy.ok, false);
  if (!policy.ok) assert.match(policy.reason, /Prüfung.*Winter 2026/);
  assert.equal(backfillRelationshipSignals(), 0, "erneuter Backfill bleibt durch deduplizierte Ereignisse unschädlich");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM relationship_events WHERE contact_id=?").get(contactId) as { n: number }).n, 1);
});

test("unterscheidet temporäres Desinteresse von einem dauerhaften Kontaktverbot", () => {
  assert.equal(interpretRelationshipSignal("Aktuell habe ich kein Interesse, vielleicht später.", new Date("2026-08-11T10:00:00Z"))?.kind, "snoozed");
  assert.deepEqual(interpretRelationshipSignal("Bitte keine weiteren Nachrichten."), {
    kind: "do_not_contact",
    reason: "Kontakt wünscht keine weiteren Nachrichten",
  });
  assert.equal(interpretRelationshipSignal("Im Moment läuft es bei uns sehr gut."), null);
});

test.after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
