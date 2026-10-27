/**
 * SICHERHEITSPAKET (2026-10-27, Sinan: „pitcht zu schnell, peinliche Nachrichten, keine Übersicht,
 * falsche Leute“): Pitch-Bremse nach Lead-Stand, Sammelfreigabe getrennt nach Erstnachrichten und
 * Antworten, Versandprotokoll. Eigene Temp-DB (TEST-FALLE: nie ohne DB_PATH importieren).
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-sicherheit-"));
process.env.DB_PATH = join(dir, "s.sqlite");
const { db } = await import("../db/index.js");
const { alleKontakteInZielgruppe } = await import("./testZielgruppe.js");
const { validiereAntwort, enthaeltAngebot, angebotErlaubt } = await import("../agent/domain/validation/responseValidator.js");
const { buildReplyPrompt } = await import("../agent/prompt/promptBuilder.js");
const { leeresProfil } = await import("../agent/domain/profile.js");
const { leeresMemory } = await import("../agent/domain/memory.js");
const { SqliteConversationRepository } = await import("../agent/infra/sqliteConversationRepository.js");
const { sammelFreigabe } = await import("../modules/freigabe.js");
const { protokolliereVersand, versandHeute } = await import("../modules/versandProtokoll.js");
const { events } = await import("./events.js");

alleKontakteInZielgruppe(db);
new SqliteConversationRepository(db); // legt agent_conversations an

const ANGEBOT = "Ich hab da was für dich: eine kostenlose Potenzialanalyse. Hast du Lust?";

test("Pitch-Bremse: Angebot erst ab dem Angebots-Zustand des Leads", () => {
  for (const stage of ["icebreaker", "smalltalk", "discovery", "bedarf", "vertrauen", "validierung", "einwand"] as const) {
    const v = validiereAntwort(ANGEBOT, { stage, letzteEigene: [] });
    assert.ok(v.gruende.some((g) => g.includes("call_anbieten")), `in ${stage} muss das Angebot blockiert werden`);
    assert.equal(angebotErlaubt(stage), false);
  }
  const ok = validiereAntwort(ANGEBOT, { stage: "call_angebot", letzteEigene: [] });
  assert.ok(!ok.gruende.some((g) => g.includes("call_anbieten")));
  assert.equal(angebotErlaubt("call_angebot"), true);
  for (const t of ["Wollen wir das in einem kostenlosen Gespräch durchgehen?", "Ich schick dir meinen Buchungslink.", "Lass uns mal kurz telefonieren."])
    assert.equal(enthaeltAngebot(t), true, t);
  for (const t of ["Wie läuft deine Ausbildung gerade?", "Ich hab damals auch bei der Sparkasse angefangen."])
    assert.equal(enthaeltAngebot(t), false, t);
});

test("Angebotsdetails stehen erst im Angebots-Zustand im Prompt", () => {
  const basis = { persona: "P", profile: { ...leeresProfil(), careerInterest: 0.9 }, memory: leeresMemory("Lena"), letzteNachricht: "x", teilnehmer: "Lena", angebot: "# Welches Angebot? TEST" };
  const bedarf = buildReplyPrompt({ ...basis, stage: "bedarf" });
  assert.doesNotMatch(bedarf, /Welches Angebot\? TEST/);
  assert.match(bedarf, /noch KEIN Angebot/);
  assert.match(buildReplyPrompt({ ...basis, stage: "call_angebot" }), /Welches Angebot\? TEST/);
});

function kontakt(name: string, headline = "Azubi Bankkaufmann") {
  return Number(db.prepare("INSERT INTO contacts(profile_url,full_name,headline,status) VALUES(?,?,?,?)")
    .run(`https://www.linkedin.com/in/${name.toLowerCase().replace(/\W+/g, "-")}/`, name, headline, "accepted").lastInsertRowid);
}
function entwurf(kind: string, text: string, opts: { contactId?: number; participant?: string; thread?: string; intent?: string } = {}) {
  return Number(db.prepare("INSERT INTO drafts(kind,contact_id,thread_url,participant,incoming,draft,intent) VALUES(?,?,?,?,?,?,?)")
    .run(kind, opts.contactId ?? null, opts.thread ?? `t-${Math.random()}`, opts.participant ?? null, "", text, opts.intent ?? null).lastInsertRowid);
}

test("Sammelfreigabe: nur was alle Prüfungen besteht, getrennt nach Gruppe, zählt nicht als Vertrauen", () => {
  const lena = kontakt("Lena Beispiel");
  const tim = kontakt("Tim Test");
  const gut = entwurf("first", "Hey Lena, ich bin Sinan. Ich hab damals auch in der Bank angefangen. Wie erlebst du den Alltag gerade?", { contactId: lena, participant: "Lena Beispiel" });
  const schlecht = entwurf("first", "Hey Tim, ich hoffe es geht dir gut! Was machst du? Und wie läuft es?", { contactId: tim, participant: "Tim Test" });
  const antwortOk = entwurf("message", "Sehr cool, das kenn ich gut. Was hat dich damals zur Bank gebracht?", { participant: "Jonas", thread: "thread-ok" });
  db.prepare("INSERT INTO agent_conversations(thread_url,teilnehmer,stage,profile,memory,scores) VALUES('thread-frueh','Mia','bedarf','{}','{}','{}')").run();
  const zuFrueh = entwurf("message", ANGEBOT, { participant: "Mia", thread: "thread-frueh" });
  const einwand = entwurf("message", "Verstehe ich total.", { participant: "Can", thread: "thread-e", intent: "einwand" });

  const vorschau = sammelFreigabe("erst");
  assert.deepEqual(vorschau.freigeben.map((f) => f.id), [gut]);
  assert.equal(vorschau.liegen[0].id, schlecht);
  assert.equal((db.prepare("SELECT status FROM drafts WHERE id=?").get(gut) as { status: string }).status, "pending", "Vorschau gibt nichts frei");

  const antworten = sammelFreigabe("antworten", true);
  assert.deepEqual(antworten.freigeben.map((f) => f.id), [antwortOk]);
  assert.ok(antworten.liegen.find((l) => l.id === zuFrueh)?.grund.includes("Angebot zu früh"));
  assert.ok(antworten.liegen.find((l) => l.id === einwand)?.grund.includes("Einwand"));
  const a = db.prepare("SELECT status, freigabe_quelle FROM drafts WHERE id=?").get(antwortOk) as { status: string; freigabe_quelle: string };
  assert.deepEqual(a, { status: "approved", freigabe_quelle: "sammel" });
  assert.equal((db.prepare("SELECT status FROM drafts WHERE id=?").get(gut) as { status: string }).status, "pending", "Antworten-Knopf fasst Erstnachrichten nicht an");
  assert.throws(() => sammelFreigabe("alles"), /Unbekannte Gruppe/);
});

test("Versandprotokoll: Eintrag mit Text, Zähler je Art, Meldung an Telegram", () => {
  let gemeldet: { text: string } | null = null;
  events.on("versand:gesendet", (v: { text: string }) => { gemeldet = v; });
  protokolliereVersand({ art: "erstnachricht", zielUrl: "https://www.linkedin.com/in/lena-beispiel/", empfaenger: "Lena Beispiel", text: "Hey Lena, wie läuft's?" });
  protokolliereVersand({ art: "antwort", zielUrl: "https://www.linkedin.com/messaging/thread/x/", empfaenger: "Jonas", text: "Sehr cool." });
  const h = versandHeute();
  assert.equal(h.eintraege.length, 2);
  assert.deepEqual(h.zaehler, { antwort: 1, erstnachricht: 1 });
  assert.ok(h.eintraege.find((e) => e.art === "erstnachricht")?.contact_id, "Kontakt wird über die Profil-URL zugeordnet");
  assert.equal(gemeldet!.text, "Sehr cool.");
});
