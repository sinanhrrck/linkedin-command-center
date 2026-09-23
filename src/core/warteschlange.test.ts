import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-warteschlange-"));
process.env.DB_PATH = join(dir, "warteschlange.sqlite");
const { db, setState } = await import("../db/index.js");
const { warteschlange } = await import("../modules/warteschlange.js");
const { recordJobFailure } = await import("../core/jobReliability.js");

setState("start_date", new Date(Date.now() - 90 * 86_400_000).toISOString());
setState("working_hours_off", "1"); // Uhrzeit darf das Ergebnis nicht beeinflussen
setState("send_health", "ok");
setState("send_health_ts", new Date().toISOString());
const lebt = () => setState("engine_heartbeat", new Date().toISOString());

const kontakt = (url: string, status: string, extra = "") =>
  db.prepare(`INSERT INTO contacts(profile_url,full_name,status${extra ? "," + extra.split("=")[0] : ""}) VALUES(?,?,?${extra ? ",?" : ""})`)
    .run(...[url, `Name ${url}`, status, ...(extra ? [extra.split("=")[1]] : [])]);
const entwurf = (url: string, status: string, kind = "first") =>
  db.prepare("INSERT INTO drafts(thread_url,participant,kind,draft,status) VALUES(?,?,?,?,?)").run(url, `P ${url}`, kind, "Hallo", status);
const kanal = (k: "nachrichten" | "anfragen") => warteschlange().find((x) => x.kanal === k)!;

test("ohne Heartbeat ist jeder Kanal gestoppt – nicht „läuft“", () => {
  setState("engine_heartbeat", new Date(Date.now() - 10 * 60_000).toISOString());
  kontakt("u1", "new");
  assert.equal(kanal("anfragen").status, "gestoppt");
});

test("freigegebene Entwürfe zählen als bereit, offene als „wartet auf dich“", () => {
  lebt();
  entwurf("a", "approved");
  entwurf("b", "approved", "followup");
  entwurf("c", "pending");
  db.prepare("INSERT INTO drafts(thread_url,participant,kind,draft,status,phase) VALUES('d','x','first','x','pending','approach')").run();
  const n = kanal("nachrichten");
  assert.equal(n.bereit, 2);
  assert.equal(n.wartetAufDich, 1, "Richtungswahlen sind nicht sendbar und zählen nicht");
  assert.equal(n.naechste[0].art, "Erstnachricht");
  if (!/Sonntag/.test(n.statusText)) assert.equal(n.status, "laeuft");
});

test("Anfragen-Warteschlange folgt der Auswahl des Outreach-Ticks", () => {
  lebt();
  kontakt("u2", "new");
  kontakt("u3", "new", "do_not_contact=1");
  kontakt("u4", "invited");
  const a = kanal("anfragen");
  assert.equal(a.bereit, 2, "nur status=new ohne Sperre");
  assert.equal(a.status, "laeuft");
  assert.ok(a.naechsterVersuch);
});

test("technischer Dauerfehler stoppt den Kanal und nennt die Ursache verständlich", () => {
  lebt();
  for (let i = 0; i < 5; i++) recordJobFailure("outreach", new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://www.linkedin.com/"));
  const a = kanal("anfragen");
  assert.equal(a.status, "gestoppt");
  assert.match(a.statusText, /nicht erreichbar/);
});

test("Not-Aus schlägt alles andere", () => {
  lebt();
  setState("send_stop", "1");
  assert.equal(kanal("nachrichten").status, "gestoppt");
  assert.match(kanal("nachrichten").statusText, /Not-Aus/);
  setState("send_stop", "0");
});
