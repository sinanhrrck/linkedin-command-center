import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-learning-"));
process.env.DB_PATH = join(dir, "learning.sqlite");
const { db } = await import("../db/index.js");
const { classifyChange, learnFromDraft, learningRules, anonymousLearningSnapshot } = await import("../modules/learning.js");

test("erkennt wiederkehrende Textkorrekturen", () => {
  assert.equal(classifyChange("Hallo, das ist ein relativ langer erster Entwurf mit mehreren Worten und einer Frage?", "Hallo, kurze Antwort."), "shorter");
  assert.equal(classifyChange("Hey, wie geht es dir?", "Völlig neue Richtung ohne gleiche Begriffe."), "rewritten");
  assert.equal(classifyChange("Hey, wie geht es dir?", "Hey, wie geht es dir?"), "unchanged");
});

test("lernt erst aus wiederholten Signalen und speichert keine Identitäten", () => {
  db.prepare("INSERT INTO campaigns(name,goal_code) VALUES('B1-Test','B1')").run();
  const campaignId = Number((db.prepare("SELECT id FROM campaigns WHERE name='B1-Test'").get() as { id: number }).id);
  db.prepare("INSERT INTO contacts(profile_url,full_name,campaign_id) VALUES(?,?,?)").run("https://example.test/geheim", "Geheimer Name", campaignId);
  const insert = db.prepare(
    `INSERT INTO drafts(kind,thread_url,participant,incoming,draft,ki_original,status,rejection_reason)
     VALUES('message',?,?,?,?,?,'discarded','too_salesy')`,
  );
  const one = Number(insert.run("https://example.test/geheim", "Geheimer Name", "Private Nachricht", "Kurze Antwort", "Ein deutlich zu langer verkäuferischer Entwurf mit mehreren Aussagen und einer Frage?").lastInsertRowid);
  const two = Number(insert.run("https://example.test/geheim", "Geheimer Name", "Noch privater", "Noch kürzer", "Ein weiterer zu langer verkäuferischer Entwurf mit mehreren Aussagen und einer Frage?").lastInsertRowid);
  learnFromDraft(one, "rejected", "too_salesy");
  learnFromDraft(two, "rejected", "too_salesy");

  assert.equal(learningRules("B1")[0]?.code, "less_salesy");
  const stored = JSON.stringify(db.prepare("SELECT * FROM learning_events").all());
  assert.equal(stored.includes("Geheimer Name"), false);
  assert.equal(stored.includes("example.test"), false);
  assert.equal(stored.includes("Private Nachricht"), false);
  assert.deepEqual(Object.keys(anonymousLearningSnapshot(99)), ["schemaVersion", "minimumCount", "aggregates"]);
});

test.after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
