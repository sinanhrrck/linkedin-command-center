/** VERNETZEN: nur der Knopf dieses Profils (2026-10-27). Reine Funktionen, keine DB. */
import assert from "node:assert/strict";
import test from "node:test";
import { istAusstehendLabel, istEinladungsLimitText, labelGehoertZu, nameAusUeberschrift, namensTeile } from "./vernetzenPruefung.js";

test("Knopf gehört nur zum Profil mit genau diesem Namen", () => {
  assert.equal(labelGehoertZu("Lena Beispiel als Kontakt einladen", "Lena Beispiel"), true);
  assert.equal(labelGehoertZu("Invite Lena Beispiel to connect", "Lena Beispiel"), true);
  assert.equal(labelGehoertZu("Tim Fremd als Kontakt einladen", "Lena Beispiel"), false, "Vorschlagskarte eines Fremden");
  assert.equal(labelGehoertZu("Lena Müller als Kontakt einladen", "Lena Beispiel"), false, "gleicher Vorname reicht nicht");
  assert.equal(labelGehoertZu("Jörg Weiß als Kontakt einladen", "Jörg Weiß"), true, "Umlaute/ß");
  assert.equal(labelGehoertZu("Anna-Lena Schmidt als Kontakt einladen", "Anna-Lena Schmidt"), true);
  assert.equal(labelGehoertZu("Max Muster als Kontakt einladen", "Dr. Max Muster"), true, "Titel zählt nicht");
  assert.equal(labelGehoertZu("Irgendwer als Kontakt einladen", ""), false, "ohne Namen nie");
  assert.equal(labelGehoertZu("Lenas Freundin als Kontakt einladen", "Lena"), false, "Wortgrenze: Lenas ≠ Lena");
  assert.deepEqual(namensTeile("Dr. Max  Muster"), ["max", "muster"]);
});

test("Ausstehend und Wochenlimit werden erkannt", () => {
  assert.equal(istAusstehendLabel("Ausstehend, klicken, um die Einladung an Lena Beispiel zurückzuziehen"), true);
  assert.equal(istAusstehendLabel("Pending, click to withdraw invitation sent to Lena"), true);
  assert.equal(istAusstehendLabel("Lena Beispiel als Kontakt einladen"), false);
  assert.equal(istEinladungsLimitText("Sie haben das wöchentliche Limit für Einladungen erreicht. Versuchen Sie es nächste Woche."), true);
  assert.equal(istEinladungsLimitText("You’ve reached the weekly invitation limit"), true);
  assert.equal(istEinladungsLimitText("Möchten Sie eine Notiz hinzufügen? Ohne Notiz senden"), false);
});

test("Name aus der Überschrift ohne Zusätze", () => {
  assert.equal(nameAusUeberschrift("Lena Beispiel (sie/ihr)"), "Lena Beispiel");
  assert.equal(nameAusUeberschrift("Lena Beispiel, CFP"), "Lena Beispiel");
  assert.equal(nameAusUeberschrift("Lena Beispiel\nAuszubildende"), "Lena Beispiel");
  assert.equal(nameAusUeberschrift(""), null);
  assert.equal(labelGehoertZu("Lena Beispiel als Kontakt einladen", nameAusUeberschrift("Lena Beispiel (sie/ihr)")), true);
});
