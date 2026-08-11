import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-crm-stages-"));
process.env.DB_PATH = join(dir, "crm-stages.sqlite");
const { db } = await import("../db/index.js");
const { recordCrmStage, goalFunnelEconomics, crmDataQuality } = await import("../modules/crmStages.js");

test("pflegt den CRM-Funnel idempotent und überschreibt keinen Endstatus", () => {
  const campaignId = Number(db.prepare("INSERT INTO campaigns(name,goal_code) VALUES('B1','B1')").run().lastInsertRowid);
  const contactId = Number(db.prepare(
    "INSERT INTO contacts(profile_url,full_name,status,campaign_id) VALUES('https://example.test/a','A','messaged',?)",
  ).run(campaignId).lastInsertRowid);

  recordCrmStage(contactId, "messaged", "bot");
  recordCrmStage(contactId, "replied", "bot");
  recordCrmStage(contactId, "qualified", "bot");
  recordCrmStage(contactId, "meeting", "agent");
  recordCrmStage(contactId, "meeting", "agent");
  db.prepare("UPDATE sales_outcomes SET stage='won',value_cents=150000 WHERE contact_id=?").run(contactId);
  recordCrmStage(contactId, "won", "manual");
  recordCrmStage(contactId, "qualified", "bot");

  assert.equal((db.prepare("SELECT COUNT(*) n FROM crm_stage_events WHERE contact_id=?").get(contactId) as { n: number }).n, 5);
  assert.deepEqual(db.prepare("SELECT stage,value_cents FROM sales_outcomes WHERE contact_id=?").get(contactId), { stage: "won", value_cents: 150000 });
  const funnel = goalFunnelEconomics().find((row) => row.goal === "B1");
  assert.deepEqual(funnel?.rates, { reply: 100, qualified: 100, meeting: 100, won: 100 });
  assert.deepEqual(crmDataQuality(), { messaged: 1, assigned: 1, manual: 1, automatic: 4, coveragePct: 100 });
});

test.after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
