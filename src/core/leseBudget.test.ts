import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-lesebudget-"));
process.env.DB_PATH = join(dir, "lese.sqlite");
const { db } = await import("../db/index.js");
const { config } = await import("../config.js");
const { zaehleAbruf, leseArt, leseStand, pruefeLeseBudget, LeseBudgetErschoepft } = await import("./leseBudget.js");

const leeren = () => db.prepare("DELETE FROM actions").run();

test("unterscheidet Profilaufrufe von anderen Seiten", () => {
  assert.equal(leseArt("https://www.linkedin.com/in/max-mustermann-123"), "profil");
  assert.equal(leseArt("https://www.linkedin.com/messaging/thread/2-abc/"), "seite");
  assert.equal(leseArt("https://www.linkedin.com/search/results/people/?keywords=azubi"), "seite");
  assert.equal(leseArt("https://www.linkedin.com/feed/"), "seite");
});

test("zählt Abrufe getrennt nach Art", () => {
  leeren();
  zaehleAbruf("https://www.linkedin.com/in/person-a");
  zaehleAbruf("https://www.linkedin.com/in/person-b");
  zaehleAbruf("https://www.linkedin.com/messaging/");
  const stand = leseStand();
  assert.equal(stand.profile.heute, 2);
  assert.equal(stand.seiten.heute, 1);
  assert.equal(stand.erschoepft, false, "unter dem Limit läuft alles weiter");
});

test("greift genau am Tages-Cap und nennt den Grund", () => {
  leeren();
  const cap = config.safety.dailyCaps.profileView;
  for (let i = 0; i < cap - 1; i++) zaehleAbruf(`https://www.linkedin.com/in/p-${i}`);
  assert.equal(leseStand().erschoepft, false, "eine Position vor dem Cap ist noch erlaubt");
  assert.doesNotThrow(() => pruefeLeseBudget());

  zaehleAbruf("https://www.linkedin.com/in/p-letzter");
  const stand = leseStand();
  assert.equal(stand.erschoepft, true, "am Cap ist Schluss");
  assert.match(String(stand.grund), /Profilaufrufe/);
  assert.throws(() => pruefeLeseBudget(), LeseBudgetErschoepft);
});

test("zählt nur den heutigen Tag", () => {
  leeren();
  const alt = db.prepare("INSERT INTO actions(type,target,created_at) VALUES('profileView',?,datetime('now','-2 days'))");
  for (let i = 0; i < config.safety.dailyCaps.profileView + 20; i++) alt.run(`https://www.linkedin.com/in/gestern-${i}`);
  const stand = leseStand();
  assert.equal(stand.profile.heute, 0, "vorgestern abgerufene Profile blockieren heute nicht");
  assert.equal(stand.erschoepft, false);
});

test("Seiten-Cap wirkt unabhängig vom Profil-Cap", () => {
  leeren();
  for (let i = 0; i < config.safety.dailyCaps.pageRead; i++) zaehleAbruf(`https://www.linkedin.com/messaging/thread/${i}/`);
  const stand = leseStand();
  assert.equal(stand.profile.heute, 0);
  assert.equal(stand.erschoepft, true);
  assert.match(String(stand.grund), /Seitenaufrufe/);
});
