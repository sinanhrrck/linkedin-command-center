import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-varianten-"));
process.env.DB_PATH = join(dir, "varianten.sqlite");
const { db } = await import("../db/index.js");
const { waehleArm, registriereVersand, variantenStatistik, MIN_REIF_JE_ARM } = await import("../modules/varianten.js");
const { recordCrmStage } = await import("../modules/crmStages.js");

let nr = 0;
const kontakt = () => { nr++; return Number(db.prepare("INSERT INTO contacts(profile_url,full_name,status) VALUES(?,?, 'messaged')").run(`https://www.linkedin.com/in/v-${nr}/`, `Person ${nr}`).lastInsertRowid); };
const vorTagen = (t: number) => new Date(Date.now() - t * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
function versand(slot: string, arm: string, tage: number, ergebnis?: "positiv" | "negativ") {
  const id = kontakt();
  db.prepare(`INSERT INTO message_variants(dedupe_key,contact_id,kind,stage,slot,arm,sent_at,replied_at,reply_quality) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(`t:${id}`, id, "first", 0, slot, arm, vorTagen(tage), ergebnis ? vorTagen(tage - 1) : null, ergebnis === "positiv" ? "interested" : ergebnis === "negativ" ? "not_interested" : null);
}
const leeren = () => { db.prepare("DELETE FROM message_variants").run(); db.prepare("DELETE FROM drafts").run(); };

test("ein Versand zählt einmal", () => {
  leeren();
  const c = kontakt();
  assert.equal(registriereVersand({ contactId: c, kind: "first", slot: "first", arm: "erfahrung" }), true);
  assert.equal(registriereVersand({ contactId: c, kind: "first", slot: "first", arm: "erfahrung" }), false);
  assert.equal(registriereVersand({ contactId: c, kind: "first", slot: "first", arm: "gibtsnicht" }), false, "unbekannter Arm");
});

test("Antwort geht an die letzte Variante VOR der Antwort, genau einmal", () => {
  leeren();
  const c = kontakt();
  db.prepare(`INSERT INTO message_variants(dedupe_key,contact_id,kind,stage,slot,arm,sent_at) VALUES('a',?,'first',0,'first','erfahrung',?)`).run(c, vorTagen(9));
  db.prepare(`INSERT INTO message_variants(dedupe_key,contact_id,kind,stage,slot,arm,sent_at) VALUES('b',?,'followup',1,'followup:wert','erlaubnis',?)`).run(c, vorTagen(4));
  // Antwort vor 6 Tagen: gehört zur Erstnachricht, nicht zur späteren Nachfassung.
  recordCrmStage(c, "replied", "bot", undefined, { quality: "interested", occurredAt: vorTagen(6) });
  const rows = db.prepare("SELECT dedupe_key k, reply_quality q FROM message_variants ORDER BY k").all() as { k: string; q: string | null }[];
  assert.deepEqual(rows, [{ k: "a", q: "interested" }, { k: "b", q: null }]);
  // Präzisierung derselben Antwort ändert die Qualität, legt aber nichts neu an.
  recordCrmStage(c, "replied", "bot", undefined, { quality: "meeting" });
  assert.equal((db.prepare("SELECT reply_quality q FROM message_variants WHERE dedupe_key='a'").get() as { q: string }).q, "meeting");
});

test("frische Versände sind keine Niederlage, Erkundung verteilt gleichmäßig", () => {
  leeren();
  for (let i = 0; i < 20; i++) versand("first", "erfahrung", 2); // jung, keine Antwort
  const s = variantenStatistik().find((x) => x.slot === "first")!;
  const erf = s.arme.find((a) => a.key === "erfahrung")!;
  assert.equal(erf.reif, 0);
  assert.equal(erf.quote, null);
  // Die anderen Arme haben weniger Versände → werden zuerst gewählt.
  const gewaehlt = new Set(Array.from({ length: 20 }, () => waehleArm("first")!.arm));
  assert.ok(!gewaehlt.has("erfahrung"));
});

test("mit genug Daten gewinnt meistens der Arm mit mehr positiven Antworten", () => {
  leeren();
  const n = MIN_REIF_JE_ARM + 15;
  for (let i = 0; i < n; i++) versand("followup:wert", "angebot_direkt", 20, i < 12 ? "positiv" : undefined);
  for (let i = 0; i < n; i++) versand("followup:wert", "erlaubnis", 20, i < 1 ? "positiv" : i < 5 ? "negativ" : undefined);
  let a = 0;
  for (let i = 0; i < 400; i++) if (waehleArm("followup:wert")!.arm === "angebot_direkt") a++;
  assert.ok(a > 300, `Gewinner nur ${a}/400 gewählt`);
  assert.ok(a < 400, "der Zufallsanteil hält den Verlierer im Test");
});

test("Sinans Veto: oft abgelehnte Stile pausieren", () => {
  leeren();
  for (let i = 0; i < 6; i++) {
    db.prepare("INSERT INTO drafts(kind,thread_url,draft,status,variant_json) VALUES('reaktivierung',?,?,?,?)")
      .run(`https://www.linkedin.com/in/veto-${i}/`, "x", i < 4 ? "discarded" : "sent", JSON.stringify({ slot: "reaktivierung", arm: "frage_zuerst" }));
  }
  const gewaehlt = new Set(Array.from({ length: 30 }, () => waehleArm("reaktivierung")!.arm));
  assert.deepEqual([...gewaehlt], ["anlass"]);
  const s = variantenStatistik().find((x) => x.slot === "reaktivierung")!;
  assert.match(s.arme.find((a) => a.key === "frage_zuerst")!.status, /pausiert/);
  assert.equal(waehleArm("followup:beweis"), null, "Slots ohne Varianten liefern keine Wahl");
});
