import test from "node:test";
import assert from "node:assert/strict";
import { goalDefinition, isGoalCode } from "../modules/goals.js";
import { linkedinPeopleSearchUrl } from "../modules/missions.js";

test("B1, P1 und AEC sind drei eigenständige Gesprächswege", () => {
  assert.equal(isGoalCode("B1"), true);
  assert.equal(isGoalCode("P1"), true);
  assert.equal(isGoalCode("AEC"), true);
  assert.equal(goalDefinition("B1").label, "Kunde");
  assert.equal(goalDefinition("P1").label, "Vertriebspartner");
  assert.equal(goalDefinition("AEC").label, "AEC");
});

test("LinkedIn-Such-URLs entstehen aus Freitext ohne manuelle URL-Eingabe", () => {
  const url = new URL(linkedinPeopleSearchUrl("Bankkaufleute Heidelberg & Mannheim"));
  assert.equal(url.hostname, "www.linkedin.com");
  assert.equal(url.pathname, "/search/results/people/");
  assert.equal(url.searchParams.get("keywords"), "Bankkaufleute Heidelberg & Mannheim");
});

