import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-kianalyse-"));
process.env.DB_PATH = join(dir, "kianalyse.sqlite");
const { db } = await import("../db/index.js");
const { kiWochenanalyse, letzteAnalyse, analyseAlsText } = await import("../modules/kiAnalyse.js");
const { setTextGeneratorForTests } = await import("./textLlm.js");

test("Analyse bekommt Zahlen, Ablehnungen und Antworten ohne Namen, speichert das Ergebnis", async () => {
  db.prepare("INSERT INTO draft_feedback(draft_id,kind,reason,instruction,rejected_text) VALUES(1,'first','too_salesy','weniger Werbung','x')").run();
  db.prepare("INSERT INTO drafts(kind,thread_url,participant,incoming,draft,status,intent) VALUES('message','t','Max Geheim','Klingt spannend, erzähl mehr','y','pending','chance')").run();
  let prompt = "";
  setTextGeneratorForTests(async (p) => { prompt = p; return `{"kurzfazit":"Antworten sind der Engpass.","empfehlungen":[{"titel":"Angebot schärfen","warum":"Wenig positive Antworten.","wo":"Einstellungen → Dein Angebot"},{"titel":"B","warum":"b","wo":"x"},{"titel":"C","warum":"c","wo":"y"},{"titel":"D","warum":"d","wo":"z"}]}`; });
  const a = await kiWochenanalyse();
  assert.equal(a.empfehlungen.length, 3, "genau drei");
  assert.match(prompt, /LAUFENDE WOCHE/);
  assert.match(prompt, /VORWOCHE/);
  assert.match(prompt, /keine eigenen Varianten anlegbar/);
  assert.match(prompt, /too_salesy 1×/);
  assert.match(prompt, /\[chance\] Klingt spannend/);
  assert.doesNotMatch(prompt, /Max Geheim/, "keine Namen an die KI");
  assert.match(prompt, /NIEMALS Limits/);
  assert.equal(letzteAnalyse()?.kurzfazit, "Antworten sind der Engpass.");
  assert.match(analyseAlsText(a), /1\. Angebot schärfen/);
  setTextGeneratorForTests(async () => "nichts");
  await assert.rejects(kiWochenanalyse(), /keine verwertbare/);
  assert.equal(letzteAnalyse()?.kurzfazit, "Antworten sind der Engpass.", "ein Fehlschlag überschreibt nichts");
  setTextGeneratorForTests(null);
});
