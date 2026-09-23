import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-playbook-"));
process.env.DB_PATH = join(dir, "playbook.sqlite");
process.env.PROFIL_PATH = join(dir, "profil.local.json");
writeFileSync(process.env.PROFIL_PATH, JSON.stringify({
  name: "Sinan", persona: "p", ziel: "z", tabus: "t", stilRegeln: [], beispielNachrichten: [], winkel: { azubi: "", student: "" },
  leadMagnete: [{ key: "pa", titel: "Potenzialanalyse", route: "karriere", nutzen: "Klarheit", ablauf: "20 Min", cta: "Soll ich dir zeigen, wie das abläuft?", naechsterSchritt: "Code" }],
  beweise: ["Ich hab als Azubi angefangen und nach zwei Jahren gewechselt."],
}));
const { db } = await import("../db/index.js");
const { normalisierePlan, speichereFollowupPlan, followupPlan, DREI_STUFEN_PLAN } = await import("../modules/playbook.js");
const { messagedAwaitingFollowup } = await import("../modules/crm.js");
const { createFollowupDraft } = await import("../modules/drafts.js");
const { setTextGeneratorForTests } = await import("./textLlm.js");
const { pruefeAusgehend } = await import("./ausgehendCheck.js");

test("Plan wird begrenzt: max. 3 Stufen, 2–30 Tage, letzte Stufe immer Abschied", () => {
  assert.deepEqual(normalisierePlan(null).map((s) => s.zweck), ["wert", "abschied"]);
  const p = normalisierePlan([{ nachTagen: 1, zweck: "abschied" }, { nachTagen: 99, zweck: "wert" }, { nachTagen: 5, zweck: "beweis" }, { nachTagen: 5, zweck: "wert" }]);
  assert.equal(p.length, 3);
  assert.deepEqual(p.map((s) => s.nachTagen), [2, 30, 5]);
  assert.deepEqual(p.map((s) => s.zweck), ["anknuepfen", "wert", "abschied"], "Abschied mitten in der Kette wäre gelogen");
});

const tageHer = (t: number) => new Date(Date.now() - t * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
const kontakt = (url: string, tage: number, name = `Nutzer ${url.length}${Math.random().toString(36).slice(2, 6)}`) =>
  Number(db.prepare("INSERT INTO contacts(profile_url,full_name,headline,status,messaged_at) VALUES(?,?,?, 'messaged', ?)")
    .run(url, name, "Auszubildender bei Sparkasse", tageHer(tage)).lastInsertRowid);
const followup = (url: string, status: string) =>
  db.prepare("INSERT INTO drafts(kind,thread_url,draft,status) VALUES('followup',?,?,?)").run(url, "x", status);

test("Fälligkeit folgt dem Plan, danach nie wieder", () => {
  speichereFollowupPlan(DREI_STUFEN_PLAN); // 3 / 5 / 7 Tage
  const plan = followupPlan();
  kontakt("u-frisch", 2);
  kontakt("u-reif", 3);
  kontakt("u-stufe2", 4); followup("u-stufe2", "sent");
  kontakt("u-stufe2-reif", 5); followup("u-stufe2-reif", "sent");
  kontakt("u-fertig", 30); followup("u-fertig", "sent"); followup("u-fertig", "sent"); followup("u-fertig", "sent");
  kontakt("u-offen", 30); followup("u-offen", "pending");
  kontakt("u-verworfen", 30); followup("u-verworfen", "discarded");
  const urls = messagedAwaitingFollowup(plan, 50).map((c) => c.profile_url).sort();
  assert.deepEqual(urls, ["u-reif", "u-stufe2-reif"]);
});

test("Nachfassung: Zweck + Angebot im Prompt, Stufe eingefroren", async () => {
  speichereFollowupPlan(DREI_STUFEN_PLAN);
  const id = kontakt("https://www.linkedin.com/in/max-prompt/", 10, "Max Richter");
  const c = db.prepare("SELECT * FROM contacts WHERE id=?").get(id) as never;
  const prompts: string[] = [];
  setTextGeneratorForTests(async (p) => { prompts.push(p); return "Hey Max, viele merken erst spät, wie schnell sich nach der Ausbildung alles festfährt. Soll ich dir zeigen, wie die Potenzialanalyse abläuft?"; });
  assert.equal(await createFollowupDraft(c), true);
  assert.match(prompts[0], /WERT GEBEN/);
  assert.match(prompts[0], /Potenzialanalyse/);
  assert.doesNotMatch(prompts[0], /wollte nochmal nachfragen\./i);
  const d = db.prepare("SELECT sequence_stage, variant_json FROM drafts WHERE thread_url='https://www.linkedin.com/in/max-prompt/'").get() as { sequence_stage: number; variant_json: string };
  assert.equal(d.sequence_stage, 1);
  assert.match(prompts[0], /VARIANTE FÜR DIESE NACHRICHT/, "Selbstlernen: die gewählte Variante steuert den Text");
  assert.equal(JSON.parse(d.variant_json).slot, "followup:wert");
  setTextGeneratorForTests(null);
});

test("Ausgangsprüfung: ein Neuversuch mit Gründen, sonst kein Entwurf", async () => {
  const id = kontakt("https://www.linkedin.com/in/max-check/", 10, "Max Keller");
  const c = db.prepare("SELECT * FROM contacts WHERE id=?").get(id) as never;
  const prompts: string[] = [];
  setTextGeneratorForTests(async (p) => { prompts.push(p); return "Hey Jonas, wie läuft's? Und was machst du so? Schau mal hier: https://example.com"; });
  assert.equal(await createFollowupDraft(c), false);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /KORREKTUR/);
  assert.match(prompts[1], /falscher Name/);
  setTextGeneratorForTests(null);
});

test("Ausgangsprüfung erkennt die typischen Fehler", () => {
  const ok = (t: string, ctx = {}) => pruefeAusgehend(t, { kind: "followup", vorname: "Max Richter", ...ctx });
  assert.equal(ok("Hey Max, viele unterschätzen, wie schnell nach der Ausbildung alles festgefahren ist. Wie siehst du das bei dir?").ok, true);
  assert.match(ok("Hey Max, wie geht's? Was machst du?").gruende.join(), /2 Fragen/);
  assert.match(ok("Hey Max, alles klar. Wie läuft's?", { abschied: true }).gruende.join(), /keine Frage/);
  assert.match(ok("Hey Max, cool 😀 wie läuft's?").gruende.join(), /Emoji/);
  assert.match(ok("Hey Max, hier ist ein exklusives Angebot für dich.").gruende.join(), /Verkaufssprache/);
  assert.match(ok("Hey [Name], wie läuft's?").gruende.join(), /Platzhalter/);
  assert.match(ok("Hey Max, schau: https://evil.example.com").gruende.join(), /nicht hinterlegt/);
  assert.equal(ok("Hey Max, hier kannst du dir was aussuchen: https://cal.com/sinan", { erlaubteLinks: ["https://cal.com/sinan"] }).ok, true);
  assert.match(ok("Hey Max, " + "sehr langer Text ".repeat(40)).gruende.join(), /zu lang/);
});
