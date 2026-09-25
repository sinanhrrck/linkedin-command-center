import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// DB_PATH VOR dem ersten Import setzen – sonst schreibt der Test in die ECHTE Datenbank
// (siehe CLAUDE.md, "TEST-FALLE").
const dir = mkdtempSync(join(tmpdir(), "nextlead-suchlimit-"));
process.env.DB_PATH = join(dir, "suchlimit.sqlite");
const { getState, setState } = await import("../db/index.js");
const { events } = await import("./events.js");
const { istSuchlimitText, isoTag, naechsterMonatsanfang, suchlimitBis, markiereSuchlimit } =
  await import("./suchlimit.js");

const zuruecksetzen = () => setState("such_limit_bis", "");

test("erkennt LinkedIns Hinweis auf das Suchlimit in beiden Sprachen", () => {
  // Wortlaut aus der echten Seite vom 2026-09-25.
  assert.equal(
    istSuchlimitText("Sinan, möchten Sie uneingeschränkt suchen?\nSie haben das monatliche Limit für Profilsuchen erreicht."),
    true,
  );
  assert.equal(istSuchlimitText("You've reached the monthly limit for profile searches"), true);
  assert.equal(istSuchlimitText("You have reached the commercial use limit"), true);
  // Zeilenumbrüche und doppelte Leerzeichen dürfen die Erkennung nicht aushebeln.
  assert.equal(istSuchlimitText("… monatliche   Limit\n für Profilsuchen erreicht …"), true);
});

test("normale Suchergebnisse lösen das Limit nicht aus", () => {
  assert.equal(istSuchlimitText("Meldrick Stern • 2.\nBanking Apprentice at Deutsche Bank\nVernetzen"), false);
  assert.equal(istSuchlimitText(""), false);
  assert.equal(istSuchlimitText("Limit"), false); // einzelnes Wort reicht nicht
});

test("der Monatsanfang wird lokal gerechnet, auch über den Jahreswechsel", () => {
  assert.equal(naechsterMonatsanfang(new Date(2026, 8, 25, 23, 30)), "2026-10-01");
  assert.equal(naechsterMonatsanfang(new Date(2026, 11, 31, 23, 59)), "2027-01-01");
  // isoTag darf NICHT über UTC gehen: spät abends wäre das sonst schon der Folgetag.
  assert.equal(isoTag(new Date(2026, 8, 25, 23, 59)), "2026-09-25");
});

test("das Limit wird vermerkt und genau einmal gemeldet", () => {
  zuruecksetzen();
  let meldungen = 0;
  const horcher = () => { meldungen += 1; };
  events.on("feed:suchlimit", horcher);
  const jetzt = new Date(2026, 8, 25, 12, 0);
  markiereSuchlimit(jetzt);
  markiereSuchlimit(jetzt); // zweiter Treffer im selben Lauf
  events.off("feed:suchlimit", horcher);
  assert.equal(meldungen, 1, "eine Meldung, nicht bei jedem Fund erneut");
  assert.equal(getState("such_limit_bis"), "2026-10-01");
  assert.equal(suchlimitBis(jetzt), "2026-10-01");
});

test("zum Monatsanfang räumt sich der Vermerk beim Lesen selbst weg", () => {
  zuruecksetzen();
  markiereSuchlimit(new Date(2026, 8, 25, 12, 0));
  assert.equal(suchlimitBis(new Date(2026, 8, 30, 12, 0)), "2026-10-01", "davor bleibt die Pause");
  assert.equal(suchlimitBis(new Date(2026, 9, 1, 0, 1)), null, "am Ersten läuft die Suche wieder");
  assert.equal(getState("such_limit_bis") || "", "", "der Vermerk ist danach weg");
});

test("ohne Vermerk ist die Suche frei", () => {
  zuruecksetzen();
  assert.equal(suchlimitBis(), null);
});
