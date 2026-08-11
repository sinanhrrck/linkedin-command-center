import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-governor-"));
process.env.DB_PATH = join(dir, "governor.sqlite");
const { db, getState, setState } = await import("../db/index.js");

// Alte Versionen hinterließen bei einer schwachen Quote eine globale Pause.
setState("paused", "1");
setState("pause_reason", "Akzeptanzrate 15% < 30%");
setState("working_hours_off", "1");
const { governor } = await import("./safetyGovernor.js");

test("glättet die Akzeptanzrate über 14 Tage", () => {
  const add = db.prepare(
    `INSERT INTO contacts(profile_url,status,invited_at,accepted_at)
     VALUES(?, 'invited', datetime('now', ?), ?)`,
  );
  for (let i = 0; i < 20; i++) {
    add.run(`https://example.test/alt-${i}`, "-10 days", i < 8 ? new Date().toISOString() : null);
    add.run(`https://example.test/neu-${i}`, "-3 days", i < 2 ? new Date().toISOString() : null);
  }
  const rate = governor.acceptanceRate();
  assert.equal(rate.sample, 40, "auch die reifen Einladungen von vor zehn Tagen zählen");
  assert.equal(rate.rate, 0.25);
});

test("migriert die alte globale Pause", () => {
  assert.equal(getState("paused"), "0");
  assert.equal(governor.canDoAction("profileView").ok, true, "andere Bot-Arbeit bleibt erlaubt");
});

/**
 * GESTAFFELTE AKZEPTANZ-BREMSE (2026-08-06). Der frühere harte Stopp unter 30% legte den
 * kompletten Betrieb stumm und konnte sich nicht selbst auflösen: ohne neue Einladungen keine
 * neuen Annahmen. Bei 25% darf deshalb das halbe Tageskontingent laufen; erst unter 20% ist
 * ganz Schluss. Die Quote im Test liegt bei 25% (siehe erster Testfall).
 */
test("bei schwacher Quote läuft das halbe Kontingent weiter", () => {
  assert.equal(governor.canDoAction("connect").ok, true, "25% bremst, stoppt aber nicht");
});

test("stoppt, sobald das halbe Kontingent verbraucht ist", () => {
  const add = db.prepare("INSERT INTO actions(type,target) VALUES('connect',?)");
  for (let i = 0; i < 20; i++) add.run(`https://example.test/heute-${i}`);
  const connect = governor.canDoAction("connect");
  assert.equal(connect.ok, false);
  if (!connect.ok) assert.match(connect.reason, /halbes Kontingent|Tageslimit/);
});

test("unter der Gefahrenschwelle läuft ein kleines Recovery-Kontingent", () => {
  db.prepare("DELETE FROM actions WHERE type='connect'").run();
  // Quote auf ~8% drücken: viele reife Einladungen ohne Annahme.
  const add = db.prepare(
    "INSERT INTO contacts(profile_url,status,invited_at,accepted_at) VALUES(?,'invited',datetime('now','-6 days'),NULL)",
  );
  for (let i = 0; i < 120; i++) add.run(`https://example.test/kalt-${i}`);
  const { rate } = governor.acceptanceRate();
  assert.ok(rate < 0.2, `Quote sollte unter 20% liegen, ist ${(rate * 100).toFixed(0)}%`);
  assert.equal(governor.canDoAction("connect").ok, true, "Recovery darf weiter vernetzen");
  const addAction = db.prepare("INSERT INTO actions(type,target) VALUES('connect',?)");
  for (let i = 0; i < 3; i++) addAction.run(`https://example.test/recovery-${i}`);
  const connect = governor.canDoAction("connect");
  assert.equal(connect.ok, false);
  if (!connect.ok) assert.match(connect.reason, /Recovery-Kontingent 3\/3/);
});

test("ein defekter Sendeweg stoppt auch Kampagnennachrichten", () => {
  setState("send_health", "broken");
  const campaign = governor.canDoAction("campaign");
  assert.equal(campaign.ok, false);
  if (!campaign.ok) assert.match(campaign.reason, /Sende-Weg defekt/);
  setState("send_health", "ok");
});

test.after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
