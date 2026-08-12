import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-funnel-"));
process.env.DB_PATH = join(dir, "funnel.sqlite");
const { db } = await import("../db/index.js");
const { recordCrmStage, replyQualityFromIntent } = await import("../modules/crmStages.js");
const { funnelReport, contactsForStage, funnelBySource } = await import("../modules/funnel.js");

const campaignA = Number(db.prepare("INSERT INTO campaigns(name,goal_code) VALUES('Kampagne A','B1')").run().lastInsertRowid);
const campaignB = Number(db.prepare("INSERT INTO campaigns(name,goal_code) VALUES('Kampagne B','P1')").run().lastInsertRowid);
const quelleGut = Number(db.prepare("INSERT INTO lead_sources(label,search_url,campaign_id) VALUES('Gut','https://x.test/gut',?)").run(campaignA).lastInsertRowid);
const quelleSchwach = Number(db.prepare("INSERT INTO lead_sources(label,search_url,campaign_id) VALUES('Schwach','https://x.test/schwach',?)").run(campaignB).lastInsertRowid);

function kontakt(name: string, campaignId: number, sourceId: number, zielgruppe = "azubi") {
  return Number(db.prepare(
    "INSERT INTO contacts(profile_url,full_name,status,campaign_id,source_id,zielgruppe) VALUES(?,?,'new',?,?,?)",
  ).run(`https://example.test/${name}`, name, campaignId, sourceId, zielgruppe).lastInsertRowid);
}

test("zählt jedes Ereignis genau einmal, auch nach Wiederholung und Neustart", () => {
  const id = kontakt("anna", campaignA, quelleGut);
  // Derselbe Ablauf läuft doppelt – so verhält sich ein Neustart mitten im Job.
  for (const durchlauf of [1, 2]) {
    void durchlauf;
    recordCrmStage(id, "found", "bot");
    recordCrmStage(id, "suitable", "bot");
    recordCrmStage(id, "invited", "bot");
    recordCrmStage(id, "accepted", "bot");
    recordCrmStage(id, "messaged", "bot");
    recordCrmStage(id, "replied", "bot", undefined, { quality: "interested" });
  }
  const report = funnelReport({ campaignId: campaignA });
  assert.equal(report.counts.invited, 1, "eine Einladung bleibt eine Einladung");
  assert.equal(report.counts.replied, 1);
  assert.equal(report.antworten.positiv, 1);
});

test("friert die Zuordnung am Ereignis ein und folgt keiner späteren Kontaktänderung", () => {
  const id = kontakt("ben", campaignA, quelleGut);
  recordCrmStage(id, "invited", "bot");
  // Der Kontakt wechselt später die Kampagne. Die Historie darf dadurch nicht wandern.
  db.prepare("UPDATE contacts SET campaign_id=? WHERE id=?").run(campaignB, id);
  recordCrmStage(id, "accepted", "bot");

  assert.equal(funnelReport({ campaignId: campaignA }).counts.invited, 2, "Ben bleibt bei A eingeladen");
  assert.equal(funnelReport({ campaignId: campaignB }).counts.invited, 0);
  assert.equal(funnelReport({ campaignId: campaignB }).counts.accepted, 1, "neue Ereignisse zählen bei B");
});

test("ordnet Antworten ein und trennt positive von ablehnenden", () => {
  const absage = kontakt("carla", campaignB, quelleSchwach);
  recordCrmStage(absage, "messaged", "bot");
  recordCrmStage(absage, "replied", "bot", undefined, { quality: "not_interested" });
  const spaeter = kontakt("dirk", campaignB, quelleSchwach);
  recordCrmStage(spaeter, "messaged", "bot");
  recordCrmStage(spaeter, "replied", "bot", undefined, { quality: "later" });

  const report = funnelReport({ campaignId: campaignB });
  assert.equal(report.counts.replied, 2);
  assert.equal(report.antworten.positiv, 0, "„später“ und „kein Interesse“ sind nicht positiv");
  assert.equal(report.antworten.werte.not_interested, 1);
  assert.equal(report.antworten.werte.later, 1);
});

test("präzisiert eine Einordnung, ohne die Antwort doppelt zu zählen", () => {
  const id = kontakt("emma", campaignA, quelleGut);
  recordCrmStage(id, "messaged", "bot");
  recordCrmStage(id, "replied", "bot", undefined, { quality: "neutral" });
  recordCrmStage(id, "replied", "bot", undefined, { quality: "meeting" });

  const eigen = funnelReport({ campaignId: campaignA, zielgruppe: "azubi" });
  assert.equal(eigen.antworten.werte.meeting, 1);
  assert.equal(eigen.antworten.werte.neutral, 0, "die Korrektur ersetzt die alte Einordnung");
  assert.equal(
    (db.prepare("SELECT COUNT(*) n FROM crm_stage_events WHERE contact_id=? AND stage='replied'").get(id) as { n: number }).n,
    1,
  );
});

test("führt jeden Wert auf konkrete Kontakte zurück", () => {
  const kontakte = contactsForStage("replied", { campaignId: campaignB });
  const report = funnelReport({ campaignId: campaignB });
  assert.equal(kontakte.length, report.counts.replied, "Liste und Kennzahl stammen aus derselben Abfrage");
  assert.deepEqual(kontakte.map((k) => k.full_name).sort(), ["carla", "dirk"]);
});

test("vergleicht Quellen fair über Ergebnisse statt über Kontaktmengen", () => {
  const quellen = funnelBySource();
  const gut = quellen.find((q) => q.source.id === quelleGut);
  const schwach = quellen.find((q) => q.source.id === quelleSchwach);
  assert.equal(gut?.report.antworten.positiv, 2, "anna + emma");
  assert.equal(schwach?.report.antworten.positiv, 0, "viele Antworten, keine positive");
  assert.equal(schwach?.report.counts.replied, 2);
});

test("kennzeichnet zu kleine Stichproben, statt eine Quote vorzutäuschen", () => {
  const report = funnelReport({ campaignId: campaignA });
  assert.equal(report.quoten.antwort.genugDaten, false);
  assert.ok(report.quoten.antwort.pct !== null, "die Quote wird berechnet, aber als unbelastbar markiert");
});

test("bildet Gesprächsabsichten auf Antwortqualitäten ab", () => {
  assert.equal(replyQualityFromIntent("do_not_contact"), "not_interested");
  assert.equal(replyQualityFromIntent("interested"), "interested");
  assert.equal(replyQualityFromIntent(null), "neutral");
  assert.equal(replyQualityFromIntent("unbekannt"), "neutral");
});

test.after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
