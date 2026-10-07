/**
 * SCHWEIGEN (2026-10-07): wann der Agent bewusst NICHT antwortet. Reine Domänenlogik + Orchestrator
 * mit Fake-KI – kein Browser, keine DB, kein echter KI-Verbrauch.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { dauerhaftSchweigen, einmaligSchweigen } from "../agent/domain/policy/schweigen.js";
import { handleIncomingMessage } from "../agent/application/handleIncomingMessage.js";
import { neueConversation } from "../agent/domain/conversation.js";

const analyse = (intents: string[], extra: Record<string, unknown> = {}) => async () =>
  JSON.stringify({ intents, signale: { trust: 0.5 }, fakten: {}, kontakt: null, zusammenfassung: "Testlage", ...extra });
const antwort = async () => "Klingt gut, erzähl gern mehr davon.";
const deps = (intents: string[], extra: Record<string, unknown> = {}) => ({ analyzeLlm: analyse(intents, extra), replyLlm: antwort, persona: "Persona", maxRegenerierungen: 0 });
const verlauf = (letzte: string) => [
  { sender: "Sinan", text: "Hey Max, wie läuft die Ausbildung bei dir?" },
  { sender: "Max", text: letzte },
];

test("ausdrücklicher Kontakt-Stopp: dauerhaft schweigen, auch ohne KI-Intent", () => {
  const r = dauerhaftSchweigen([], "Bitte nicht mehr anschreiben, danke.");
  assert.equal(r?.art, "dauerhaft");
  assert.equal(r?.quelle, "kontaktverbot");
  assert.equal(dauerhaftSchweigen([], "Lassen Sie mich bitte in Ruhe")?.quelle, "kontaktverbot");
});

test("Abwesenheitsnotiz und Newsletter: automatisch erkannt, kein Intent nötig", () => {
  assert.equal(dauerhaftSchweigen([], "Vielen Dank für Ihre Nachricht. Ich bin bis 14.10. nicht erreichbar.")?.quelle, "automatisch");
  assert.equal(dauerhaftSchweigen([], "Hier ist unser Newsletter für Oktober.")?.quelle, "automatisch");
  assert.equal(dauerhaftSchweigen(["automatische_nachricht"], "Hallo zusammen, ihr wurdet eingeladen.")?.quelle, "automatisch");
});

test("fremdes Angebot kommt nur über den KI-Intent, nicht über Wortmuster", () => {
  assert.equal(dauerhaftSchweigen([], "Wir haben eine Stelle als Teamleiter, hättest du Interesse?"), null);
  assert.equal(dauerhaftSchweigen(["fremdes_angebot", "offene_frage"], "Wir haben eine Stelle als Teamleiter, hättest du Interesse?")?.quelle, "fremdes_angebot");
});

test("Gesprächsende und Kurz-Reaktion: einmalig schweigen, Frage oder Chance gewinnt immer", () => {
  assert.equal(einmaligSchweigen(["gespraechsende"], "Danke dir, alles Gute!", { eigeneNachrichten: 2 })?.quelle, "gespraechsende");
  assert.equal(einmaligSchweigen([], "Ok 👍", { eigeneNachrichten: 1 })?.quelle, "reaktion");
  assert.equal(einmaligSchweigen([], "👍", { eigeneNachrichten: 1 })?.quelle, "reaktion");
  assert.equal(einmaligSchweigen([], "Ok", { eigeneNachrichten: 0 }), null, "ohne eigene Nachricht ist ein Ok kein Schlusspunkt");
  assert.equal(einmaligSchweigen(["gespraechsende"], "Danke! Wie läuft das genau?", { eigeneNachrichten: 2 }), null, "eine Frage verdient eine Antwort");
  assert.equal(einmaligSchweigen(["gespraechsende", "interesse"], "Danke, klingt spannend.", { eigeneNachrichten: 2 }), null);
  assert.equal(einmaligSchweigen([], "Ich hab gerade 2024 die Ausbildung abgeschlossen und überlege was jetzt kommt", { eigeneNachrichten: 2 }), null);
});

test("Orchestrator: Verkäufer mit Telefonnummer wird NICHT als gebuchter Lead übergeben, sondern stumm", async () => {
  const conv = neueConversation("https://www.linkedin.com/messaging/thread/1/", "Max");
  const e = await handleIncomingMessage(conv, verlauf("Wir bieten Lead-Listen für Finanzberater. Ruf mich an: 0171 1234567"),
    deps(["fremdes_angebot", "kontakt_geteilt"], { kontakt: "0171 1234567" }));
  assert.equal(e.typ, "schweigen");
  if (e.typ === "schweigen") { assert.equal(e.art, "dauerhaft"); assert.equal(e.quelle, "fremdes_angebot"); }
  assert.equal(e.conversation.status, "stumm");
});

test("Orchestrator: fremdes Angebot mitten in einem echten Gespräch geht an den Menschen", async () => {
  const conv = { ...neueConversation("https://www.linkedin.com/messaging/thread/2/", "Max"), stage: "vertrauen" as const };
  const e = await handleIncomingMessage(conv, verlauf("Übrigens, ich vertreibe nebenbei Versicherungen – brauchst du was?"), deps(["fremdes_angebot"]));
  assert.equal(e.typ, "eskalieren");
  assert.equal(e.conversation.status, "aktiv");
});

test("Orchestrator: Kontakt-Stopp schlägt den Abschiedsgruß – kein Text mehr", async () => {
  const conv = neueConversation("https://www.linkedin.com/messaging/thread/3/", "Max");
  const e = await handleIncomingMessage(conv, verlauf("Kein Interesse, bitte nicht mehr anschreiben."), deps(["ablehnung"]));
  assert.equal(e.typ, "schweigen");
  if (e.typ === "schweigen") assert.equal(e.quelle, "kontaktverbot");
});

test("Orchestrator: freundlicher Schlusspunkt → einmalig still, Gespräch bleibt offen", async () => {
  const conv = neueConversation("https://www.linkedin.com/messaging/thread/4/", "Max");
  const e = await handleIncomingMessage(conv, verlauf("Danke dir, alles Gute!"), deps(["gespraechsende"]));
  assert.equal(e.typ, "schweigen");
  if (e.typ === "schweigen") assert.equal(e.art, "einmalig");
  assert.equal(e.conversation.status, "aktiv");
});

test("Orchestrator: echte Antwort mit Interesse wird weiterhin beantwortet", async () => {
  const conv = neueConversation("https://www.linkedin.com/messaging/thread/5/", "Max");
  const e = await handleIncomingMessage(conv, verlauf("Läuft gut, bin im zweiten Lehrjahr und überlege was danach kommt."), deps(["karriere_interesse", "positives_signal"]));
  assert.equal(e.typ, "senden");
});
