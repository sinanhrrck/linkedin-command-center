import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-identity-"));
process.env.DB_PATH = join(dir, "identity.sqlite");
const { db } = await import("../db/index.js");
const { backfillContactIdentities, resolveContactIdentity, resolveIdentityConflict } = await import("../modules/contactIdentity.js");
const { getConversationWorkspace } = await import("../modules/conversationWorkspace.js");

test("verbindet Profil und Nachrichten-Thread dauerhaft mit derselben Person", () => {
  const contactId = Number(db.prepare(
    "INSERT INTO contacts(profile_url,normalized_url,full_name,status) VALUES(?,?,?,'replied')",
  ).run("https://www.linkedin.com/in/alexander-test", "https://www.linkedin.com/in/alexander-test", "Alexander Test").lastInsertRowid);
  const thread = "https://www.linkedin.com/messaging/thread/2-ABC_100==/";
  db.prepare(
    `INSERT INTO drafts(kind,thread_url,participant,incoming,draft,status,created_at,sent_at)
     VALUES('message',?,?,?,'Alles klar, bis Winter.','sent','2026-08-06 09:45:00','2026-08-06 09:46:00')`,
  ).run(thread, "Alexander Test", "Ich habe aktuell keine Zeit und melde mich im Winter.");

  const result = backfillContactIdentities();
  assert.equal(result.unresolved, 0);
  const draft = db.prepare("SELECT contact_id FROM drafts").get() as { contact_id: number };
  assert.equal(draft.contact_id, contactId);
  assert.equal(resolveContactIdentity(thread, "Falscher Anzeigename")?.id, contactId, "der stabile Thread gewinnt später gegen Namensänderungen");

  const workspace = getConversationWorkspace(contactId);
  assert.equal(workspace.threadCount, 1);
  assert.equal(workspace.identityState, "linked");
  assert.ok(workspace.timeline.some((item) => item.kind === "incoming" && item.text.includes("keine Zeit")));
  assert.ok(workspace.timeline.some((item) => item.kind === "outgoing" && item.text.includes("bis Winter")));
});

test("rät bei doppelt vorkommenden Namen keine Thread-Zuordnung", () => {
  db.prepare("INSERT INTO contacts(profile_url,normalized_url,full_name) VALUES(?,?,?)")
    .run("https://www.linkedin.com/in/lorenz-eins", "https://www.linkedin.com/in/lorenz-eins", "Lorenz Roth");
  const chosenId = Number(db.prepare("INSERT INTO contacts(profile_url,normalized_url,full_name) VALUES(?,?,?)")
    .run("https://www.linkedin.com/in/lorenz-zwei", "https://www.linkedin.com/in/lorenz-zwei", "Lorenz Roth").lastInsertRowid);
  const unresolvedThread = "https://www.linkedin.com/messaging/thread/2-UNKLAR_100==/";
  assert.equal(resolveContactIdentity(unresolvedThread, "Lorenz Roth"), undefined);
  const conflict = db.prepare(
    "SELECT id,reason,candidate_contact_ids,status FROM contact_identity_conflicts WHERE normalized_value LIKE '%2-UNKLAR_100=='",
  ).get() as { id: number; reason: string; candidate_contact_ids: string; status: string };
  assert.match(conflict.reason, /nicht eindeutig/);
  assert.equal(JSON.parse(conflict.candidate_contact_ids).length, 2);
  assert.equal(conflict.status, "open");
  assert.equal(resolveIdentityConflict(conflict.id, chosenId), true);
  assert.equal(resolveContactIdentity(unresolvedThread)?.id, chosenId);
  assert.equal((db.prepare("SELECT status FROM contact_identity_conflicts WHERE id=?").get(conflict.id) as { status: string }).status, "resolved");
});

test.after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
