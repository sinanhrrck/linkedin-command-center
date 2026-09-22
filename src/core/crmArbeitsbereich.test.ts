import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-arbeitsbereich-"));
process.env.DB_PATH = join(dir, "arbeitsbereich.sqlite");
const { db } = await import("../db/index.js");
const { setStageManually, recordCrmStage } = await import("../modules/crmStages.js");
const { addContactNote, listContactNotes, deleteContactNote } = await import("../modules/contactNotes.js");
const { getUnifiedContactTimeline } = await import("../modules/contactTimeline.js");

const neuerKontakt = (url: string, extra = "") =>
  Number(db.prepare(`INSERT INTO contacts(profile_url,full_name,status${extra ? ",aus_netzwerk" : ""}) VALUES(?,'Test','messaged'${extra ? ",1" : ""})`).run(url).lastInsertRowid);

test("beobachtete Bot-Tatsachen sind NICHT von Hand setzbar", () => {
  const id = neuerKontakt("https://example.test/hand-1");
  // Genau das ist der Angriff auf die Zahlen: wer 'accepted' klicken darf, schönt die
  // Annahmequote. Die Regel muss hart greifen, nicht nur in der Oberfläche.
  for (const stufe of ["invited", "accepted", "messaged", "replied", "found", "suitable"] as const) {
    const ergebnis = setStageManually(id, stufe);
    assert.equal(ergebnis.ok, false, `${stufe} durfte nicht gesetzt werden`);
    assert.ok(ergebnis.grund, `${stufe} braucht einen Grund`);
  }
  assert.equal((db.prepare("SELECT COUNT(*) n FROM crm_stage_events WHERE contact_id=?").get(id) as { n: number }).n, 0);
});

test("menschliche Einschätzungen sind setzbar und zählen genau einmal", () => {
  const id = neuerKontakt("https://example.test/hand-2");
  assert.equal(setStageManually(id, "qualified").ok, true);
  assert.equal(setStageManually(id, "meeting").ok, true);
  // Zweiter Klick auf dieselbe Stufe: fachlicher Dedupe-Schlüssel, kein zweites Ereignis.
  setStageManually(id, "meeting");
  const zeilen = db.prepare("SELECT stage,source FROM crm_stage_events WHERE contact_id=? ORDER BY stage").all(id);
  assert.deepEqual(zeilen, [{ stage: "meeting", source: "manual" }, { stage: "qualified", source: "manual" }]);
  assert.equal((db.prepare("SELECT stage FROM sales_outcomes WHERE contact_id=?").get(id) as { stage: string }).stage, "meeting");
});

test("eine Stufe aus dem Netzwerk bekommt nie invited/accepted", () => {
  const id = neuerKontakt("https://example.test/netz", "netz");
  assert.equal(setStageManually(id, "accepted").ok, false);
  assert.equal(setStageManually(id, "invited").ok, false);
});

test("unbekannte Stufe und fehlender Kontakt werden abgewiesen", () => {
  const id = neuerKontakt("https://example.test/hand-3");
  assert.equal(setStageManually(id, "quatsch" as never).ok, false);
  assert.equal(setStageManually(999999, "won").ok, false);
  assert.equal(setStageManually(0, "won").ok, false);
});

test("Notizen landen mit Zeitstempel in der Kontaktspur", () => {
  const id = neuerKontakt("https://example.test/notiz");
  recordCrmStage(id, "messaged", "bot");
  const notizId = addContactNote(id, "  Telefonat: will im Winter nochmal sprechen.  ");
  assert.equal(listContactNotes(id)[0].text, "Telefonat: will im Winter nochmal sprechen.");

  const spur = getUnifiedContactTimeline(id);
  const notiz = spur.find((eintrag) => eintrag.kind === "note");
  assert.ok(notiz, "Notiz fehlt in der Kontaktspur");
  assert.equal(notiz?.text, "Telefonat: will im Winter nochmal sprechen.");

  // Zweimal lesen darf die Spur nicht verdoppeln (Backfill ist idempotent).
  assert.equal(getUnifiedContactTimeline(id).filter((e) => e.kind === "note").length, 1);

  assert.equal(deleteContactNote(notizId), true);
  assert.equal(listContactNotes(id).length, 0);
});

test("leere Notiz und unbekannter Kontakt werfen", () => {
  const id = neuerKontakt("https://example.test/notiz-leer");
  assert.throws(() => addContactNote(id, "   "));
  assert.throws(() => addContactNote(999999, "Text"));
});

test.after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
