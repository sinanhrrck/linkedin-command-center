import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// EIGENE Test-Datenbank, VOR dem ersten Import (2026-09-25). Vorher lief diese Datei gegen die
// echte DB: im Container schrieb der Beleg-Test bei jedem Testlauf „00000“ in `verlauf_belege`
// und löste im Cockpit die Warnung „0 von 5 Versänden im Verlauf“ aus – ganz ohne Versand.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "nextlead-empfaenger-")), "test.sqlite");
const { pruefNameFuer } = await import("../modules/outreach.js");

/**
 * Die Empfänger-Prüfung verlangt, dass der Name auf der Seite steht. LinkedIn kürzt Nachnamen
 * aber ab ("Marie K."), während die Seite den vollen Namen zeigt ("Marie Kowalczyk") – die
 * Prüfung schlug fehl und brach den Versand ab. Betraf 23 Kontakte. Bei abgekürzten Namen wird
 * deshalb nur der Vorname verlangt.
 *
 * Alle Namen hier sind frei erfunden: Diese Tests liegen in einem öffentlichen Repository,
 * echte CRM-Kontakte haben darin nichts verloren.
 */

test("vollständige Namen bleiben unverändert", () => {
  assert.equal(pruefNameFuer("Jonas Berger"), "jonas berger");
  assert.equal(pruefNameFuer("Laura Sophie Wender"), "laura sophie wender");
});

test("abgekürzte Nachnamen fallen auf den Vornamen zurück", () => {
  assert.equal(pruefNameFuer("Marie K."), "marie");
  assert.equal(pruefNameFuer("Tobias R."), "tobias");
  assert.equal(pruefNameFuer("Simon A"), "simon", "auch ohne Punkt");
});

test("zu kurze Vornamen verlangen weiterhin den vollen String", () => {
  // "Jo" wäre als Suchbegriff in einem Seitentext praktisch immer irgendwo enthalten und
  // damit als Empfänger-Nachweis wertlos – dann lieber nicht senden.
  assert.equal(pruefNameFuer("Jo M."), "jo m.");
});

test("mehrteilige Namen mit abgekürztem Ende nutzen den Vornamen", () => {
  assert.equal(pruefNameFuer("Anna Lou-Ann S."), "anna");
});

test("leere Eingabe bleibt leer (Aufrufer bricht dann ab)", () => {
  assert.equal(pruefNameFuer("   "), "");
});

/**
 * Verlaufs-Beleg-Quote: Ein systematisch gebrochener Selektor soll auffallen. Die Schwelle ist
 * bewusst niedrig (unter 30% bei mindestens 5 Versänden) – bei intaktem Selektor liegt die
 * Quote nahe 100%, ein einzelner Ausreißer darf keinen Alarm auslösen.
 */
test("Beleg-Quote schlägt erst bei systematischem Ausfall an", async () => {
  const { verlaufsBelegStand } = await import("../modules/outreach.js");
  const { setState } = await import("../db/index.js");

  setState("verlauf_belege", "");
  assert.equal(verlaufsBelegStand().verdaechtig, false, "ohne Daten kein Urteil");

  setState("verlauf_belege", "1110");
  assert.equal(verlaufsBelegStand().verdaechtig, false, "vier Versände sind noch keine Stichprobe");

  setState("verlauf_belege", "11111111");
  assert.equal(verlaufsBelegStand().verdaechtig, false, "alles bestätigt");

  setState("verlauf_belege", "11110");
  assert.equal(verlaufsBelegStand().verdaechtig, false, "ein Ausreißer ist normal");

  setState("verlauf_belege", "00000");
  const stand = verlaufsBelegStand();
  assert.equal(stand.verdaechtig, true, "kein einziger Beleg bei fünf Versänden = kaputt");
  assert.equal(stand.geprueft, 5);
  assert.equal(stand.bestaetigt, 0);

  setState("verlauf_beleg_quittiert", new Date().toISOString());
  assert.equal(verlaufsBelegStand().verdaechtig, false, "nach Quittieren drei Tage Ruhe");
  setState("verlauf_beleg_quittiert", new Date(Date.now() - 4 * 86_400_000).toISOString());
  assert.equal(verlaufsBelegStand().verdaechtig, true, "danach meldet es sich wieder");
  setState("verlauf_beleg_quittiert", "");
});
