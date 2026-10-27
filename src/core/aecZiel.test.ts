/**
 * AEC-MONATSZIEL (2026-10-27). Eigene Temp-DB (TEST-FALLE: nie ohne DB_PATH importieren).
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-aec-"));
process.env.DB_PATH = join(dir, "aec.sqlite");
const { db, getState, setState } = await import("../db/index.js");
const aec = await import("../modules/aecZiel.js");
const { setAusrichtung } = await import("../modules/ausrichtung.js");

test("Werktage und Monat rechnen in lokaler Zeit", () => {
  const t = aec.werktage(new Date(2026, 9, 27, 12));
  assert.deepEqual(t, { gesamt: 22, vorbei: 18, rest: 4 });
  assert.equal(aec.monatVon(new Date(2026, 9, 31, 23, 30)), "2026-10");
});

test("Eine Person zählt genau einmal, egal aus welcher Quelle", () => {
  const a = aec.erfasseAecZusage({ threadUrl: "https://www.linkedin.com/messaging/thread/a/", teilnehmer: "Lena", quelle: "agent" });
  assert.equal(a.neu, true);
  const b = aec.erfasseAecZusage({ contactId: 7, threadUrl: "https://www.linkedin.com/messaging/thread/a/", teilnehmer: "Lena", quelle: "kalender" });
  assert.equal(b.neu, false);
  assert.equal(b.zusage.contact_id, 7, "fehlende Zuordnung wird nachgetragen");
  assert.equal(aec.erfasseAecZusage({ contactId: 7, quelle: "manuell", teilnehmer: "Lena" }).neu, false);
  assert.equal(aec.erfasseAecZusage({ teilnehmer: "Tim Test", quelle: "manuell" }).neu, true);
  assert.equal(aec.erfasseAecZusage({ teilnehmer: "  tim   test ", quelle: "manuell" }).neu, false);
  assert.throws(() => aec.erfasseAecZusage({ quelle: "manuell" }), /Name oder Kontakt/);
});

test("Ziel gilt weiter, bis ein neues gesetzt wird; Status zählt richtig", () => {
  assert.equal(aec.monatsziel("2026-10"), null);
  aec.setzeMonatsziel(20, "2026-09");
  assert.equal(aec.monatsziel("2026-10"), 20, "Vormonatsziel gilt weiter");
  aec.setzeMonatsziel(10, "2026-10");
  assert.equal(aec.monatsziel("2026-10"), 10);
  assert.throws(() => aec.setzeMonatsziel(0), /ganze Zahl/);
  const s = aec.aecStand();
  const z = s.liste[0];
  aec.setzeAecStatus(z.id, "durchgefuehrt");
  const s2 = aec.aecStand();
  assert.equal(s2.durchgefuehrt, 1);
  assert.equal(s2.zusagen, s.zusagen, "durchgeführt ändert die Zusagenzahl nicht");
  assert.throws(() => aec.setzeAecStatus(z.id, "quatsch"), /Unbekannter Status/);
});

test("Stand: Hebel nennt Ausrichtung, Steuerung stößt ohne unberührte Verbindungen nichts an", () => {
  setAusrichtung("standard");
  const s = aec.aecStand();
  assert.ok(s.ziel);
  assert.ok(s.hebel.some((h) => h.art === "ausrichtung"));
  assert.match(aec.aecStandText(s), /AEC .*von 10 Zusagen/);
  setState("netzwerk_now", "");
  const r = aec.aecSteuerung();
  assert.equal(r.angestossen, false);
  assert.equal(getState("netzwerk_now") || "", "");
  setAusrichtung("aec");
  assert.ok(!aec.aecStand().hebel.some((h) => h.art === "ausrichtung"));
  setAusrichtung("standard");
});

test("Ziel erreicht → Status erreicht, keine Steuerung", () => {
  aec.setzeMonatsziel(1);
  const s = aec.aecStand();
  assert.equal(s.status, "erreicht");
  assert.equal(aec.aecSteuerung().grund, "erreicht");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM aec_zusagen").get() as { n: number }).n, 2);
});
