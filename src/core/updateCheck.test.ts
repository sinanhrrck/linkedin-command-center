import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

/**
 * Die In-App-Aktualisierung hat für Beta-Versionen nie funktioniert (entdeckt 2026-08-17):
 * `Number("0-beta")` ist NaN, und `/releases/latest` blendet Vorabversionen aus. Sinan sah
 * dauerhaft eine veraltete App und suchte den Fehler im Anwendungscode.
 */
const require_ = createRequire(import.meta.url);
const { istNeuer, neuestesRelease } = require_("../../desktop/version.cjs") as {
  istNeuer: (a: string, b: string) => boolean;
  neuestesRelease: (r: unknown) => { tag_name: string } | null;
};

test("erkennt die nächste Beta als neuer – genau der Fall, der nie ausgelöst hat", () => {
  assert.equal(istNeuer("v0.8.0-beta.8", "0.8.0-beta.7"), true);
  assert.equal(istNeuer("0.8.0-beta.7", "0.8.0-beta.8"), false);
  assert.equal(istNeuer("0.8.0-beta.10", "0.8.0-beta.9"), true, "zweistellig, nicht alphabetisch");
});

test("eine Vorabversion ist älter als die fertige Fassung", () => {
  assert.equal(istNeuer("0.8.0", "0.8.0-beta.8"), true);
  assert.equal(istNeuer("0.8.0-beta.8", "0.8.0"), false);
  assert.equal(istNeuer("0.8.0", "0.8.0"), false);
});

test("vergleicht weiterhin normale Versionen numerisch", () => {
  assert.equal(istNeuer("0.1.10", "0.1.9"), true);
  assert.equal(istNeuer("0.3.0", "0.8.0-beta.7"), false, "das alte Release darf kein Downgrade auslösen");
  assert.equal(istNeuer("1.0.0", "0.9.9"), true);
});

test("wählt die neueste Veröffentlichung inklusive Vorabversionen, aber ohne Entwürfe", () => {
  const releases = [
    { tag_name: "v0.3.0", draft: false, prerelease: false },
    { tag_name: "v0.8.0-beta.8", draft: false, prerelease: true },
    { tag_name: "v0.9.0", draft: true, prerelease: false },
    { tag_name: "v0.8.0-beta.7", draft: false, prerelease: true },
  ];
  assert.equal(neuestesRelease(releases)?.tag_name, "v0.8.0-beta.8");
  assert.equal(neuestesRelease([]), null);
  assert.equal(neuestesRelease(null), null);
});
