import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-berichte-"));
process.env.DB_PATH = join(dir, "berichte.sqlite");
const { db } = await import("../db/index.js");
const { recordCrmStage } = await import("../modules/crmStages.js");
const { bericht, wochenstart, isoLokal } = await import("../modules/berichte.js");

const heute = isoLokal(new Date());
const gestern = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return isoLokal(d); })();

function kontakt(name: string) {
  return Number(db.prepare("INSERT INTO contacts(profile_url,full_name,status) VALUES(?,?,'new')").run(`https://example.test/${name}`, name).lastInsertRowid);
}

test("Tagesbericht zählt heutige Aktionen und Ereignisse, Vergleich ist gestern", () => {
  db.prepare("INSERT INTO actions(type,target,status,created_at) VALUES('connect','a','done',datetime('now'))").run();
  db.prepare("INSERT INTO actions(type,target,status,created_at) VALUES('connect','b','done',datetime('now'))").run();
  db.prepare("INSERT INTO actions(type,target,status,created_at) VALUES('connect','c','done',datetime('now','-1 day'))").run();
  const a = kontakt("anna");
  recordCrmStage(a, "found", "bot");
  recordCrmStage(a, "invited", "bot");
  recordCrmStage(a, "accepted", "bot");
  recordCrmStage(a, "messaged", "bot");
  recordCrmStage(a, "replied", "bot", undefined, { quality: "interested" });
  const b = bericht("tag");
  assert.equal(b.zeitraum.von, heute);
  assert.equal(b.vergleich.von, gestern);
  assert.equal(b.zahlen.anfragen, 2);
  assert.equal(b.vorher.anfragen, 1);
  assert.equal(b.zahlen.angenommen, 1);
  assert.equal(b.zahlen.geantwortet, 1);
  assert.equal(b.zahlen.positiv, 1);
  assert.match(b.text, /Tagesbericht/);
  assert.match(b.text, /Anfragen: 2 \(\+1\)/);
});

test("Wochenbericht läuft Mo–So, Ereignisse zählen nur einmal, Vorwoche ist der Vergleich", () => {
  const start = wochenstart(heute);
  const b = bericht("woche");
  assert.equal(b.zeitraum.von, start);
  assert.equal(b.tage.length, 7);
  assert.equal(b.tage[0].wochentag, "Mo");
  assert.equal(b.tage[6].wochentag, "So");
  // Doppelter Durchlauf (Neustart) darf nichts hinzuzählen.
  const a = Number(db.prepare("SELECT id FROM contacts WHERE full_name='anna'").get()!["id" as never]);
  recordCrmStage(a, "accepted", "bot");
  const b2 = bericht("woche");
  assert.equal(b2.zahlen.angenommen, b.zahlen.angenommen);
  assert.ok(b2.vergleich.bis < b2.zeitraum.von);
  assert.match(b2.text, /JE TAG/);
});

test("Wochenstart ist immer ein Montag", () => {
  assert.equal(wochenstart("2026-09-22"), "2026-09-21"); // Dienstag → Montag
  assert.equal(wochenstart("2026-09-27"), "2026-09-21"); // Sonntag → derselbe Montag
  assert.equal(wochenstart("2026-09-21"), "2026-09-21");
});

test("Doppelte Ereigniszeilen (live + backfill) zählen im Bericht nur einmal", () => {
  const c = kontakt("bernd");
  recordCrmStage(c, "messaged", "bot");
  // So sah der Altbestand aus: dieselbe Stufe noch einmal unter dem Backfill-Schlüssel.
  db.prepare(
    "INSERT INTO crm_stage_events(dedupe_key,contact_id,stage,source,created_at,occurred_at) VALUES(?,?,'messaged','backfill',datetime('now'),datetime('now'))",
  ).run(`backfill:${c}:messaged`, c);
  const vorher = bericht("tag").zahlen.angeschrieben;
  const zeilen = Number((db.prepare("SELECT COUNT(*) n FROM crm_stage_events WHERE contact_id=? AND stage='messaged'").get(c) as { n: number }).n);
  assert.equal(zeilen, 2, "Testaufbau: zwei Zeilen für dieselbe Person");
  assert.equal(vorher, 2, "anna + bernd = zwei Personen, nicht drei Zeilen");
});
