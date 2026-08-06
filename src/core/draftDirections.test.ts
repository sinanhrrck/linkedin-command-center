import assert from "node:assert/strict";
import test from "node:test";
import { directionOptions, feedbackInstruction } from "../modules/draftDirections.js";

test("bietet wirklich andere Erstnachrichten-Richtungen an", () => {
  const first = directionOptions("first");
  assert.equal(first.length, 3);
  assert.equal(new Set(first.map((item) => item.key)).size, 3);

  const next = directionOptions("first", first.map((item) => item.key));
  assert.equal(next.length, 3);
  assert.ok(next.slice(0, 2).every((item) => !first.some((old) => old.key === item.key)), "ungenutzte Richtungen kommen zuerst");
});

test("übersetzt Ablehnungsgründe in verbindliche Generierungsregeln", () => {
  assert.match(feedbackInstruction("artificial"), /natürlicher/i);
  assert.match(feedbackInstruction("too_personal"), /keine Annahmen/i);
  assert.match(feedbackInstruction("too_salesy"), /Entferne Angebot/i);
  assert.match(feedbackInstruction("custom", "Ohne Frage enden"), /Ohne Frage enden/);
});
