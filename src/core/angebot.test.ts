import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-angebot-"));
process.env.DB_PATH = join(dir, "angebot.sqlite");
const { db } = await import("../db/index.js");
const {
  leadMagnete, zweiTermine, ctaAnweisung, angebotsWahl, angebotsHinweis, erlaubteLinks,
  pruefeAngebot, speichereAngebot, beweisBlock,
} = await import("../modules/angebot.js");
const { buildReplyPrompt } = await import("../agent/prompt/promptBuilder.js");
const { followupStufe } = await import("../modules/drafts.js");
const { leeresMemory } = await import("../agent/domain/memory.js");
import type { Profil } from "../profil.js";

const basis = { name: "Sinan", persona: "p", ziel: "z", tabus: "t", stilRegeln: [], beispielNachrichten: [], winkel: { azubi: "", student: "" } } as Profil;
const karriere = { key: "pa", titel: "Potenzialanalyse", route: "karriere" as const, nutzen: "Klarheit", ablauf: "20 Min", cta: "Soll ich dir zeigen, wie das abläuft?", naechsterSchritt: "Code schicken" };
const finanzen = { key: "gc", titel: "Gehalts-Check", route: "finanzen" as const, nutzen: "Überblick", ablauf: "15 Min", cta: "Lust auf einen kurzen Check?", naechsterSchritt: "Termin" };

test("nur aktive, lieferbare Angebote werden angeboten", () => {
  const p = { ...basis, leadMagnete: [karriere, { ...finanzen, aktiv: false }, { ...karriere, key: "pdf", art: "unterlage" as const }] };
  assert.deepEqual(leadMagnete(null, p).map((m) => m.key), ["pa"], "inaktiv und Unterlage ohne Link fallen raus");
  assert.deepEqual(leadMagnete("finanzen", p), []);
});

test("zwei echte Werktags-Termine, nie am Wochenende, nie heute", () => {
  // Freitag 23.10.2026 → morgen wäre Samstag
  const t = zweiTermine(new Date(2026, 9, 23, 10));
  assert.deepEqual(t, ["Montag um 17 Uhr", "Dienstag um 18 Uhr"]);
  assert.deepEqual(zweiTermine(new Date(2026, 9, 20, 10)), ["morgen um 17 Uhr", "Donnerstag um 18 Uhr"]);
});

test("mit Buchungslink wird der Link genannt, ohne ihn zwei feste Termine", () => {
  assert.match(ctaAnweisung(new Date(2026, 9, 20), { ...basis, buchungslink: "https://cal.com/sinan" }), /cal\.com\/sinan/);
  assert.match(ctaAnweisung(new Date(2026, 9, 20), basis), /morgen um 17 Uhr oder Donnerstag um 18 Uhr/);
  assert.deepEqual(erlaubteLinks({ ...basis, buchungslink: "https://cal.com/sinan" }), ["https://cal.com/sinan"]);
});

test("Angebotswahl nennt beide Wege, der Nachfass-Hinweis genau einen", () => {
  const p = { ...basis, leadMagnete: [karriere, finanzen] };
  const wahl = angebotsWahl(new Date(2026, 9, 20), p);
  assert.match(wahl, /Potenzialanalyse/); assert.match(wahl, /Gehalts-Check/); assert.match(wahl, /Geld-\/Finanzfragen/);
  assert.match(angebotsHinweis("finanzen", undefined, p), /Gehalts-Check/);
  assert.doesNotMatch(angebotsHinweis("finanzen", undefined, p), /Potenzialanalyse/);
  assert.equal(angebotsHinweis(null, undefined, basis), "", "ohne Angebot bleibt der Prompt wie vorher");
  assert.match(beweisBlock(basis), /Behaupte keine Erfolge/);
});

test("Speichern prüft Eingaben und lässt den Rest des Profils unberührt", () => {
  const pfad = join(dir, "profil.local.json");
  writeFileSync(pfad, JSON.stringify({ name: "Sinan", persona: "bleibt", stilRegeln: ["x"] }));
  speichereAngebot({ leadMagnete: [{ ...karriere, key: "" }], beweise: "Beleg eins\n\nBeleg zwei", buchungslink: "" }, pfad);
  const neu = JSON.parse(readFileSync(pfad, "utf8"));
  assert.equal(neu.persona, "bleibt");
  assert.deepEqual(neu.stilRegeln, ["x"]);
  assert.equal(neu.leadMagnete[0].key, "potenzialanalyse");
  assert.deepEqual(neu.beweise, ["Beleg eins", "Beleg zwei"]);

  assert.throws(() => pruefeAngebot({ buchungslink: "cal.com/x" }), /https/);
  assert.throws(() => pruefeAngebot({ leadMagnete: [{ ...karriere, art: "unterlage" }] }), /braucht einen Link/);
  assert.throws(() => pruefeAngebot({ leadMagnete: [{ ...karriere, cta: "" }] }), /Frage/);
});

test("Agent: Angebot nur in den Angebots-Phasen, keine Emoji-Erlaubnis mehr", () => {
  const leer = { trust: 0.5, skepticism: 0, moneyInterest: 0, careerInterest: 0, investmentInterest: 0, humor: 0, extroversion: 0, openness: 0, financialKnowledge: 0, responseLength: 0, emojiUsage: false, beobachtungen: 3 };
  const basisPrompt = { persona: "P", profile: leer, memory: leeresMemory("Max"), letzteNachricht: "hi", teilnehmer: "Max", angebot: "# Welches Angebot?\nTEST-ANGEBOT" } as never;
  const frueh = buildReplyPrompt({ ...(basisPrompt as object), stage: "smalltalk" } as never);
  const spaet = buildReplyPrompt({ ...(basisPrompt as object), stage: "call_angebot" } as never);
  assert.doesNotMatch(frueh, /TEST-ANGEBOT/, "vor dem Bedarf wäre es ein Kaltpitch");
  assert.match(spaet, /TEST-ANGEBOT/);
  assert.doesNotMatch(spaet, /mal ein Emoji/);
});

test("Nachfass-Stufe: die zweite Nachfassung bleibt Stufe 2, auch beim Neuschreiben", () => {
  const url = "https://www.linkedin.com/in/stufe/";
  const ins = (status: string) => Number(db.prepare("INSERT INTO drafts(kind,thread_url,draft,status) VALUES('followup',?,?,?)").run(url, "x", status).lastInsertRowid);
  assert.equal(followupStufe(url), 1);
  const erste = ins("sent");
  const zweite = ins("pending");
  assert.equal(followupStufe(url), 2);
  assert.equal(followupStufe(url, zweite), 2, "Neuschreiben des zweiten Entwurfs");
  assert.equal(followupStufe(url, erste), 1, "Neuschreiben des ersten Entwurfs");
});

test("KI-Vorschläge: Antwort mit Rahmentext wird sauber übernommen, nie automatisch aktiv", async () => {
  const { kiAngebotsVorschlaege, kiAngebotSchaerfen } = await import("../modules/angebot.js");
  const { setTextGeneratorForTests } = await import("./textLlm.js");
  const prompts: string[] = [];
  setTextGeneratorForTests(async (p) => {
    prompts.push(p);
    return p.includes("JSON-Array")
      ? `Hier meine Vorschläge:\n[{"titel":"Gehalts-Check","route":"finanzen","nutzen":"Klarheit - was bleibt","ablauf":"15 Min","cta":"Lust auf einen Check?","naechsterSchritt":"Termin","warum":"schnell"},{"titel":"Karriere-Kompass","route":"karriere","nutzen":"x","ablauf":"y","cta":"z?","naechsterSchritt":"t"},{"titel":"Drei","route":"quatsch","nutzen":"a","ablauf":"b","cta":"c?","naechsterSchritt":"d"}]\nViel Erfolg!`
      : `{"titel":"Potenzialanalyse in 20 Minuten","nutzen":"Du weißt danach schwarz auf weiß, wo deine Stärken liegen","ablauf":"20 Minuten online","cta":"Soll ich dir den Zugang schicken?","naechsterSchritt":"Code","warum":"Hürde kleiner"}`;
  });
  const v = await kiAngebotsVorschlaege(basis);
  assert.equal(v.length, 3);
  assert.ok(v.every((m) => m.aktiv === false), "KI-Vorschläge wirken erst nach bewusstem Speichern");
  assert.equal(v[2].route, "karriere", "unbekannte Route fällt auf karriere zurück");
  assert.doesNotMatch(v[0].nutzen, / - /, "Gedankenstrich-Satztrenner entfernt");
  assert.match(prompts[0], /Wertformel/);
  assert.match(prompts[0], /Mehrwert/, "Tabuwörter werden der KI mitgegeben");

  const s = await kiAngebotSchaerfen({ key: "pa", titel: "Potenzialanalyse", route: "karriere", aktiv: true }, basis);
  assert.equal(s.key, "pa"); assert.equal(s.route, "karriere"); assert.equal(s.aktiv, true);
  assert.equal(s.titel, "Potenzialanalyse in 20 Minuten");
  assert.equal(s.warum, "Hürde kleiner");

  setTextGeneratorForTests(async () => "Tut mir leid, das kann ich nicht.");
  await assert.rejects(kiAngebotsVorschlaege(basis), /kein verwertbares Ergebnis/);
  await assert.rejects(kiAngebotSchaerfen({ titel: "" }, basis), /Titel/);
  setTextGeneratorForTests(null);
});
