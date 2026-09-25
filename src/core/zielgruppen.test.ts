import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-zielgruppen-"));
process.env.DB_PATH = join(dir, "zielgruppen.sqlite");
const { db, setState } = await import("../db/index.js");
const { pruefeZielgruppe } = await import("./zielgruppenRegel.js");
const zg = await import("../modules/zielgruppen.js");
const { nextNewContacts, messagedAwaitingFollowup } = await import("../modules/crm.js");
const { deliverFirstMessage } = await import("../modules/drafts.js");
const { firstMessage } = await import("../modules/personalize.js");
const { setTextGeneratorForTests } = await import("./textLlm.js");

let nr = 0;
const kontakt = (headline: string, status = "new", extra: Record<string, unknown> = {}) => {
  nr++;
  const id = Number(db.prepare("INSERT INTO contacts(profile_url,normalized_url,full_name,headline,status,lead_score) VALUES(?,?,?,?,?,60)")
    .run(`https://www.linkedin.com/in/p${nr}/`, `https://www.linkedin.com/in/p${nr}/`, `Person ${nr}`, headline, status).lastInsertRowid);
  for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE contacts SET ${k}=? WHERE id=?`).run(v as never, id);
  return id;
};

test("Regel: Ausschluss schlägt Erkennung, Berufsjahre nur wenn bekannt", () => {
  const r = { erkennung: "Ausbildung, Azubi", ausschluss: "Leiter, Manager", max_berufsjahre: 5 };
  const jetzt = new Date("2026-09-25");
  assert.equal(pruefeZielgruppe({ headline: "Azubi Bankkaufmann bei Sparkasse" }, r, jetzt).ok, true);
  assert.match(pruefeZielgruppe({ headline: "Filialleiter Taunus Sparkasse" }, r, jetzt).grund, /leiter/);
  assert.match(pruefeZielgruppe({ headline: "Ausbildungsleiter Volksbank" }, r, jetzt).grund, /leiter/, "Ausschluss gewinnt auch bei Erkennungswort");
  assert.equal(pruefeZielgruppe({ headline: "Bankkauffrau bei Volksbank" }, r, jetzt).ok, false, "ohne Erkennungswort raus");
  assert.match(pruefeZielgruppe({ headline: "Ausbildung Bankkauffrau", seit: "Aug. 2004" }, r, jetzt).grund, /2004/);
  assert.equal(pruefeZielgruppe({ headline: "Ausbildung Bankkauffrau", seit: "Aug. 2024" }, r, jetzt).ok, true);
});

test("Erststart legt Azubis (aktiv) und Studenten (pausiert, Fokus azubi) an", () => {
  const namen = zg.alleZielgruppen().map((z) => `${z.name}:${z.aktiv}`);
  assert.deepEqual(namen, ["Azubis:1", "Studenten:0"]);
});

test("Vernetzen und Nachfassen nur für aktive, passende Zielgruppe – Pausieren stoppt sofort", () => {
  const azubi = kontakt("Auszubildender Bankkaufmann bei Sparkasse Köln");
  const leiter = kontakt("Filialleiter Louisenstraße | Taunus Sparkasse");
  const student = kontakt("Student BWL an der Uni Mannheim");
  const ohne = kontakt("Bankkauffrau bei Volksbank");
  zg.ordneZielgruppenZu();
  const gruppe = (id: number) => (db.prepare("SELECT zielgruppe_id z FROM contacts WHERE id=?").get(id) as { z: number | null }).z;
  assert.equal(gruppe(ohne), null, "passt nirgends → keine Zielgruppe");
  assert.equal(gruppe(leiter), null, "Filialleiter passt nirgends");
  assert.ok(gruppe(student), "Student wird der (pausierten) Studenten-Gruppe zugeordnet");

  const ids = () => nextNewContacts(10).map((c) => c.id);
  assert.deepEqual(ids(), [azubi], "nur der Azubi – Student ist pausiert, Leiter und Unpassende nie");

  const azubis = zg.alleZielgruppen().find((z) => z.name === "Azubis")!;
  zg.setzeZielgruppeAktiv(azubis.id, false);
  assert.deepEqual(ids(), [], "pausierte Zielgruppe = niemand mehr");
  zg.setzeZielgruppeAktiv(azubis.id, true);

  // Ändern wirkt sofort: „Sparkasse“ als Ausschlusswort nimmt den Azubi heraus.
  zg.speichereZielgruppe({ ...azubis, ausschluss: `${azubis.ausschluss}, Sparkasse` });
  assert.deepEqual(ids(), []);
  zg.speichereZielgruppe({ ...azubis });

  db.prepare("UPDATE contacts SET status='messaged', messaged_at=datetime('now','-10 days') WHERE id IN (?,?)").run(azubi, leiter);
  assert.deepEqual(messagedAwaitingFollowup([{ nachTagen: 4 }], 10).map((c) => c.id), [azubi], "Nachfassen auch nur Zielgruppe");
});

test("Automatische Erstnachricht: Filialleiter bekommt nichts, Azubi einen Entwurf mit Zielgruppen-Anleitung", async () => {
  setState("mode", "manual"); // Entwurf statt Versand – kein Browser im Test
  const leiter = kontakt("Geschäftsstellenleiter Volksbank", "accepted");
  const azubi = kontakt("Ausbildung zur Bankkauffrau bei LBBW", "accepted");
  zg.ordneZielgruppenZu();
  const azubis = zg.alleZielgruppen().find((z) => z.name === "Azubis")!;
  zg.speichereZielgruppe({ ...azubis, erstnachricht: "MEINE ANLEITUNG: kurz, Bezug zur Bank, eine Frage." });
  const prompts: string[] = [];
  setTextGeneratorForTests(async (p) => { prompts.push(p); return "Hey Person, ich hab gesehen du machst deine Ausbildung bei der LBBW. Ich hab auch in der Bank angefangen. Wie läuft's bisher?"; });
  const kontaktRow = (id: number) => db.prepare("SELECT * FROM contacts WHERE id=?").get(id) as never;
  await deliverFirstMessage(kontaktRow(leiter));
  await deliverFirstMessage(kontaktRow(azubi));
  const entwuerfe = db.prepare("SELECT contact_id FROM drafts WHERE kind='first'").all() as { contact_id: number }[];
  assert.deepEqual(entwuerfe.map((d) => d.contact_id), [azubi]);
  assert.equal(prompts.length, 1, "für den Leiter wurde nicht einmal die KI gefragt");
  assert.match(prompts[0], /MEINE ANLEITUNG/);
  assert.match(prompts[0], /Zielgruppe „Azubis“/);
  assert.doesNotMatch(prompts[0], /nützlichen Gedanken|MIT Mehrwert/);
  setTextGeneratorForTests(null);
});

test("Standard-Erstnachricht ohne Gedanken; Probe nutzt ungespeicherten Text", async () => {
  assert.doesNotMatch(zg.STANDARD_ERSTNACHRICHT, /Mehrwert|unterschätzen|Weichen gestellt/);
  const c = db.prepare("SELECT * FROM contacts WHERE headline LIKE 'Auszubildender Bankkaufmann%'").get() as never;
  let prompt = "";
  setTextGeneratorForTests(async (p) => { prompt = p; return "Hey Person, wie läuft's?"; });
  await firstMessage(c, undefined, null, undefined, undefined, null, "PROBETEXT XYZ");
  assert.match(prompt, /PROBETEXT XYZ/);
  assert.doesNotMatch(prompt, /MEINE ANLEITUNG/, "Probe überschreibt die gespeicherte Anleitung");
  setTextGeneratorForTests(null);
});

test("Vorschau zeigt Wirkung vor dem Speichern, ändert nichts", () => {
  const azubis = zg.alleZielgruppen().find((z) => z.name === "Azubis")!;
  const vorher = JSON.stringify(zg.alleZielgruppen());
  const v = zg.vorschau({ id: azubis.id, erkennung: azubis.erkennung, ausschluss: `${azubis.ausschluss}, LBBW`, max_berufsjahre: 5 });
  assert.ok(v.beispieleRaus.some((r) => /LBBW/.test(r.headline)));
  assert.equal(JSON.stringify(zg.alleZielgruppen()), vorher);
});
