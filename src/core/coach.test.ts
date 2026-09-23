import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-coach-"));
process.env.DB_PATH = join(dir, "coach.sqlite");
const { db } = await import("../db/index.js");
const { kiCoach } = await import("../modules/coach.js");
const { setTextGeneratorForTests } = await import("./textLlm.js");

const url = "https://www.linkedin.com/in/lena-coach/";
const cid = Number(db.prepare("INSERT INTO contacts(profile_url,full_name,headline,status) VALUES(?,?,?, 'messaged')").run(url, "Lena Vogt", "Bankkauffrau bei Sparkasse Köln").lastInsertRowid);
const entwurf = (kind: string, text: string, extra: { stufe?: number; phase?: string } = {}) =>
  Number(db.prepare("INSERT INTO drafts(contact_id,kind,thread_url,participant,draft,status,sequence_stage,phase) VALUES(?,?,?,?,?, 'pending', ?, ?)")
    .run(cid, kind, url, "Lena Vogt", text, extra.stufe ?? null, extra.phase ?? "message").lastInsertRowid);

test("Coach liefert Urteil + Vorschlag und prüft den Vorschlag wie jeden Entwurf", async () => {
  let prompt = "";
  setTextGeneratorForTests(async (p) => { prompt = p; return `Klar: {"staerke":"Persönlicher Einstieg.","aendern":"Frage leichter machen.","vorschlag":"Hey Lena, wie läuft's bei der Sparkasse Köln? Und was kommt danach?"}`; });
  const r = await kiCoach(entwurf("first", "Hey Lena, na?"));
  assert.equal(r.staerke, "Persönlicher Einstieg.");
  assert.match(r.vorschlag, /Hey Lena/);
  assert.equal(r.pruefung?.ok, false, "zwei Fragen fallen auf");
  assert.match(prompt, /NICHT in der Ausbildung/, "Coach kennt den Ausbildungsstand");
  assert.match(prompt, /ENTWURF:\nHey Lena, na\?/);

  setTextGeneratorForTests(async (p) => { prompt = p; return `{"staerke":"a","aendern":"b","vorschlag":"Hey Lena, ich meld mich nicht mehr. Schreib einfach, wenn es passt."}`; });
  const ab = await kiCoach(entwurf("followup", "x", { stufe: 2 }));
  assert.match(prompt, /hier KEINE Frage/, "Schlussstrich-Stufe wird erkannt");
  assert.equal(ab.pruefung?.ok, true);
});

test("keine Richtungswahl, kein Kauderwelsch", async () => {
  await assert.rejects(kiCoach(entwurf("first", "[]", { phase: "approach" })), /keinen Text/);
  setTextGeneratorForTests(async () => "Sorry.");
  await assert.rejects(kiCoach(entwurf("first", "Hey Lena")), /kein verwertbares/);
  setTextGeneratorForTests(null);
});
