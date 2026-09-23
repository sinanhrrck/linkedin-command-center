import assert from "node:assert/strict";
import test from "node:test";
import { ausbildungsStand, behauptetLaufendeAusbildung } from "./ausbildungsStand.js";

test("Bankkaufmann/-frau ist der Abschluss, kein Azubi-Titel", () => {
  for (const h of [
    "Bankkaufmann bei Sparkasse Darmstadt",
    "Bankkauffrau bei UniCredit",
    "Bankkaufmann",
    "Bankkaufmann Privatkundengeschäft bei Sparkasse Schwäbisch Hall - Crailsheim",
    "Kundenberater bei Volksbank Mittelhessen",
    "Werkstudent bei Deutsche Bank",
    "Bankkaufmann (Ausbildung abgeschlossen) | Sparkasse Köln",
  ]) assert.equal(ausbildungsStand(h), "nicht_in_ausbildung", h);
});

test("echte Azubi-Headlines bleiben Azubis", () => {
  for (const h of [
    "Auszubildender Bankkaufmann bei Sparkasse Köln",
    "Azubi @ Volksbank",
    "Ausbildung zur Bankkauffrau bei der Commerzbank",
    "Bankkaufmann in Ausbildung | 2. Lehrjahr",
    "Dualer Student BWL-Bank bei Sparkasse",
  ]) assert.equal(ausbildungsStand(h), "in_ausbildung", h);
});

test("leere oder nichtssagende Headline ist unklar", () => {
  assert.equal(ausbildungsStand(null), "unklar");
  assert.equal(ausbildungsStand("Sparkasse Köln"), "unklar");
});

test("die falschen Entwürfe vom 23.09. werden erkannt", () => {
  for (const t of [
    "Hey Jan, cool dass du deine Ausbildung zum Bankkaufmann machst. Ich hab damals selbst als Azubi in der Bank angefangen. Wie erlebst du den Alltag da gerade?",
    "Hey Judith, ich hab gesehen dass du bei UniCredit deine Ausbildung zur Bankkauffrau machst. Ich bin selbst damals als Azubi in der Bank gestartet.",
    "Hey Horst, ich sehe du machst deine Ausbildung bei der VR-Bank Main-Rhön. Ich hab selbst mal als Bankkaufmann angefangen. Wie läuft's bei dir gerade in der Ausbildung?",
    "Hey Marvin, ich hab gesehen du bist im 2. Lehrjahr bei der Sparkasse Köln.",
  ]) assert.equal(behauptetLaufendeAusbildung(t), true, t);
});

test("Sinans eigene Geschichte und Rückblicke sind erlaubt", () => {
  for (const t of [
    "Hey Luis, ich hab gesehen du bist Bankkaufmann bei der Stadt-Sparkasse Solingen. Ich bin selbst aus einer Bank rausgekommen und kenne diesen Start noch gut. Wie läuft's bei dir?",
    "Hey Jonas, ich hab gesehen du bist bei der Sparkasse Köln als Bankkaufmann. Ich hab damals auch als Azubi in der Bank angefangen. Wie ging's für dich nach der Ausbildung weiter?",
    "Hey Tanja, seit deiner Ausbildung bist du ja schon eine Weile bei der VR-Bank. Was hält dich da?",
    "Ich bin selbst aus der Bank und kenn das noch aus meiner Azubi-Zeit.",
  ]) assert.equal(behauptetLaufendeAusbildung(t), false, t);
});

test("Erstnachricht: ein Neuversuch mit Korrektur, danach lieber kein Entwurf", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "nextlead-ausbildung-")), "a.sqlite");
  const { setTextGeneratorForTests } = await import("./textLlm.js");
  const { firstMessage } = await import("../modules/personalize.js");
  const fertig = { full_name: "Max Richter", headline: "Bankkaufmann bei Sparkasse Darmstadt" } as never;
  const falsch = "Hey Max, cool dass du deine Ausbildung bei der Sparkasse Darmstadt machst. Wie läuft's?";
  const richtig = "Hey Max, ich hab gesehen du bist Bankkaufmann bei der Sparkasse Darmstadt. Wie ging's nach der Ausbildung weiter?";

  const prompts: string[] = [];
  setTextGeneratorForTests(async (p) => { prompts.push(p); return prompts.length === 1 ? falsch : richtig; });
  assert.equal(await firstMessage(fertig), richtig);
  assert.match(prompts[0], /NICHT in der Ausbildung/);
  assert.match(prompts[1], /KORREKTUR/);

  setTextGeneratorForTests(async () => falsch);
  await assert.rejects(firstMessage(fertig), /laufende Ausbildung/);

  // Echte Azubis dürfen weiter auf die Ausbildung angesprochen werden.
  setTextGeneratorForTests(async () => falsch);
  assert.equal(await firstMessage({ full_name: "Max", headline: "Auszubildender bei Sparkasse" } as never), falsch);
  setTextGeneratorForTests(null);
});
