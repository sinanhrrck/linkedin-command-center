import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../web/command-center.js", import.meta.url), "utf8");

test("Entwurfsaktionen sind an ihren sichtbaren Prüfbereich gebunden", () => {
  // Arbeitskorb und Kampagne können gleichzeitig gerendert sein. Globale IDs würden dann
  // den unsichtbaren, zuerst im DOM stehenden Knopf treffen – genau der sporadische Totklick.
  assert.doesNotMatch(source, /id="(?:review-|reject-feedback|custom-feedback)/);
  assert.match(source, /reviewer\.querySelector\('\[data-review-action="approve"\]'\)/);
  assert.match(source, /bindDraftDelete\(draft, reviewer\)/);
  assert.match(source, /a\.art === "review"/);
  assert.match(source, /key: "comments", kinds: \["comment"\]/);
});
