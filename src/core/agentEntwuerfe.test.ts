/**
 * AGENT-ENTWÜRFE (2026-10-08): ein neuer Agent-Text verdrängt ältere, nicht freigegebene
 * Agent-Entwürfe desselben Chats, statt still zu verschwinden; eine solche Ersetzung ist KEINE
 * Ablehnung durch Sinan und erzeugt kein Veto. Eigene Temp-DB (DB_PATH VOR dem ersten Import).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-agententwuerfe-"));
process.env.DB_PATH = join(dir, "e.sqlite");
const { db } = await import("../db/index.js");
const { queueReplyDraft } = await import("../modules/drafts.js");
const { agentVertrauen } = await import("../modules/agentVertrauen.js");
const { SqliteConversationRepository } = await import("../agent/infra/sqliteConversationRepository.js");

const THREAD = "https://www.linkedin.com/messaging/thread/abc/";
const offen = () => db.prepare("SELECT id,status,intent,draft FROM drafts WHERE thread_url=? ORDER BY id").all(THREAD) as { id: number; status: string; intent: string | null; draft: string }[];
const reset = () => db.prepare("DELETE FROM drafts").run();

test("neuer Agent-Entwurf ersetzt den alten offenen Agent-Entwurf desselben Chats", () => {
  reset();
  assert.equal(queueReplyDraft(THREAD, "Anna", "Hi", "alter Schatten-Text", "agent-schatten"), true);
  assert.equal(queueReplyDraft(THREAD, "Anna", "Hi", "neue Antwort nach Sendefehler", "agent-sendefehler"), true);
  const rows = offen();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, "discarded");
  assert.equal(rows[1].status, "pending");
  assert.equal(rows[1].draft, "neue Antwort nach Sendefehler", "der aktuelle Text muss der sichtbare sein");
});

test("ein freigegebener Entwurf wird NICHT überschrieben – das war Sinans Entscheidung", () => {
  reset();
  queueReplyDraft(THREAD, "Anna", "Hi", "von Sinan freigegeben", "agent-vorsichtig");
  db.prepare("UPDATE drafts SET status='approved' WHERE thread_url=?").run(THREAD);
  assert.equal(queueReplyDraft(THREAD, "Anna", "Hi", "späterer Agent-Text", "agent-sendefehler"), false);
  assert.equal(offen().length, 1);
  assert.equal(offen()[0].status, "approved");
});

test("ein offener Nicht-Agent-Entwurf bleibt unangetastet, auch ohne Intent", () => {
  reset();
  db.prepare("INSERT INTO drafts(kind,thread_url,participant,draft,status) VALUES('message',?,?,?,'pending')").run(THREAD, "Anna", "Sinans eigener Entwurf");
  assert.equal(queueReplyDraft(THREAD, "Anna", "Hi", "Agent-Text", "agent-eskalation"), false, "fremder offener Entwurf blockiert");
  assert.equal(queueReplyDraft(THREAD, "Anna", "Hi", "Alt-Text", undefined), false, "ohne Agent-Intent nie ersetzen");
  assert.equal(offen().length, 1);
});

test("eine Ersetzung zählt nicht als Ablehnung im Agent-Vertrauen", () => {
  reset();
  for (let i = 0; i < 10; i++) {
    db.prepare(
      "INSERT INTO drafts(kind,thread_url,participant,draft,ki_original,status,intent,freigabe_quelle,freigegeben_at) VALUES('message',?,?,?,?,'sent','agent-vorsichtig','mensch',datetime('now'))",
    ).run(`${THREAD}${i}`, "P", "t", "t");
  }
  for (let i = 0; i < 5; i++) {
    db.prepare(
      "INSERT INTO drafts(kind,thread_url,participant,draft,ki_original,status,intent,rejection_reason,freigabe_quelle) VALUES('message',?,?,?,?,'discarded','agent-schatten','superseded','mensch')",
    ).run(`${THREAD}s${i}`, "P", "t", "t");
  }
  const v = agentVertrauen();
  assert.equal(v.abgelehnt, 0, "superseded darf nicht als Ablehnung zählen");
  assert.equal(v.veto, false);
  assert.equal(v.stufe, 1);
});

test("Schatten-Entscheidungen werden zu 'entwurf' – nichts wird beim Umschalten nachgesendet", () => {
  const repo = new SqliteConversationRepository(db);
  repo.merkeVerarbeitung(THREAD, "h1", "senden", "Schatten-Antwort");
  repo.merkeVerarbeitung(`${THREAD}2`, "h2", "senden", "schon raus");
  repo.markiereGesendet(`${THREAD}2`);
  assert.equal(repo.schattenEntscheidungenEntschaerfen(), 1);
  assert.equal(repo.verarbeitungsStand(THREAD)?.decision, "entwurf");
  assert.equal(repo.verarbeitungsStand(`${THREAD}2`)?.decision, "senden", "Gesendetes bleibt, wie es ist");
});

test.after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
