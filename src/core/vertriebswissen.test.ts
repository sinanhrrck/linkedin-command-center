import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-wissen-"));
process.env.DB_PATH = join(dir, "test.sqlite");
process.env.VERTRIEBSWISSEN_PATH = join(dir, "vertriebswissen.md");
const { vertriebswissen, zerlegeKapitel } = await import("./vertriebswissen.js");
const { generateText, setTextGeneratorForTests } = await import("./textLlm.js");

// Frei erfundener Mini-Auszug im Aufbau der echten Datei (die liegt nur im Datenordner, nie im Repo).
const BIBEL = `# Die Vertriebsbibel
# TEIL 5 · EINWÄNDE
## 19. Die Einwand-Bibliothek
### „Kein Interesse."
Akzeptieren.
---
# TEIL 8 · MEISTERSCHAFT
## 23. Die 20 häufigsten Fehler
1. Pitch in der ersten Nachricht.
## C. Sätze, die Türen öffnen
- „Ganz ohne Druck."`;

test("ohne Datei: kein Wissen, alles läuft wie vorher", () => {
  assert.equal(vertriebswissen("gespraech"), "");
});

test("Kapitel je Zweck, Regeln des Auftrags haben Vorrang, Gliederungszeilen fallen weg", () => {
  writeFileSync(process.env.VERTRIEBSWISSEN_PATH!, BIBEL);
  const k = zerlegeKapitel(BIBEL);
  assert.deepEqual([...k.keys()], ["19", "23", "C"]);
  assert.doesNotMatch(k.get("19")!, /TEIL 8/);
  const g = vertriebswissen("gespraech");
  assert.match(g, /Einwand-Bibliothek/);
  assert.match(g, /Ganz ohne Druck/);
  assert.doesNotMatch(g, /häufigsten Fehler/, "Fehlerliste gehört zum Coach, nicht ins Gespräch");
  assert.match(g, /Vorrang/);
  assert.match(vertriebswissen("coach"), /häufigsten Fehler/);
  assert.equal(vertriebswissen("gespraech"), g, "byte-gleich, sonst trifft der Prompt-Cache nicht");
});

test("generateText reicht das Wissen getrennt vom Auftrag weiter", async () => {
  let gesehen: string | undefined;
  setTextGeneratorForTests(async (_p, w) => { gesehen = w; return "ok"; });
  await generateText("Auftrag", undefined, vertriebswissen("gespraech"));
  assert.match(gesehen ?? "", /Einwand-Bibliothek/);
  setTextGeneratorForTests(null);
});
