import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * Der Vorfall vom 17.08.2026 (Sinan): Neun Kontakte bekamen wortgleich „Hi [Name], danke fürs
 * Vernetzen!“ als Event-Einladung – obwohl acht davon Minuten zuvor bereits eine Erstnachricht
 * erhalten hatten. Drei Ursachen, die dieser Test einzeln festhält.
 */

const dir = mkdtempSync(join(tmpdir(), "nextlead-kampagne-"));
process.env.DB_PATH = join(dir, "kampagne.sqlite");
const { db } = await import("../db/index.js");
const { normalisierePlatzhalter, campaignTick } = await import("../modules/campaignRunner.js");
const { outboundHistory, captureDraftContext } = await import("../modules/conversationMemory.js");
const { createCampaign } = await import("../modules/campaigns.js");
const { campaignArt, reconcileCampaignTarget } = await import("../modules/campaignWorkflow.js");
const { setTextGeneratorForTests } = await import("../core/textLlm.js");

test("übersetzt menschlich getippte Platzhalter in ersetzbare Schlüssel", () => {
  assert.equal(normalisierePlatzhalter("Hi [Name], danke fürs Vernetzen!"), "Hi {name}, danke fürs Vernetzen!");
  assert.equal(normalisierePlatzhalter("Hey {{ Vorname }}"), "Hey {name}");
  assert.equal(normalisierePlatzhalter("Am <Datum> um %Uhrzeit% in {Ort}"), "Am {date} um {zeit} in {ort}");
  assert.equal(normalisierePlatzhalter("Hey {name}"), "Hey {name}", "bereits korrekte Schlüssel bleiben unverändert");
  assert.equal(
    normalisierePlatzhalter("Wir sprechen über [Immobilien] als Kapitalanlage"),
    "Wir sprechen über [Immobilien] als Kapitalanlage",
    "unbekannte Wörter in Klammern sind Text, kein Platzhalter",
  );
});

test("kennt bereits gesendete eigene Nachrichten – ein Erstkontakt ist nur einer ohne Historie", () => {
  const neu = Number(db.prepare(
    "INSERT INTO contacts(profile_url,full_name,status) VALUES('https://example.test/frisch','Frisch Kontakt','accepted')",
  ).run().lastInsertRowid);
  assert.equal(outboundHistory(neu).count, 0);
  assert.equal(captureDraftContext(neu), null, "ohne Historie gibt es nichts zu belegen");

  const angeschrieben = Number(db.prepare(
    "INSERT INTO contacts(profile_url,full_name,status,messaged_at) VALUES('https://example.test/sam','Sam Lyttek','messaged','2026-08-17 07:58:31')",
  ).run().lastInsertRowid);
  db.prepare(
    `INSERT INTO drafts(contact_id,kind,thread_url,participant,incoming,draft,status,sent_at)
     VALUES(?,'first','https://example.test/sam','Sam Lyttek','','Hey Sam, wie läuft die Ausbildung?','sent','2026-08-17 07:58:31')`,
  ).run(angeschrieben);

  const historie = outboundHistory(angeschrieben);
  assert.equal(historie.count, 1);
  assert.equal(historie.lastKind, "Erstnachricht");
  assert.match(historie.lastText || "", /wie läuft die Ausbildung/);

  // Genau das meldete der Prüfbereich vorher falsch als „Kein früherer Gesprächskontext“.
  const beleg = captureDraftContext(angeschrieben);
  assert.ok(beleg, "eine gesendete Nachricht ist ein Gesprächskontext");
  assert.equal(beleg?.outbound.count, 1);
});

test("legt bei KI-Ausfall keinen Entwurf an, statt die rohe Vorlage zur Freigabe zu stellen", async () => {
  const profil = "https://www.linkedin.com/in/ki-ausfall";
  db.prepare(
    "INSERT INTO contacts(profile_url,normalized_url,full_name,headline,status,accepted_at,aus_netzwerk,lead_score) VALUES(?,?,?,?,'accepted',datetime('now'),1,80)",
  ).run(profil, profil, "Kai Ausfall", "Bankkaufmann Testkampagne");
  const id = createCampaign({
    name: "KI-Ausfall", kind: "event", eventUrl: "https://www.linkedin.com/events/x", audienceScope: "network",
    filters: { keywords: "Testkampagne" }, messageTemplate: "Hi [Name], danke fürs Vernetzen!", dailyLimit: 5,
  });

  setTextGeneratorForTests(async () => { throw new Error("credit balance is too low"); });
  assert.equal(await campaignTick(), 0, "ohne KI entsteht kein Entwurf");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM drafts WHERE incoming=?").get(`campaign:${id}`) as { n: number }).n, 0);
  const ziel = db.prepare("SELECT status,reason FROM campaign_targets WHERE campaign_id=?").get(id) as { status: string; reason: string };
  assert.equal(ziel.status, "queued", "das Ziel wartet auf den nächsten Versuch, statt als Fehler zu gelten");
  assert.match(ziel.reason, /KI nicht verfügbar/);

  // Auch ein antwortender, aber unbrauchbarer KI-Text darf keinen Platzhalter durchlassen.
  setTextGeneratorForTests(async () => "Hi [Name], danke fürs Vernetzen! Ich lade dich herzlich zu unserem Event ein.");
  assert.equal(await campaignTick(), 0, "ein übrig gebliebener Platzhalter blockiert den Entwurf");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM drafts WHERE incoming=?").get(`campaign:${id}`) as { n: number }).n, 0);

  setTextGeneratorForTests(async () => "Hey Kai, wir machen am 27. August einen Abend zum Thema Immobilien. Magst du dabei sein?");
  assert.equal(await campaignTick(), 1, "mit brauchbarem Text entsteht der Entwurf");
  db.prepare("UPDATE campaigns SET active=0 WHERE id=?").run(id);
});

test("lädt niemanden ein, der gerade erst eine Nachricht bekommen hat", async () => {
  const profil = "https://www.linkedin.com/in/frisch-angeschrieben";
  // Genau die reale Reihenfolge: erst wird der Kontakt Kampagnenziel, DANN geht die
  // Erstnachricht raus. Der Zielgruppen-Filter greift nur beim Aufnehmen, nicht beim Entwurf.
  const id = Number(db.prepare(
    "INSERT INTO contacts(profile_url,normalized_url,full_name,headline,status,accepted_at,aus_netzwerk,lead_score) VALUES(?,?,?,?,'accepted',datetime('now'),1,80)",
  ).run(profil, profil, "Sam Frisch", "Bankkaufmann Abstandstest").lastInsertRowid);
  const kampagne = createCampaign({
    name: "Abstandstest", kind: "event", eventUrl: "https://www.linkedin.com/events/y", audienceScope: "network",
    filters: { keywords: "Abstandstest" }, dailyLimit: 5,
  });
  db.prepare("UPDATE contacts SET status='messaged',messaged_at=datetime('now') WHERE id=?").run(id);
  db.prepare(
    `INSERT INTO drafts(contact_id,kind,thread_url,participant,incoming,draft,status,sent_at)
     VALUES(?,'first',?,'Sam Frisch','','Hey Sam, wie läuft die Ausbildung?','sent',datetime('now'))`,
  ).run(id, profil);
  setTextGeneratorForTests(async () => "Hey Sam, wir machen am 27. August einen Abend zum Thema Immobilien. Magst du dabei sein?");

  assert.equal(await campaignTick(), 0, "zwei Nachrichten am selben Tag wirken wie ein Bot");
  const ziel = db.prepare("SELECT status,reason FROM campaign_targets WHERE campaign_id=? AND contact_id=?").get(kampagne, id) as { status: string; reason: string };
  assert.equal(ziel.status, "snoozed");
  assert.match(ziel.reason, /Einladung frühestens ab/);
  db.prepare("UPDATE campaigns SET active=0 WHERE id=?").run(kampagne);
});

test("Auftrags-Kampagne erkennt die normale Nachrichtenstrecke als Fortschritt", async () => {
  const profil = "https://www.linkedin.com/in/auftrag-p1";
  const id = Number(db.prepare(
    "INSERT INTO contacts(profile_url,normalized_url,full_name,headline,status,accepted_at,aus_netzwerk,lead_score) VALUES(?,?,?,?,'accepted',datetime('now'),1,80)",
  ).run(profil, profil, "Pia Eins", "Bankkauffrau Auftragstest").lastInsertRowid);
  const kampagne = createCampaign({
    name: "P1 Test", kind: "outreach", audienceScope: "network", goalCode: "P1",
    filters: { keywords: "Auftragstest" }, dailyLimit: 10,
  });
  assert.equal(campaignArt(kampagne), "auftrag");

  // campaignTick fasst Auftrags-Ziele bewusst nicht an – sonst gäbe es eine zweite Nachricht.
  assert.equal(await campaignTick(), 0);
  assert.equal(
    (db.prepare("SELECT status FROM campaign_targets WHERE campaign_id=? AND contact_id=?").get(kampagne, id) as { status: string }).status,
    "queued",
  );

  // Die normale Strecke schreibt: das MUSS als Fortschritt der Kampagne zählen, sonst steht das
  // Ziel für immer auf 'queued' und das Cockpit verspricht endlos Entwürfe, die nie kommen.
  db.prepare(
    `INSERT INTO drafts(contact_id,kind,thread_url,participant,incoming,draft,status)
     VALUES(?,'reaktivierung',?,'Pia Eins','','Hey Pia, wir sind hier länger vernetzt.','pending')`,
  ).run(id, profil);
  assert.equal(reconcileCampaignTarget(kampagne, id), "drafted");

  db.prepare("UPDATE drafts SET status='sent',sent_at=datetime('now') WHERE contact_id=?").run(id);
  assert.equal(reconcileCampaignTarget(kampagne, id), "sent");

  // Der Halb-Automatik-Versand sendet direkt und hinterlässt gar keine Entwurfszeile. Auch das
  // muss als erledigt zählen, sonst hängt der Kontakt für immer in der Warteschlange.
  const ohneEntwurf = Number(db.prepare(
    "INSERT INTO contacts(profile_url,normalized_url,full_name,headline,status,accepted_at,messaged_at,aus_netzwerk,lead_score) VALUES(?,?,?,?,'messaged',datetime('now'),datetime('now'),1,80)",
  ).run("https://www.linkedin.com/in/direkt-gesendet", "https://www.linkedin.com/in/direkt-gesendet", "Dirk Ekt", "Bankkaufmann Auftragstest").lastInsertRowid);
  db.prepare("INSERT INTO campaign_targets(campaign_id,contact_id,route,status) VALUES(?,?,'network','queued')").run(kampagne, ohneEntwurf);
  assert.equal(reconcileCampaignTarget(kampagne, ohneEntwurf), "sent");

  db.prepare("UPDATE campaigns SET active=0 WHERE id=?").run(kampagne);
});

test("zählt Kommentare nicht als Nachricht an die Person", () => {
  const id = Number(db.prepare(
    "INSERT INTO contacts(profile_url,full_name,status) VALUES('https://example.test/nur-kommentar','Nur Kommentar','accepted')",
  ).run().lastInsertRowid);
  db.prepare(
    `INSERT INTO drafts(contact_id,kind,thread_url,participant,incoming,draft,status,sent_at)
     VALUES(?,'comment','https://example.test/post','Nur Kommentar','','Starker Punkt!','sent','2026-08-17 08:00:00')`,
  ).run(id);
  assert.equal(outboundHistory(id).count, 0, "ein Post-Kommentar ist keine Direktnachricht");
});
