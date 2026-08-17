import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * Am 17.08.2026 stand der Bot mittags mit „Tagesbudget für Profilaufrufe erreicht (60/60)“,
 * obwohl er nur 30 Profile geöffnet hatte: LinkedIn leitet /in/name auf /in/name/ um, und das
 * Navigations-Ereignis feuerte zweimal. Das Budget zählt jetzt verschiedene Ziele, nicht Zeilen.
 */

const dir = mkdtempSync(join(tmpdir(), "nextlead-lesebudget-"));
process.env.DB_PATH = join(dir, "lesebudget.sqlite");
const { db } = await import("../db/index.js");
const { leseStand, zaehleAbruf } = await import("./leseBudget.js");

const zeilen = (type: string) =>
  (db.prepare("SELECT COUNT(*) n FROM actions WHERE type=?").get(type) as { n: number }).n;

test("die Weiterleitung auf den Schrägstrich verbraucht kein zweites Profil", () => {
  zaehleAbruf("https://www.linkedin.com/in/frederic-dombret-b35254379");
  zaehleAbruf("https://www.linkedin.com/in/frederic-dombret-b35254379/");

  assert.equal(zeilen("profileView"), 2, "das Protokoll hält weiterhin jede Navigation fest");
  assert.equal(leseStand().profile.heute, 1, "verbraucht ist aber nur ein Profil");
});

test("unterschiedliche Schreibweisen desselben Profils sind ein Abruf", () => {
  zaehleAbruf("https://www.linkedin.com/in/oliwia-gr%c3%b6tschel-477984325");
  zaehleAbruf("https://www.linkedin.com/in/oliwia-gr%C3%B6tschel-477984325/");
  zaehleAbruf("https://www.linkedin.com/in/oliwia-gr%C3%B6tschel-477984325/?originalSubdomain=de");
  assert.equal(leseStand().profile.heute, 2, "Groß-/Kleinschreibung und Parameter sind dasselbe Profil");
});

test("zwei verschiedene Profile bleiben zwei Abrufe", () => {
  zaehleAbruf("https://www.linkedin.com/in/florian-berisha-638058414/");
  assert.equal(leseStand().profile.heute, 3);
});

test("Suchseiten mit unterschiedlicher Seitenzahl zählen einzeln", () => {
  zaehleAbruf("https://www.linkedin.com/search/results/people/?keywords=azubi&page=1");
  zaehleAbruf("https://www.linkedin.com/search/results/people/?keywords=azubi&page=1");
  assert.equal(leseStand().seiten.heute, 1, "dieselbe Trefferseite zweimal geladen ist ein Abruf");
  zaehleAbruf("https://www.linkedin.com/search/results/people/?keywords=azubi&page=2");
  assert.equal(leseStand().seiten.heute, 2, "Seite 2 ist eine andere Seite");
});

test("das Budget greift weiterhin und meldet den echten Stand", () => {
  const cap = leseStand().profile.cap;
  for (let i = leseStand().profile.heute; i < cap; i++) zaehleAbruf(`https://www.linkedin.com/in/testperson-${i}`);
  const stand = leseStand();
  assert.equal(stand.profile.heute, cap);
  assert.equal(stand.erschoepft, true);
  assert.match(stand.grund || "", new RegExp(`\\(${cap}/${cap}\\)`));
});
