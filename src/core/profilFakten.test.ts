import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-fakten-"));
process.env.DB_PATH = join(dir, "fakten.sqlite");
const { db } = await import("../db/index.js");
const { extrahiereProfilFakten, speichereProfilFakten, profilFakten } = await import("../modules/profilFakten.js");
const { deleteContact } = await import("../modules/crm.js");
const { setTextGeneratorForTests } = await import("./textLlm.js");
const { firstMessage } = await import("../modules/personalize.js");

const EINZEL = `Max Richter
Max Richter
Auszubildender bei Sparkasse Darmstadt
Darmstadt, Hessen, Deutschland · Kontaktinfo
Info
Info
Seit Kurzem fertig mit der Ausbildung und jetzt in der Kundenberatung. Mich reizt, Menschen bei Geldfragen weiterzuhelfen. Schreibt mir gern: max@example.com oder 0171 1234567
…mehr anzeigen
Aktivität
Aktivität
Berufserfahrung
Berufserfahrung
Kundenberater
Sparkasse Darmstadt · Vollzeit
Aug. 2024–Heute · 1 Jahr 2 Monate
Darmstadt, Hessen, Deutschland
Auszubildender
Sparkasse Darmstadt · Ausbildung
Aug. 2021–Juli 2024 · 3 Jahre
Ausbildung
Ausbildung`;

const GRUPPIERT = `Berufserfahrung
Volksbank Mittelhessen
3 Jahre 1 Monat
Privatkundenberaterin
Vollzeit
Feb. 2025–Heute · 8 Monate
Auszubildende
Ausbildung
Sept. 2022–Jan. 2025 · 2 Jahre 5 Monate
Kenntnisse`;

const ENGLISCH = `About
Banking apprentice with a passion for numbers. see more
Experience
Apprentice
Deutsche Bank · Apprenticeship
Sep 2024 - Present · 1 yr 1 mo
Education`;

test("Einzelposten: aktuelle Rolle, Firma, seit, Info ohne Kontaktdaten", () => {
  const f = extrahiereProfilFakten(EINZEL);
  assert.equal(f.rolle, "Kundenberater");
  assert.equal(f.firma, "Sparkasse Darmstadt");
  assert.equal(f.seit, "Aug. 2024");
  assert.match(f.ueber!, /Kundenberatung/);
  assert.doesNotMatch(f.ueber!, /@|0171|mehr anzeigen/);
});

test("nach Firma gruppiert und englische Oberfläche", () => {
  const g = extrahiereProfilFakten(GRUPPIERT);
  assert.equal(g.rolle, "Privatkundenberaterin");
  assert.equal(g.firma, "Volksbank Mittelhessen");
  assert.equal(g.seit, "Feb. 2025");
  const e = extrahiereProfilFakten(ENGLISCH);
  assert.equal(e.rolle, "Apprentice");
  assert.equal(e.firma, "Deutsche Bank");
  assert.match(e.ueber!, /Banking apprentice/);
});

test("unbekannter Text liefert nichts statt Unsinn", () => {
  assert.deepEqual(extrahiereProfilFakten("Irgendwas\nohne Abschnitte"), { rolle: null, firma: null, seit: null, ueber: null, erfahrung: null, erstes_jahr: null });
  const lang = extrahiereProfilFakten(`Info\n${"sehr langer Text ".repeat(60)}\nAktivität`);
  assert.ok(lang.ueber!.length <= 502);
});

test("speichern überschreibt Bekanntes nicht mit leer, Löschen nimmt die Fakten mit", () => {
  const url = "https://www.linkedin.com/in/max-fakten/";
  const id = Number(db.prepare("INSERT INTO contacts(profile_url,full_name,headline,status) VALUES(?,?,?, 'accepted')").run(url, "Max Richter", "Auszubildender bei Sparkasse Darmstadt").lastInsertRowid);
  assert.equal(speichereProfilFakten(url, extrahiereProfilFakten(EINZEL)), true);
  speichereProfilFakten(url, { rolle: null, firma: null, seit: null, ueber: "Neuer Info-Text, der lang genug ist." });
  assert.equal(profilFakten(id)!.rolle, "Kundenberater");
  assert.match(profilFakten(id)!.ueber!, /Neuer Info-Text/);
  assert.equal(speichereProfilFakten("https://www.linkedin.com/in/gibtsnicht/", extrahiereProfilFakten(EINZEL)), false);
});

test("Prompt nutzt die frische Rolle – eine veraltete Azubi-Headline macht keinen Azubi", async () => {
  const c = db.prepare("SELECT * FROM contacts WHERE profile_url='https://www.linkedin.com/in/max-fakten/'").get() as { id: number };
  const prompts: string[] = [];
  setTextGeneratorForTests(async (p) => { prompts.push(p); return "Hey Max, ich hab gesehen du bist jetzt Kundenberater bei der Sparkasse Darmstadt. Wie gefällt dir der Wechsel?"; });
  await firstMessage(c as never);
  assert.match(prompts[0], /Aktuelle Rolle laut Profil: Kundenberater bei Sparkasse Darmstadt \(seit Aug\. 2024\)/);
  assert.match(prompts[0], /NICHT in der Ausbildung/, "Rolle schlägt die veraltete Headline");
  setTextGeneratorForTests(null);
  deleteContact(c.id);
  assert.equal(profilFakten(c.id), null);
});

test("Zielgruppen-Fakten: alle Positionstitel, frühestes Jahr aus Stelle bzw. Abschluss, kein Seitenfuß", () => {
  const AUSBILDERIN = `Petra Beispiel
Bankkauffrau bei Sparkasse KölnBonn
Berufserfahrung
Ausbilderin für Bankkaufleute
Sparkasse KölnBonn · Vollzeit
Jan. 2012–Heute · 14 Jahre
Köln
Privatkundenberaterin
Sparkasse KölnBonn · Vollzeit
Aug. 2004–Dez. 2011 · 7 Jahre 5 Monate
Ausbildung
Ausbildung
Sparkassenakademie NRW
2001 – 2004
Kenntnisse
Info
Barrierefreiheit
Talent Solutions
Community-Richtlinien`;
  const f = extrahiereProfilFakten(AUSBILDERIN);
  assert.match(f.erfahrung ?? "", /Ausbilderin für Bankkaufleute/);
  assert.match(f.erfahrung ?? "", /Privatkundenberaterin/);
  assert.equal(f.erstes_jahr, 2004);
  assert.equal(f.ueber, null, "Seitenfuß ist kein Info-Text");

  // Gruppiertes Format: „Ausbildung“ als Anstellungsart beendet den Block NICHT.
  const g = extrahiereProfilFakten(GRUPPIERT);
  assert.match(g.erfahrung ?? "", /Privatkundenberaterin \| Auszubildende/);
  assert.equal(g.erstes_jahr, 2022);

  // Azubi: Schulzeit ab 2012 zählt nicht, nur der Abschluss.
  const azubi = extrahiereProfilFakten(`Berufserfahrung
Auszubildender
Sparkasse Köln · Ausbildung
Aug. 2024–Heute · 1 Jahr 2 Monate
Ausbildung
Gymnasium Köln
2012 – 2024
Kenntnisse`);
  assert.equal(azubi.erstes_jahr, 2024);
});
