import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-memory-"));
process.env.DB_PATH = join(dir, "memory.sqlite");
const { db } = await import("../db/index.js");
const {
  attachDraftContext,
  getConversationMemory,
  interpretConversationMemory,
  rememberConversationMessage,
  validateProactiveContext,
} = await import("../modules/conversationMemory.js");

const contactId = Number(db.prepare(
  "INSERT INTO contacts(profile_url,full_name,status) VALUES('https://example.test/alexander-memory','Alexander Beispiel','replied')",
).run().lastInsertRowid);

test("strukturiert den Alexander-Fall mit Aussage, Absicht und zugesagtem Zeitpunkt", () => {
  const parsed = interpretConversationMemory(
    "Ich habe aktuell keine Zeit. Würde aber Richtung Winter darauf zurückkommen.",
    new Date("2026-08-11T10:00:00+02:00"),
  );
  assert.equal(parsed.intent, "busy");
  assert.equal(parsed.commitment, "Im Winter 2026 erneut melden");
  assert.equal(parsed.nextContactAt, "2026-12-01 08:00:00");
  assert.match(parsed.lastStatement || "", /keine Zeit/);
});

test("speichert denselben Gesprächsstand idempotent und blockiert unpassende Kampagnen", () => {
  const occurredAt = new Date("2026-08-11T10:00:00Z");
  rememberConversationMessage(contactId, "Aktuell keine Zeit, bitte im Winter wieder melden.", "test", occurredAt);
  const first = getConversationMemory(contactId);
  assert.equal(first?.version, 1);
  rememberConversationMessage(contactId, "Aktuell keine Zeit, bitte im Winter wieder melden.", "test", occurredAt);
  assert.equal(getConversationMemory(contactId)?.version, 1, "ein Neustart darf die Memory-Version nicht künstlich erhöhen");
  const validation = validateProactiveContext(contactId, new Date("2026-08-20T10:00:00Z"));
  assert.equal(validation.ok, false);
  if (!validation.ok) assert.match(validation.reason, /Winter.*keine Kampagnennachricht/);
});

test("friert den verwendeten Kontext am Entwurf ein und erkennt spätere Änderungen", () => {
  const draftId = Number(db.prepare(
    "INSERT INTO drafts(contact_id,kind,thread_url,participant,incoming,draft) VALUES(?,'event','https://example.test/alexander-memory','Alexander Beispiel','campaign:1','Einladung')",
  ).run(contactId).lastInsertRowid);
  const attached = attachDraftContext(draftId, contactId);
  assert.equal(attached.ok, false);
  const draft = db.prepare("SELECT context_evidence_json,context_validation,context_memory_version FROM drafts WHERE id=?").get(draftId) as
    { context_evidence_json: string; context_validation: string; context_memory_version: number };
  assert.equal(draft.context_validation, "blocked");
  assert.equal(JSON.parse(draft.context_evidence_json).commitment, "Im Winter 2026 erneut melden");

  rememberConversationMessage(contactId, "Jetzt passt es wieder, ich bin interessiert.", "test", new Date("2026-12-02T10:00:00Z"));
  assert.equal(getConversationMemory(contactId)?.intent, "interested");
  assert.ok((getConversationMemory(contactId)?.version || 0) > draft.context_memory_version);
  assert.equal(validateProactiveContext(contactId, new Date("2026-12-02T11:00:00Z")).ok, true);
});

test("ignoriert gelöschte Systemnachrichten und erkennt konkrete Monate", () => {
  const deleted = interpretConversationMemory("Diese Nachricht wurde gelöscht.", new Date("2026-08-11T12:00:00"));
  assert.equal(deleted.lastStatement, null);

  const december = interpretConversationMemory(
    "Im Dezember stehen bei mir die ersten Übernahmegespräche an, und ab da schaue ich mal, wie es weitergeht.",
    new Date("2026-08-11T12:00:00"),
  );
  assert.equal(december.intent, "later");
  assert.equal(december.nextContactAt, "2026-12-01 08:00:00");
  assert.equal(december.openPoint, null);
});

test("erkennt eine höfliche Absage als Absage", () => {
  const result = interpretConversationMemory(
    "Das habe ich bereits getan bei einem Beratungsunternehmen, aber vielen Dank!",
    new Date("2026-08-11T12:00:00"),
  );
  assert.equal(result.intent, "not_interested");
});

test.after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
