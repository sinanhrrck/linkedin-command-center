/**
 * TRAININGS-WEBSITE 1:1 (2026-10-23): Die Website bündelt src/trainingsweb/kern.ts und füttert ihn mit
 * baueSnapshot(). Geprüft wird, dass dabei GENAU das entsteht, was der echte Bot benutzt:
 *  - Gesprächsantwort: dieselben Prompts wie agentRunner (gespraechsKontext + angebotsWahl, gleiches Datum)
 *  - Erstnachricht: derselbe Prompt wie personalize.firstMessage für einen Kontakt der Zielgruppe
 * Eigene Temp-DB (TEST-FALLE: nie ohne DB_PATH importieren). KI per Stub.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-trainingsweb-"));
process.env.DB_PATH = join(dir, "tw.sqlite");
process.env.ANTHROPIC_API_KEY = "";
const { db } = await import("../db/index.js");
const { setTextGeneratorForTests } = await import("./textLlm.js");
const { baueSnapshot } = await import("../trainingsweb/snapshot.js");
const kern = await import("../trainingsweb/kern.js");
const { gespraechsKontext, setAusrichtung } = await import("../modules/ausrichtung.js");
const { angebotsWahl } = await import("../modules/angebot.js");
const { handleIncomingMessage } = await import("../agent/application/handleIncomingMessage.js");
const { neueConversation } = await import("../agent/domain/conversation.js");
const { firstMessage } = await import("../modules/personalize.js");
const { regelEntscheiden } = await import("../modules/training.js");

const ANALYSE = JSON.stringify({ intents: ["smalltalk"], signale: { trust: 0.5, responseLength: 20 }, fakten: {}, kontakt: null, zusammenfassung: "Kennenlernen" });
function aufzeichner() {
  const prompts: string[] = [];
  const llm = async (p: string) => { prompts.push(p); return p.startsWith("Analysiere") ? ANALYSE : "Sehr cool. Wie bist du zur Bank gekommen?"; };
  return { prompts, llm };
}
const verlauf = [
  { sender: "Sinan", text: "Hey Lena, ich bin Sinan. Wie läuft's bei dir?" },
  { sender: "Lena", text: "ganz gut, weiß aber nicht ob ich nach der ausbildung bleib" },
];
const jetzt = new Date("2026-10-23T10:00:00");

test("Gesprächsantwort: Website-Kern und echter Agent schicken identische Prompts", async () => {
  // Eine freigegebene Trainings-Regel muss auf beiden Seiten ankommen.
  db.prepare("INSERT INTO sim_regeln(bereich,regel) VALUES('gespraech','Erzähl kurz von dir, bevor du fragst.')").run();
  regelEntscheiden(Number((db.prepare("SELECT id FROM sim_regeln").get() as { id: number }).id), "annehmen");
  for (const ausr of ["standard", "aec"] as const) {
    setAusrichtung(ausr);
    const snap = baueSnapshot(jetzt);
    const live = aufzeichner(), web = aufzeichner();
    const conv = neueConversation("t", "Lena", "Lena");
    await handleIncomingMessage(conv, verlauf, { persona: gespraechsKontext(), angebot: angebotsWahl(jetzt, undefined, { nurAec: ausr === "aec" }), analyzeLlm: live.llm, replyLlm: live.llm, maxRegenerierungen: 1 });
    await kern.antwortWieLive(snap, ausr, conv, verlauf, web.llm, jetzt);
    assert.ok(live.prompts.length >= 2);
    assert.deepEqual(web.prompts, live.prompts, `Ausrichtung ${ausr}`);
    assert.match(web.prompts.at(-1)!, /Erzähl kurz von dir/);
  }
  setAusrichtung("standard");
});

test("Erstnachricht: Website-Kern und personalize.firstMessage bauen denselben Prompt", async () => {
  const zg = db.prepare("SELECT id,name FROM zielgruppen WHERE aktiv=1 ORDER BY id LIMIT 1").get() as { id: number; name: string } | undefined;
  assert.ok(zg, "Erststart legt eine aktive Zielgruppe an");
  const id = Number(db.prepare("INSERT INTO contacts(profile_url,full_name,headline,status,zielgruppe_id) VALUES(?,?,?,?,?)")
    .run("https://www.linkedin.com/in/tw-1/", "Lena Beispiel", "Auszubildende Bankkauffrau bei der Sparkasse", "accepted", zg.id).lastInsertRowid);
  const snap = baueSnapshot(jetzt);
  const variante = snap.erstnachricht.varianten[0] ?? null;

  const livePrompts: string[] = [];
  setTextGeneratorForTests(async (p) => { livePrompts.push(p); return "Hey Lena, ich bin Sinan. Wie erlebst du die Ausbildung bei der Sparkasse gerade?"; });
  const c = db.prepare("SELECT * FROM contacts WHERE id=?").get(id) as Parameters<typeof firstMessage>[0];
  await firstMessage(c, undefined, null, undefined, undefined, snap.erstnachricht.eigeneAnleitung ? null : variante);

  const webPrompts: string[] = [];
  const r = await kern.erstnachrichtWieLive(snap, { name: "Lena Beispiel", headline: "Auszubildende Bankkauffrau bei der Sparkasse" },
    async (p) => { webPrompts.push(p); return "Hey Lena, ich bin Sinan. Wie erlebst du die Ausbildung bei der Sparkasse gerade?"; },
    () => 0);
  setTextGeneratorForTests(null);
  assert.equal(r.text, "Hey Lena, ich bin Sinan. Wie erlebst du die Ausbildung bei der Sparkasse gerade?");
  assert.equal(webPrompts[0], livePrompts[0]);
  assert.match(webPrompts[0], new RegExp(`Zielgruppe „${zg.name}“`));
});

test("Erstnachricht, die die Ausgangsprüfung zweimal nicht besteht, wird wie live verworfen", async () => {
  const snap = baueSnapshot(jetzt);
  const r = await kern.erstnachrichtWieLive(snap, { name: "Tim", headline: "Azubi Bankkaufmann" }, async () => "Hey Tim – 🚀 willst du reich werden? Klick hier: https://example.com ?", () => 0);
  assert.equal(r.text, "");
  assert.ok(r.grund);
});
