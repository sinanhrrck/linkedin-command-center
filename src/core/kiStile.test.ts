import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-kistile-"));
process.env.DB_PATH = join(dir, "kistile.sqlite");
const { db } = await import("../db/index.js");
const { kiNeueStile } = await import("../modules/kiStile.js");
const { armeFuer, waehleArm, registriereVersand, variantenStatistik } = await import("../modules/varianten.js");
const { setTextGeneratorForTests } = await import("./textLlm.js");

let nr = 0;
function versaende(slot: string, arm: string, anzahl: number, positiv: number) {
  for (let i = 0; i < anzahl; i++) {
    nr++;
    const cid = Number(db.prepare("INSERT INTO contacts(profile_url,full_name,status) VALUES(?,?, 'messaged')").run(`https://www.linkedin.com/in/k-${nr}/`, `K ${nr}`).lastInsertRowid);
    db.prepare(`INSERT INTO message_variants(dedupe_key,contact_id,kind,stage,slot,arm,sent_at,replied_at,reply_quality) VALUES(?,?,?,?,?,?,datetime('now','-20 days'),?,?)`)
      .run(`k:${nr}`, cid, "first", 0, slot, arm, i < positiv ? "2026-09-01 10:00:00" : null, i < positiv ? "interested" : null);
  }
}

test("ohne klaren Gewinner passiert nichts – kein KI-Aufruf", async () => {
  let aufrufe = 0;
  setTextGeneratorForTests(async () => { aufrufe++; return "{}"; });
  versaende("first", "erfahrung", 10, 3);
  assert.deepEqual(await kiNeueStile(), []);
  assert.equal(aufrufe, 0);
});

test("klarer Gewinner → ein KI-Herausforderer, der mitgetestet wird; klarer Verlierer → beendet", async () => {
  versaende("first", "erfahrung", 30, 15);
  versaende("first", "kurz_direkt", 40, 2);
  versaende("first", "beobachtung", 40, 2);
  let prompt = "";
  setTextGeneratorForTests(async (p) => { prompt = p; return `{"titel":"Erfahrung + Mini-Tipp","anweisung":"Wie der Gewinner, aber der nützliche Gedanke wird als konkreter Mini-Tipp formuliert, den die Person sofort anwenden kann."}`; });
  const neu = await kiNeueStile();
  assert.deepEqual(neu.map((a) => a.art), ["neu"]);
  assert.match(prompt, /GEWINNER: "Eigene Erfahrung \+ Gedanke"/);
  const ki = armeFuer("first").find((a) => a.ki)!;
  assert.equal(ki.titel, "Erfahrung + Mini-Tipp");
  assert.equal(waehleArm("first")!.arm, ki.key, "neuer Arm hat die wenigsten Versände → wird erkundet");
  assert.equal(variantenStatistik().find((s) => s.slot === "first")!.arme.find((a) => a.key === ki.key)!.ki, true);

  assert.deepEqual(await kiNeueStile(), [], "höchstens ein aktiver KI-Arm je Slot");

  versaende("first", ki.key, 45, 0);
  const weg = await kiNeueStile();
  assert.ok(weg.some((a) => a.art === "beendet" && a.titel === "Erfahrung + Mini-Tipp"));
  assert.ok(!armeFuer("first").some((a) => a.key === ki.key), "beendet → nicht mehr wählbar");
  const c = Number(db.prepare("INSERT INTO contacts(profile_url,full_name,status) VALUES('https://www.linkedin.com/in/spaet/','Spät','messaged')").run().lastInsertRowid);
  assert.equal(registriereVersand({ contactId: c, kind: "first", slot: "first", arm: ki.key }), true, "Versand eines Entwurfs aus aktiver Zeit zählt noch");
  setTextGeneratorForTests(null);
});
