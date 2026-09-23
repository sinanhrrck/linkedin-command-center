import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-assistent-"));
process.env.DB_PATH = join(dir, "assistent.sqlite");
const { setState } = await import("../db/index.js");
const { frageAssistent, lageBericht } = await import("../modules/assistent.js");
const { setTextGeneratorForTests } = await import("./textLlm.js");

test("die Lage enthält Stillstand, Warteschlange und Sicherheitszustand", () => {
  setState("send_stop", "1");
  const l = lageBericht();
  assert.match(l, /Not-Aus: AN/);
  assert.match(l, /Nachrichten: gestoppt/);
  assert.match(l, /Vernetzungsanfragen:/);
  assert.match(l, /Nachfass-Plan: 1\. nach 4 Tagen: wert/);
  setState("send_stop", "0");
});

test("Frage geht mit Handbuch, Lage und kurzem Verlauf an die KI", async () => {
  let prompt = "";
  setTextGeneratorForTests(async (p) => { prompt = p; return "  Weil der Not-Aus an ist.  "; });
  const verlauf = Array.from({ length: 12 }, (_, i) => ({ rolle: i % 2 ? "assistent" : "du", text: `Nachricht ${i}` })) as never;
  assert.equal(await frageAssistent("Warum sendet er nichts?", verlauf), "Weil der Not-Aus an ist.");
  assert.match(prompt, /# NextLead – Handbuch/);
  assert.match(prompt, /# Aktuelle Lage/);
  assert.match(prompt, /FRAGE: Warum sendet er nichts\?/);
  assert.doesNotMatch(prompt, /Nachricht 3\b/, "nur die letzten 8 Wortwechsel");
  assert.match(prompt, /Nachricht 11/);
  await assert.rejects(frageAssistent("   "), /Frage eingeben/);
  setTextGeneratorForTests(null);
});
