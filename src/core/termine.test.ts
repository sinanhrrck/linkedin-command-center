import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "nextlead-termine-")), "test.sqlite");
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
const { db, setState, getState } = await import("../db/index.js");
const t = await import("../modules/termine.js");
const { setTextGeneratorForTests } = await import("./textLlm.js");
const { events } = await import("./events.js");

// Google wird simuliert: jede Anfrage landet in `aufrufe`, Antworten je Ziel.
const aufrufe: { url: string; method: string; body: string }[] = [];
let naechsteId = 1;
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input), method = init?.method ?? "GET", body = String(init?.body ?? "");
  aufrufe.push({ url, method, body });
  const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { "Content-Type": "application/json" } });
  if (url.includes("oauth2.googleapis.com/token")) {
    if (body.includes("grant_type=authorization_code")) {
      const idToken = `x.${Buffer.from(JSON.stringify({ email: "nutzer@example.com" })).toString("base64url")}.y`;
      return json(200, { refresh_token: "r1", access_token: "a1", expires_in: 3600, id_token: idToken });
    }
    return json(200, { access_token: "a2", expires_in: 3600 });
  }
  if (url.includes("/calendar/v3/")) {
    if (method === "DELETE") return new Response(null, { status: 204 });
    return json(200, { id: method === "POST" ? `ev${naechsteId++}` : "patched" });
  }
  return json(404, {});
})  as typeof fetch;

const JETZT = new Date("2026-09-30T08:00:00Z"); // Mittwoch

test("Vorfilter: nur mit Uhrzeit UND Tag ein KI-Aufruf", () => {
  assert.equal(t.moeglicherTermin([{ sender: "", text: "Dienstag passt ab 17 Uhr" }]), true);
  assert.equal(t.moeglicherTermin([{ sender: "", text: "Am 6.10. um 17:30?" }]), true);
  assert.equal(t.moeglicherTermin([{ sender: "", text: "Klingt gut, danke dir!" }]), false);
  assert.equal(t.moeglicherTermin([{ sender: "", text: "Ich hab 2 Jahre Ausbildung" }]), false);
  assert.equal(t.plusMinuten("2026-10-06T17:00", 60), "2026-10-06T18:00");
  assert.equal(t.plusMinuten("2026-10-06T23:30", 60), "2026-10-07T00:30");
});

test("Google verbinden: Rücksprung-Adresse mit Code und state, PKCE, E-Mail aus dem id_token", async () => {
  assert.equal(t.googleStatus().verbunden, false);
  const link = new URL(t.googleAnmeldeLink());
  assert.equal(link.searchParams.get("code_challenge_method"), "S256");
  assert.equal(link.searchParams.get("access_type"), "offline");
  const status = link.searchParams.get("state")!;
  await assert.rejects(t.googleVerbinden(`http://localhost:4321/api/google/callback?code=abc&state=falsch`), /passt nicht/);
  const r = await t.googleVerbinden(`http://localhost:4321/api/google/callback?code=abc&state=${status}`);
  assert.equal(r.email, "nutzer@example.com");
  assert.equal(t.googleStatus().verbunden, true);
  assert.match(aufrufe.at(-1)!.body, /code_verifier=/);
});

test("Bestätigter Termin: Titel aus Art + Kontaktname + Profilname, Kalender, CRM-Stufe, Meldung", async () => {
  const url = "https://www.linkedin.com/messaging/thread/T1/";
  const cid = Number(db.prepare("INSERT INTO contacts(profile_url,normalized_url,full_name,status) VALUES(?,?,?,'replied')")
    .run("https://www.linkedin.com/in/dardan/", "https://www.linkedin.com/in/dardan/", "Dardan Recica").lastInsertRowid);
  // Zuordnung Chat → Kontakt läuft über den eindeutigen Namen (contactIdentity), wie im Betrieb.
  const gemeldet: { titel: string }[] = [];
  events.on("termin:eingetragen", (e) => gemeldet.push(e));
  let prompt = "";
  setTextGeneratorForTests(async (p) => { prompt = p; return `{"bestaetigt":true,"sicher":true,"datum":"2026-10-06","uhrzeit":"17:00","art":"AEC Auswertung","grund":"Dienstag 17 Uhr zugesagt"}`; });
  await t.pruefeTermin({ threadUrl: url, participant: "Dardan Recica", messages: [
    { sender: "Dardan Recica", text: "Dienstag passt ab 17 Uhr und donnerstags ab 15:30", vonMir: false },
    { sender: "", text: "Super, Dienstag 17 Uhr passt perfekt.", vonMir: true },
  ] }, JETZT);
  assert.match(prompt, /Mittwoch, 30\.09\.2026/);
  const row = db.prepare("SELECT * FROM termine").get() as { titel: string; start_lokal: string; dauer_min: number; kalender_id: string };
  assert.match(row.titel, /^AEC Auswertung Dardan Recica\//);
  assert.equal(row.start_lokal, "2026-10-06T17:00");
  assert.equal(row.dauer_min, 60);
  assert.equal(row.kalender_id, "ev1");
  const ev = JSON.parse(aufrufe.filter((a) => a.method === "POST" && a.url.includes("/calendar/")).at(-1)!.body);
  assert.deepEqual(ev.start, { dateTime: "2026-10-06T17:00:00", timeZone: "Europe/Berlin" });
  assert.deepEqual(ev.end, { dateTime: "2026-10-06T18:00:00", timeZone: "Europe/Berlin" });
  assert.equal(gemeldet.length, 1);
  assert.ok(db.prepare("SELECT 1 FROM crm_stage_events WHERE contact_id=? AND stage='meeting'").get(cid), "Stufe Termin im CRM");

  // Gleicher Termin noch einmal erkannt → nichts Neues. Verschoben → bestehender Eintrag wird geändert.
  assert.equal(await t.verarbeiteBefund({ threadUrl: url, participant: "Dardan Recica" }, { bestaetigt: true, sicher: true, datum: "2026-10-06", uhrzeit: "17:00", art: "AEC Auswertung" }, JETZT), "unveraendert");
  assert.equal(await t.verarbeiteBefund({ threadUrl: url, participant: "Dardan Recica" }, { bestaetigt: true, sicher: true, datum: "2026-10-08", uhrzeit: "15:30", art: "AEC Auswertung" }, JETZT), "verschoben");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM termine").get() as { n: number }).n, 1);
  assert.ok(aufrufe.some((a) => a.method === "PATCH" && a.url.endsWith("/ev1")));
  setTextGeneratorForTests(null);
});

test("Unsicher oder in der Vergangenheit: nichts eintragen, nur melden", async () => {
  const vorher = (db.prepare("SELECT COUNT(*) n FROM termine").get() as { n: number }).n;
  const hinweise: unknown[] = [];
  events.on("termin:unsicher", (e) => hinweise.push(e));
  const ctx = { threadUrl: "https://www.linkedin.com/messaging/thread/T2/", participant: "Mia Muster" };
  assert.equal(await t.verarbeiteBefund(ctx, { bestaetigt: true, sicher: false, datum: "2026-10-06", uhrzeit: "17:00" }, JETZT), "unsicher");
  assert.equal(await t.verarbeiteBefund(ctx, { bestaetigt: true, sicher: true, datum: "2026-09-01", uhrzeit: "17:00" }, JETZT), "unsicher");
  assert.equal(await t.verarbeiteBefund(ctx, { bestaetigt: true, sicher: true, datum: "6.10.", uhrzeit: "17 Uhr" }, JETZT), "unsicher");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM termine").get() as { n: number }).n, vorher);
  assert.equal(hinweise.length, 3);
});

test("Ohne Kalender kein KI-Aufruf; Löschen entfernt den Kalendereintrag; Arten prüfen", async () => {
  const id = (db.prepare("SELECT id FROM termine LIMIT 1").get() as { id: number }).id;
  assert.equal(await t.terminLoeschen(id), true);
  assert.ok(aufrufe.some((a) => a.method === "DELETE"));
  assert.equal(await t.terminLoeschen(id), false, "zweimal löschen geht nicht");

  t.googleTrennen();
  let gefragt = false;
  setTextGeneratorForTests(async () => { gefragt = true; return "{}"; });
  await t.pruefeTermin({ threadUrl: "x", participant: "y", messages: [{ sender: "", text: "Dienstag 17 Uhr passt" }] }, JETZT);
  assert.equal(gefragt, false);
  setTextGeneratorForTests(null);

  assert.throws(() => t.speichereTerminArten([{ name: "Kurz", dauer: 5 }]), /10 bis 480/);
  assert.deepEqual(t.speichereTerminArten([{ name: " Erstgespräch ", dauer: 45 }]), [{ name: "Erstgespräch", dauer: 45 }]);
  assert.equal(JSON.parse(getState("termin_arten")!)[0].dauer, 45);
  setState("termin_arten", "");
});
