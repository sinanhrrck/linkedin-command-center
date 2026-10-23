/**
 * TRAINING (2026-10-23): simulierter Chat → Bewertung → Regelvorschlag → erst nach Freigabe wirksam.
 * Eigene Temp-DB (TEST-FALLE: nie ohne DB_PATH importieren). KI per Stub, nach Prompt-Art verteilt.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-training-"));
process.env.DB_PATH = join(dir, "training.sqlite");
process.env.ANTHROPIC_API_KEY = ""; // alles über den Test-Stub, nie über Claude
const { db } = await import("../db/index.js");
const { setTextGeneratorForTests } = await import("./textLlm.js");
const { starteSimulation, simAntwort, beendeSimulation, regelEntscheiden, trainingUebersicht, importiereTrainings } = await import("../modules/training.js");
const { gespraechsKontext } = await import("../modules/ausrichtung.js");
const { promptKontext } = await import("../context.js");

let zusageIntent = false;
const prompts: string[] = [];
setTextGeneratorForTests(async (prompt) => {
  prompts.push(prompt);
  if (prompt.includes("Du verbesserst einen LinkedIn-Vertriebsbot"))
    return JSON.stringify([{ bereich: "gespraech", regel: "Frag nicht zweimal hintereinander nach dem Warum.", begruendung: "Tester fand es verhörartig." }]);
  if (prompt.startsWith("Analysiere in einem LinkedIn-Verkaufschat"))
    return JSON.stringify({ intents: zusageIntent ? ["termin_zusage"] : ["smalltalk"], signale: { trust: 0.5, responseLength: 20 }, fakten: {}, kontakt: null, zusammenfassung: "Kennenlernen" });
  if (prompt.includes("LinkedIn-Erstnachrichten")) return "Hey Lea, ich bin Sinan. Hab selbst bei der Bank gelernt. Wie läuft's bei dir?";
  return "Sehr cool. Was hat dich damals zur Bank gebracht?";
});

const zaehle = (t: string) => (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
const echteTabellen = () => ["contacts", "drafts", "actions", "crm_stage_events"].map(zaehle);
const vorher = echteTabellen();

test("Simulation schreibt Erstnachricht und Antworten, ohne echte Daten anzufassen", async () => {
  const chat = await starteSimulation({ tester: "Sinan", name: "Lea", headline: "Auszubildende Bankkauffrau" });
  assert.equal(chat.verlauf.length, 1);
  assert.equal(chat.verlauf[0].art, "bot");
  const weiter = await simAntwort(chat.id, "Läuft gut, bin im zweiten Lehrjahr");
  assert.equal(weiter.status, "laeuft");
  assert.deepEqual(weiter.verlauf.map((m) => m.art), ["bot", "lead", "bot"]);
  assert.deepEqual(echteTabellen(), vorher, "kein Kontakt, Entwurf, Versand oder Funnel-Ereignis");
});

test("Termin-Zusage beendet den Bot-Teil mit Übergabe an Sinan", async () => {
  const chat = await starteSimulation({ tester: "Team", name: "Tom" });
  zusageIntent = true;
  const ende = await simAntwort(chat.id, "Ja klar, morgen 17 Uhr passt");
  zusageIntent = false;
  assert.equal(ende.status, "uebergabe");
  assert.equal(ende.verlauf.at(-1)?.art, "hinweis");
  await assert.rejects(simAntwort(chat.id, "Hallo?"), /abgeschlossen/);
});

test("Bewertung braucht Zusage und Note und erzeugt nur einen Vorschlag", async () => {
  const chat = await starteSimulation({ tester: "Sinan", name: "Mia" });
  await assert.rejects(beendeSimulation(chat.id, { feedback: "egal" }), /zugesagt/);
  const r = await beendeSimulation(chat.id, { zusage: "nein", note: 2, feedback: "Zweimal nach dem Warum gefragt" });
  assert.equal(r.vorschlaege, 1);
  await assert.rejects(beendeSimulation(chat.id, { zusage: "ja", note: 5 }), /schon bewertet/);
  assert.equal(gespraechsKontext(), promptKontext(), "Vorschlag wirkt noch nicht auf echte Gespräche");
});

test("Erst Annehmen macht die Regel wirksam, Abschalten nimmt sie wieder raus", () => {
  const regel = trainingUebersicht().regeln.find((x) => x.status === "vorschlag")!;
  regelEntscheiden(regel.id, "annehmen", "Frag nie zweimal hintereinander nach dem Warum.");
  assert.match(gespraechsKontext(), /LEHREN AUS TRAININGS-CHATS[\s\S]*Frag nie zweimal hintereinander nach dem Warum\./);
  regelEntscheiden(regel.id, "aus");
  assert.equal(gespraechsKontext(), promptKontext());
  assert.throws(() => regelEntscheiden(regel.id, "verwerfen"), /nicht mehr offen/);
});

test("Import von der Trainingsseite: wiederholbar, nur Vorschläge, Beispiele erst nach Freigabe", () => {
  const datei = {
    format: "nextlead-training", version: 1,
    sitzungen: [{
      id: "run-abc", modus: "bot", ausrichtung: "aec", tester: "Kollegin", erstellt: "2026-10-23T10:00:00Z",
      lead: { name: "Jonas", headline: "Azubi Bankkaufmann" },
      verlauf: [{ rolle: "sinan", text: "Hey Jonas, ich bin Sinan. Wie läuft's bei dir?" }, { rolle: "lead", text: "Gut, danke" }],
      ergebnis: { zusage: "ja", kiUrteil: "Lead hat zugesagt" },
      vorschlaege: [
        { bereich: "beispiel", text: "Kenn ich. Bei mir war's genauso, bis ich mal genauer hingeschaut hab.", begruendung: "kurz, eigene Erfahrung" },
        { bereich: "gespraech", text: "Erzähl kurz von dir, bevor du die nächste Frage stellst.", begruendung: "wirkte menschlicher" },
      ],
    }],
  };
  const r1 = importiereTrainings(datei);
  assert.deepEqual(r1, { sitzungen: 1, neueSitzungen: 1, vorschlaege: 2 });
  assert.deepEqual(importiereTrainings(datei), { sitzungen: 1, neueSitzungen: 0, vorschlaege: 0 }, "zweiter Import legt nichts doppelt an");
  assert.equal(gespraechsKontext(), promptKontext(), "importierte Vorschläge wirken noch nicht");
  const beispiel = trainingUebersicht().regeln.find((x) => x.bereich === "beispiel")!;
  regelEntscheiden(beispiel.id, "annehmen");
  assert.match(gespraechsKontext(), /SO KLINGT EIN MENSCH[\s\S]*Bei mir war's genauso/);
  const chat = trainingUebersicht().chats.find((c) => (c as { quelle?: string }).quelle === "link") as { modus: string; zusage: string } | undefined;
  assert.equal(chat?.modus, "bot");
  assert.equal(chat?.zusage, "ja");
  assert.equal(echteTabellen().join(), vorher.join(), "Import berührt keine echten Daten");
  assert.throws(() => importiereTrainings({ sitzungen: [] }), /keine Export-Datei/);
});
