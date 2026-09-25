import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-leadbew-"));
process.env.DB_PATH = join(dir, "leadbew.sqlite");
const { db } = await import("../db/index.js");
const { kiLeadBewertung, leadBewertungStand } = await import("../modules/leadBewertung.js");
const { nextNewContacts } = await import("../modules/crm.js");
const { setTextGeneratorForTests } = await import("./textLlm.js");

const neu = (name: string, headline: string, score = 50) =>
  Number(db.prepare("INSERT INTO contacts(profile_url,full_name,headline,status,lead_score) VALUES(?,?,?, 'new', ?)").run(`https://www.linkedin.com/in/${name.toLowerCase().replace(/\s/g, "-")}/`, name, headline, score).lastInsertRowid);

test("bewertet in Gruppen, ignoriert Fremd-IDs, sortiert aus nur bei klarem Nein, Reihenfolge folgt der KI", async () => {
  const azubi = neu("Anna Azubi", "Auszubildende Bankkauffrau", 40);
  const recruiter = neu("Rolf Recruiter", "Talent Acquisition Lead", 60);
  const mittel = neu("Mia Mittel", "Industriekauffrau", 70);
  let aufrufe = 0;
  setTextGeneratorForTests(async (p) => {
    aufrufe++;
    assert.match(p, /Anna Azubi \| Auszubildende Bankkauffrau/);
    return `Hier: [{"id":${azubi},"note":88,"fit":"partner","grund":"Bank-Azubi, Orientierung nach Ausbildung"},{"id":${recruiter},"note":8,"fit":"keiner","grund":"Recruiter"},{"id":${mittel},"note":15,"fit":"beide","grund":"andere Branche"},{"id":99999,"note":100,"fit":"beide","grund":"erfunden"}]`;
  });
  assert.equal(await kiLeadBewertung(60), 3);
  assert.equal(aufrufe, 1);
  const st = (id: number) => db.prepare("SELECT status, ki_score, ki_fit, score_grund FROM contacts WHERE id=?").get(id) as { status: string; ki_score: number; ki_fit: string; score_grund: string | null };
  assert.equal(st(recruiter).status, "skipped");
  assert.match(st(recruiter).score_grund!, /^KI: Recruiter/);
  assert.equal(st(mittel).status, "new", "niedrige Note, aber nicht „keiner“ → bleibt drin");
  assert.equal(nextNewContacts(5)[0].id, azubi, "KI-Note schlägt die alte Regel-Note");
  assert.deepEqual(leadBewertungStand(), { bewertet: 3, offen: 0, aussortiert: 1 });
  assert.equal(await kiLeadBewertung(60), 0, "schon bewertete werden nicht erneut bezahlt");
  setTextGeneratorForTests(null);
});

test("liest Code-Zäune und abgeschnittene Antworten, versucht bei Unlesbarem genau einmal neu", async () => {
  const { leseBewertungen } = await import("../modules/leadBewertung.js");
  assert.equal(leseBewertungen('```json\n[{"id":1,"note":50,"fit":"beide","grund":"x"}]\n```')?.length, 1);
  assert.equal(leseBewertungen('[{"id":1,"note":50,"fit":"beide","grund":"x"},{"id":2,"note":6')?.length, 1, "abgeschnitten → vollständige Objekte zählen");
  assert.equal(leseBewertungen("Dazu brauche ich mehr Angaben."), null);

  const a = neu("Ben Bank", "Auszubildender Bankkaufmann");
  const b = neu("Cem Code", "Softwareentwickler");
  let aufrufe = 0;
  setTextGeneratorForTests(async () => (++aufrufe === 1 ? "Gern, hier die Bewertung:" : `[{"id":${a},"note":80,"fit":"partner","grund":"Azubi"}]`));
  assert.equal(await kiLeadBewertung(60), 1);
  assert.equal(aufrufe, 2);

  aufrufe = 0;
  setTextGeneratorForTests(async () => { aufrufe++; return "Das kann ich nicht bewerten."; });
  await assert.rejects(kiLeadBewertung(60), /Antwort: „Das kann ich nicht bewerten\.“/);
  assert.equal(aufrufe, 2, "genau ein Neuversuch, nicht mehr");
  assert.equal((db.prepare("SELECT ki_bewertet_at FROM contacts WHERE id=?").get(b) as { ki_bewertet_at: string | null }).ki_bewertet_at, null);
  setTextGeneratorForTests(null);
});
