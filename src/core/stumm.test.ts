/**
 * STUMM (2026-10-07): komplette Funkstille je Chat/Kontakt. Eigene Temp-DB (TEST-FALLE: nie ohne
 * DB_PATH importieren, sonst landet der Testlauf in der echten Datenbank).
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-stumm-"));
process.env.DB_PATH = join(dir, "stumm.sqlite");
const { db } = await import("../db/index.js");
const { istStumm, stummschalten, stummAufheben } = await import("../modules/stumm.js");
const { setRelationshipPolicy, proactiveDecision } = await import("../modules/relationshipPolicy.js");
const { SqliteConversationRepository } = await import("../agent/infra/sqliteConversationRepository.js");
const { sendDraft } = await import("../modules/drafts.js");

const repo = new SqliteConversationRepository(db);
let nr = 0;
function kontakt() {
  nr++;
  const url = `https://www.linkedin.com/in/stumm-${nr}/`;
  const id = Number(db.prepare("INSERT INTO contacts(profile_url,full_name,headline,status) VALUES(?,?,?,?)")
    .run(url, `Person ${nr}`, "Azubi", "replied").lastInsertRowid);
  const thread = `https://www.linkedin.com/messaging/thread/t-${nr}/`;
  db.prepare("INSERT INTO contact_identities(contact_id,identity_type,identity_value,normalized_value) VALUES(?,?,?,?)")
    .run(id, "thread_url", thread, thread);
  return { id, url, thread, name: `Person ${nr}` };
}
const entwurf = (k: ReturnType<typeof kontakt>, kind: string, threadUrl: string, status = "pending") => Number(db.prepare(
  "INSERT INTO drafts(contact_id,kind,thread_url,participant,draft,ki_original,status) VALUES(?,?,?,?,?,?,?)",
).run(k.id, kind, threadUrl, k.name, "Text", "Text", status).lastInsertRowid);
const status = (id: number) => (db.prepare("SELECT status,rejection_reason FROM drafts WHERE id=?").get(id) as { status: string; rejection_reason: string | null });

test("Kontakt stumm: alle offenen Entwürfe weg, Agent-Gespräch stumm, proaktive Ansprache aus", async () => {
  const k = kontakt();
  await repo.save({ ...(await import("../agent/domain/conversation.js")).neueConversation(k.thread, k.name) });
  const antwort = entwurf(k, "message", k.thread);
  const nachfass = entwurf(k, "followup", k.url, "approved");
  const gesendet = entwurf(k, "message", k.thread, "sent");

  const r = stummschalten({ contactId: k.id, grund: "Testgrund", quelle: "mensch" });
  assert.equal(r.contactId, k.id);
  assert.ok(r.threads.includes(k.thread));
  assert.equal(status(antwort).status, "discarded");
  assert.equal(status(antwort).rejection_reason, "stumm");
  assert.equal(status(nachfass).status, "discarded");
  assert.equal(status(gesendet).status, "sent", "Versandprotokoll bleibt unangetastet");
  assert.ok(istStumm(k.thread), "Thread über den Kontakt stumm");
  assert.ok(istStumm(null, k.id), "Kontakt stumm");
  assert.equal((await repo.load(k.thread))?.status, "stumm");
  assert.equal(proactiveDecision(k.id, "first").ok, false, "Beziehungsregel sperrt proaktive Ansprache");
  // Idempotent
  const r2 = stummschalten({ contactId: k.id, grund: "nochmal", quelle: "agent" });
  assert.equal(r2.verworfen, 0);
});

test("Wieder freigeben hebt die Funkstille auf und weckt das Agent-Gespräch", async () => {
  const k = kontakt();
  await repo.save((await import("../agent/domain/conversation.js")).neueConversation(k.thread, k.name));
  stummschalten({ contactId: k.id, grund: "x", quelle: "mensch" });
  assert.ok(istStumm(k.thread));
  assert.equal(setRelationshipPolicy({ contactId: k.id, action: "resume" }), true);
  assert.equal(istStumm(k.thread), null);
  assert.equal(istStumm(null, k.id), null);
  assert.equal((await repo.load(k.thread))?.status, "aktiv");
  assert.equal(proactiveDecision(k.id, "first").ok, true);
});

test("Thread ohne CRM-Kontakt (fremder Verkäufer): nur der Chat wird stumm", () => {
  const thread = "https://www.linkedin.com/messaging/thread/fremd-1/";
  const r = stummschalten({ threadUrl: thread, participant: "Recruiter X", grund: "fremdes Angebot", quelle: "agent" });
  assert.equal(r.contactId, null);
  assert.equal(istStumm(thread)?.grund, "fremdes Angebot");
  assert.equal(stummAufheben({ threadUrl: thread }), 1);
  assert.equal(istStumm(thread), null);
});

test("sendDraft verwirft einen freigegebenen Entwurf, sobald der Kontakt stumm ist", async () => {
  const k = kontakt();
  const id = entwurf(k, "message", k.thread, "approved");
  stummschalten({ threadUrl: k.thread, grund: "Nutzer", quelle: "mensch" });
  // der Entwurf wurde beim Stummschalten schon verworfen → zweiter Schutz greift auf frische Entwürfe
  const frisch = entwurf(k, "message", k.thread, "approved");
  const r = await sendDraft(frisch);
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /stumm/);
  assert.equal(status(frisch).status, "discarded");
  assert.equal(status(id).status, "discarded");
});
