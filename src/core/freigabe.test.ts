import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-freigabe-"));
process.env.DB_PATH = join(dir, "freigabe.sqlite");
const { db } = await import("../db/index.js");
const { lasseAlteNachfassungenVerfallen, approveMany, autoFreigabe, speichereAutoFreigabe, vertrauen } = await import("../modules/freigabe.js");
const { pendingDrafts } = await import("../modules/drafts.js");
const { messagedAwaitingFollowup } = await import("../modules/crm.js");
const { STANDARD_PLAN } = await import("../modules/playbook.js");

const vorTagen = (t: number) => new Date(Date.now() - t * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
let nr = 0;
function kontakt(extra: { score?: number; dnc?: number; status?: string; messagedTage?: number } = {}) {
  nr++;
  const url = `https://www.linkedin.com/in/person-${nr}/`;
  const id = Number(db.prepare(
    "INSERT INTO contacts(profile_url,full_name,headline,status,lead_score,do_not_contact,messaged_at) VALUES(?,?,?,?,?,?,?)",
  ).run(url, `Vorname${nr} Nachname`, "Auszubildender bei Sparkasse", extra.status ?? "messaged", extra.score ?? 50, extra.dnc ?? 0,
    extra.messagedTage != null ? vorTagen(extra.messagedTage) : vorTagen(10)).lastInsertRowid);
  return { id, url, vorname: `Vorname${nr}` };
}
function entwurf(k: { id: number; url: string }, kind: string, text: string, o: { status?: string; alterTage?: number; intent?: string; quelle?: string; original?: string | null; stufe?: number } = {}) {
  return Number(db.prepare(
    `INSERT INTO drafts(contact_id,kind,thread_url,participant,draft,ki_original,status,created_at,intent,freigabe_quelle,sequence_stage)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(k.id, kind, k.url, "x", text, o.original === undefined ? text : o.original, o.status ?? "pending",
    vorTagen(o.alterTage ?? 0), o.intent ?? null, o.quelle ?? null, o.stufe ?? null).lastInsertRowid);
}
const status = (id: number) => (db.prepare("SELECT status FROM drafts WHERE id=?").get(id) as { status: string }).status;

test("ungeprüfte Nachfassungen verfallen nach 10 Tagen und blockieren nichts", () => {
  const alt = kontakt(); const neu = kontakt();
  const a = entwurf(alt, "followup", "alt", { alterTage: 11 });
  const b = entwurf(neu, "followup", "neu", { alterTage: 3 });
  assert.equal(lasseAlteNachfassungenVerfallen(), 1);
  assert.equal(status(a), "expired");
  assert.equal(status(b), "pending");
  const faellig = messagedAwaitingFollowup(STANDARD_PLAN, 100).map((c) => c.profile_url);
  assert.ok(faellig.includes(alt.url), "nach dem Verfall wird die Stufe frisch fällig");
  assert.ok(!faellig.includes(neu.url), "ein offener Entwurf blockiert weiter");
});

test("Reihenfolge nach Wert: heiße Antworten zuerst, Nachfassungen zuletzt", () => {
  db.prepare("DELETE FROM drafts").run();
  const f = entwurf(kontakt(), "followup", "f");
  const e = entwurf(kontakt({ score: 90 }), "first", "e");
  const m = entwurf(kontakt(), "message", "m");
  const h = entwurf(kontakt(), "message", "h", { intent: "chance" });
  assert.deepEqual(pendingDrafts().map((d) => d.id), [h, m, e, f]);
});

test("Sammel-Freigabe: jeder einzeln, erledigte werden gemeldet statt still übersprungen", () => {
  db.prepare("DELETE FROM drafts").run();
  const a = entwurf(kontakt(), "message", "a");
  const b = entwurf(kontakt(), "message", "b", { status: "sent" });
  const r = approveMany([a, b, 999999]);
  assert.deepEqual(r.ok, [a]);
  assert.equal(r.blockiert.length, 2);
  assert.equal((db.prepare("SELECT freigabe_quelle q FROM drafts WHERE id=?").get(a) as { q: string }).q, "mensch");
});

test("automatische Freigabe: aus, ohne Vertrauen, mit Vertrauen, Prüfung, Karenz, Limit", () => {
  db.prepare("DELETE FROM drafts").run();
  const gut = (k: { vorname: string }) => `Hey ${k.vorname}, viele merken erst spät, wie schnell nach der Ausbildung alles festgefahren ist. Wie siehst du das bei dir?`;
  const k1 = kontakt(), k2 = kontakt(), k3 = kontakt(), k4 = kontakt(), k5 = kontakt();
  const ok1 = entwurf(k1, "followup", gut(k1), { alterTage: 1 });
  const ok2 = entwurf(k2, "followup", gut(k2), { alterTage: 1 });
  const schlecht = entwurf(k3, "followup", `Hey ${k3.vorname}, wie geht's? Was machst du?`, { alterTage: 1 });
  const frisch = entwurf(k4, "followup", gut(k4));
  const erst = entwurf(k5, "first", gut(k5), { alterTage: 1 });

  assert.equal(autoFreigabe(), 0, "Standard: aus");
  speichereAutoFreigabe({ followup: true, tagesCap: 1, karenzMin: 60 });
  assert.equal(autoFreigabe(), 0, "ohne verdientes Vertrauen nichts");

  // 10 menschliche, unveränderte Freigaben → Vertrauen erreicht
  for (let i = 0; i < 10; i++) entwurf(kontakt(), "followup", "t", { status: "sent", quelle: "mensch" });
  assert.equal(vertrauen("followup").erreicht, true);
  const lernVorher = (db.prepare("SELECT COUNT(*) n FROM learning_events").get() as { n: number }).n;

  assert.equal(autoFreigabe(), 1, "Tageslimit 1");
  speichereAutoFreigabe({ followup: true, tagesCap: 10, karenzMin: 60 });
  assert.equal(autoFreigabe(), 1);
  assert.equal(status(ok1), "approved"); assert.equal(status(ok2), "approved");
  assert.equal(status(schlecht), "pending", "zwei Fragen → bleibt beim Menschen");
  assert.equal(status(frisch), "pending", "Karenzzeit");
  assert.equal(status(erst), "pending", "Erstnachrichten nicht eingeschaltet");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM learning_events").get() as { n: number }).n, lernVorher, "Automatik lernt nicht von sich selbst");
  const vorher = vertrauen("followup").entscheidungen;
  assert.equal(vertrauen("followup").entscheidungen, vorher, "auto-Freigaben zählen nicht als Vertrauen");
  speichereAutoFreigabe({});
});

test("Vertrauen verlangt UNVERÄNDERTE Freigaben", () => {
  db.prepare("DELETE FROM drafts").run();
  for (let i = 0; i < 10; i++) entwurf(kontakt(), "first", "vom Menschen umgeschrieben", { status: "sent", quelle: "mensch", original: "KI-Text" });
  const v = vertrauen("first");
  assert.equal(v.entscheidungen, 10);
  assert.equal(v.unveraendert, 0);
  assert.equal(v.erreicht, false);
});
