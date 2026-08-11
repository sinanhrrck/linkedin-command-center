import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-low-read-"));
process.env.DB_PATH = join(dir, "low-read.sqlite");
const { db } = await import("../db/index.js");
const { shouldOpenConversation, rememberConversationPreview, deferProfile, readSavingsToday, runReadJobWhenDue } = await import("../modules/lowRead.js");
const { nextNewContacts } = await import("../modules/crm.js");

test("öffnet neue Vorschauen sofort und spart unveränderte Threads", () => {
  const first = shouldOpenConversation("Ada Beispiel", "Hallo Sinan", true, true);
  assert.equal(first.open, true);
  rememberConversationPreview(first.participantKey, first.snippetHash, "https://linkedin.test/messaging/thread/1", true);

  assert.equal(shouldOpenConversation("Ada Beispiel", "Hallo Sinan", true, true).open, false);
  assert.equal(shouldOpenConversation("Ada Beispiel", "Neue Nachricht", true, true).open, true);
  assert.equal(readSavingsToday().byKind.thread_cache, 1);
});

test("öffnet einen alten unveränderten Thread erneut, außer ein Entwurf wartet bereits", () => {
  const first = shouldOpenConversation("Bob Beispiel", "Noch offen", false, true);
  rememberConversationPreview(first.participantKey, first.snippetHash, "https://linkedin.test/messaging/thread/2", true);
  db.prepare("UPDATE inbox_scan_cache SET last_opened_at=datetime('now','-2 hours') WHERE participant_key=?").run(first.participantKey);
  assert.equal(shouldOpenConversation("Bob Beispiel", "Noch offen", false, true).open, true);
  db.prepare("INSERT INTO drafts(thread_url,participant,incoming,draft,status) VALUES(?,?,?,?,'pending')")
    .run("https://linkedin.test/messaging/thread/2", "Bob Beispiel", "Noch offen", "Antwort");
  assert.equal(shouldOpenConversation("Bob Beispiel", "Noch offen", false, true).open, false);
});

test("stellt nicht nutzbare Profile zurück und taktet Leseläufe über Neustarts", async () => {
  db.prepare("INSERT INTO contacts(profile_url,full_name,status,lead_score) VALUES('https://linkedin.test/in/a','A','new',80)").run();
  db.prepare("INSERT INTO contacts(profile_url,full_name,status,lead_score) VALUES('https://linkedin.test/in/b','B','new',70)").run();
  deferProfile("https://linkedin.test/in/a", "Kein Vernetzen-Knopf");
  assert.deepEqual(nextNewContacts(5).map((c) => c.full_name), ["B"]);

  let runs = 0;
  await runReadJobWhenDue("test", 60, async () => ++runs);
  await runReadJobWhenDue("test", 60, async () => ++runs);
  assert.equal(runs, 1);
  assert.equal(readSavingsToday().byKind.schedule, 1);
});

test("behandelt ein erreichtes Lesebudget als geplantes Warten statt den Job zu starten", async () => {
  const add = db.prepare("INSERT INTO actions(type,target) VALUES('pageRead','https://linkedin.test/feed')");
  db.transaction(() => { for (let i = 0; i < 120; i++) add.run(); })();
  let runs = 0;
  const result = await runReadJobWhenDue("budget-stop", 60, async () => ++runs);
  assert.equal(result, null);
  assert.equal(runs, 0);
  assert.ok((readSavingsToday().byKind.schedule || 0) >= 2);
});

test.after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
