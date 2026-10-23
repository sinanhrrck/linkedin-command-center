/**
 * AUSRICHTUNG Standard ↔ AEC (2026-10-23). Eigene Temp-DB (TEST-FALLE: nie ohne DB_PATH importieren,
 * sonst landet der Testlauf in der echten Datenbank). KI per Stub, damit der Prompt prüfbar ist.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-ausrichtung-"));
process.env.DB_PATH = join(dir, "ausrichtung.sqlite");
process.env.ANTHROPIC_API_KEY = ""; // converseStep soll über den Test-Stub laufen, nie über Claude
const { getAusrichtung, setAusrichtung, aecAktiv, ausrichtungsBlock, gespraechsKontext } = await import("../modules/ausrichtung.js");
const { promptKontext } = await import("../context.js");
const { goalForConversation } = await import("../modules/goals.js");
const { angebotsWahl, LEAD_MAGNET_VORSCHLAEGE } = await import("../modules/angebot.js");
const { getProfil } = await import("../profil.js");
const { converseStep } = await import("../modules/personalize.js");
const { setTextGeneratorForTests } = await import("./textLlm.js");

const THREAD = "https://www.linkedin.com/messaging/thread/ausrichtung-1/";
const VERLAUF = [{ sender: "Lea", text: "Wie würdest du mein Geld anlegen?" }];
let letzterPrompt = "";
setTextGeneratorForTests(async (prompt) => {
  letzterPrompt = prompt;
  return JSON.stringify({ intent: "neutral", contact: null, reply: "Gute Frage.", zusammenfassung: "", strategie: "", goalAlignment: "on_goal", suggestedGoal: null });
});

test("Standard ist der Ausgangszustand und ändert keinen Prompt", () => {
  assert.equal(getAusrichtung(), "standard");
  assert.equal(aecAktiv(), false);
  assert.equal(ausrichtungsBlock(), "");
  assert.equal(gespraechsKontext(), promptKontext());
  assert.equal(goalForConversation(THREAD, "Lea"), null);
});

test("AEC: jedes Gespräch bekommt das AEC-Ziel, auch ohne Kampagne", () => {
  setAusrichtung("aec");
  assert.equal(aecAktiv(), true);
  assert.match(gespraechsKontext(), /AUSRICHTUNG: AEC/);
  assert.match(gespraechsKontext(), /nie "AEC"/);
  const goal = goalForConversation(THREAD, "Lea");
  assert.equal(goal?.code, "AEC");
  assert.match(goal!.instruction, /Potenzialanalyse/);
  setAusrichtung("standard");
});

test("AEC: nur das Karriere-Angebot, Potenzialanalyse zuerst", () => {
  const p = { ...getProfil(), leadMagnete: LEAD_MAGNET_VORSCHLAEGE.map((m) => ({ ...m, aktiv: true })), buchungslink: "" };
  const normal = angebotsWahl(new Date("2026-10-23T10:00:00"), p);
  assert.match(normal, /Geldfragen/);
  assert.match(normal, /Gehalts-Check/);
  const aec = angebotsWahl(new Date("2026-10-23T10:00:00"), p, { nurAec: true });
  assert.match(aec, /kostenlose Potenzialanalyse/);
  assert.doesNotMatch(aec, /Gehalts-Check|Karriere-Check|Geldfragen\]/);
});

test("Antwort-Prompt: Finanzweg und Verdienst-Rechnung nur im Standard", async () => {
  await converseStep(VERLAUF, "Lea", null);
  assert.match(letzterPrompt, /WEG FINANZBERATUNG/);
  assert.match(letzterPrompt, /Rechnungs-Pitch/);
  assert.doesNotMatch(letzterPrompt, /Ausrichtung AEC/);

  setAusrichtung("aec");
  await converseStep(VERLAUF, "Lea", goalForConversation(THREAD, "Lea"));
  assert.doesNotMatch(letzterPrompt, /WEG FINANZBERATUNG/);
  assert.doesNotMatch(letzterPrompt, /Rechnungs-Pitch|nebenberuflich in 10-15/);
  assert.match(letzterPrompt, /EIN WEG \(Ausrichtung AEC\)/);
  assert.match(letzterPrompt, /AEC – Potenzialanalyse/);

  setAusrichtung("standard");
  await converseStep(VERLAUF, "Lea", null);
  assert.match(letzterPrompt, /WEG FINANZBERATUNG/, "zurückschalten stellt den alten Prompt wieder her");
});
