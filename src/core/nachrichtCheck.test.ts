import assert from "node:assert/strict";
import test from "node:test";
import { istPlausibleNachricht } from "./nachrichtCheck.js";

/**
 * Der Kauderwelsch-Schutz darf echtes Deutsch NICHT blockieren. Am 06.08.2026 tat er genau das:
 * "selbstständig" enthält die Kette "lbstst" und flog raus – vier von zehn "technischen
 * Problemen" im Dashboard, und weil nach jedem Block ein neuer Entwurf entstand, im Kreis
 * (20 Versuche für einen einzigen Kontakt). Diese Tests halten beide Seiten fest.
 */

// Nachbildungen echter Entwürfe, Namen frei erfunden (öffentliches Repository).
const echteNachrichten = [
  "Hey Jannik, sehr cool dass du da konkret reinwillst. Willst du in den Sales-Bereich oder selbstständig?",
  "Hey Nico, spannend dass du die Finanzbranche in der Selbstständigkeit zu wählen überlegst. Wie kam es dazu?",
  "Hey Mia, ich hab gesehen du machst deine Ausbildung bei der Sparkasse. Wie erlebst du den Alltag gerade?",
  "Hey Ben, durchschnittlich verdienen Azubis dort wenig. Ist das bei dir auch so?",
];

for (const [i, text] of echteNachrichten.entries()) {
  test(`lässt echte deutsche Nachricht #${i + 1} durch`, () => {
    const r = istPlausibleNachricht(text);
    assert.equal(r.ok, true, `fälschlich blockiert (${r.grund}): ${text.slice(0, 60)}`);
  });
}

test("blockiert Tastatur-Mashing weiterhin", () => {
  for (const müll of [
    "Hey xkfjghwq, qwrtzpfg mnbvcxz dfghjklm.",
    "Hallo, asdfghjkl qwrtzp bcdfghjklm zxcvbnm.",
  ]) {
    assert.equal(istPlausibleNachricht(müll).ok, false, `hätte blockiert werden müssen: ${müll}`);
  }
});

test("blockiert Fehler- und Platzhaltertexte", () => {
  assert.equal(istPlausibleNachricht("undefined").ok, false);
  assert.equal(istPlausibleNachricht("").ok, false);
});
