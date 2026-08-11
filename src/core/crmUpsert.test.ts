import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-crm-upsert-"));
process.env.DB_PATH = join(dir, "crm.sqlite");
const { db } = await import("../db/index.js");
const { upsertContact } = await import("../modules/crm.js");

test("Lead-Import funktioniert mit dem partiellen normalized_url-Index", () => {
  const campaignId = Number(db.prepare(
    "INSERT INTO campaigns(name,goal_code,search_brief) VALUES('AEC-Test','AEC','Bankkaufleute')",
  ).run().lastInsertRowid);
  const sourceId = Number(db.prepare(
    "INSERT INTO lead_sources(label,search_url,campaign_id) VALUES('AEC-Quelle','https://example.test/search',?)",
  ).run(campaignId).lastInsertRowid);

  upsertContact({
    profileUrl: "https://www.linkedin.com/in/beispiel/?trk=search",
    fullName: "Erster Name",
    headline: "Bankkaufmann in Ausbildung",
    sourceId,
  });
  // Dieselbe Person in anderer URL-Schreibweise muss aktualisiert, nicht doppelt angelegt werden.
  upsertContact({
    profileUrl: "https://linkedin.com/in/beispiel",
    fullName: "Aktualisierter Name",
    headline: "Bankkaufmann in Ausbildung",
    sourceId,
  });

  const contacts = db.prepare("SELECT id,full_name,campaign_id FROM contacts").all() as Array<{ id: number; full_name: string; campaign_id: number }>;
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0]?.full_name, "Aktualisierter Name");
  assert.equal(contacts[0]?.campaign_id, campaignId);
  const target = db.prepare("SELECT campaign_id,status,route FROM campaign_targets").get() as { campaign_id: number; status: string; route: string };
  assert.deepEqual(target, { campaign_id: campaignId, status: "awaiting_connection", route: "external" });
});

test.after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
