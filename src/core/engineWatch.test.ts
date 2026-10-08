import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-enginewatch-"));
process.env.DB_PATH = join(dir, "enginewatch.sqlite");
const { db, setState } = await import("../db/index.js");
const {
  protokolliereNeustart, offeneNeustartMeldungen, markiereNeustartsBerichtet,
  kuerzeNeustartProtokoll, stillstandGrund, jobHaengt,
} = await import("../modules/engineWatch.js");
const { recordJobFailure, retryJob } = await import("../core/jobReliability.js");

// Sendeweg frisch geprüft und in Ordnung – sonst erklärt die Diagnose (zu Recht) den fehlenden
// Selbst-Check, und die Tests unten messen nicht das, was sie messen sollen.
const sendewegOk = () => { setState("send_health", "ok"); setState("send_health_ts", new Date().toISOString()); setState("send_health_check_fehler", ""); };
sendewegOk();

// Warm-up abgeschlossen, damit die Caps die vollen Werte haben und die Tests nicht
// versehentlich den Warm-up-Zweig messen.
setState("start_date", new Date(Date.now() - 90 * 86_400_000).toISOString());

const leereAktionen = () => db.prepare("DELETE FROM actions").run();
const leereEntwuerfe = () => db.prepare("DELETE FROM drafts").run();
const sende = (type: string, wannSek = 0) =>
  db.prepare("INSERT INTO actions(type,target,status,created_at) VALUES(?,?, 'done', ?)")
    .run(type, "x", new Date(Date.now() - wannSek * 1000).toISOString().slice(0, 19).replace("T", " "));

test("Neustarts werden protokolliert; ein gewollter Autostart ist keine Störung", () => {
  protokolliereNeustart({ grund: "watchdog", detail: "Kein Heartbeat seit 180s.", letzterJob: "outreach", heartbeatAlterSek: 180 });
  protokolliereNeustart({ grund: "absturz", detail: "unhandledRejection: kaputt" });
  protokolliereNeustart({ grund: "autostart", detail: "Serverstart" });

  const offen = offeneNeustartMeldungen();
  assert.equal(offen.length, 2, "autostart darf nicht gemeldet werden");
  assert.deepEqual(offen.map((n) => n.grund).sort(), ["absturz", "watchdog"]);
  assert.equal(offen.find((n) => n.grund === "watchdog")?.letzter_job, "outreach");

  // Einmal gemeldet heisst: nie wieder. Sonst wiederholt sich dieselbe Meldung bei jedem Start.
  markiereNeustartsBerichtet(offen.map((n) => n.id));
  assert.equal(offeneNeustartMeldungen().length, 0);
});

test("das Protokoll wächst nicht unbegrenzt", () => {
  for (let i = 0; i < 40; i++) protokolliereNeustart({ grund: "watchdog", detail: `Lauf ${i}` });
  kuerzeNeustartProtokoll(10);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM engine_neustarts").get() as { n: number }).n, 10);
});

test("Not-Aus schlägt jede andere Erklärung", () => {
  leereAktionen(); leereEntwuerfe();
  setState("send_stop", "1");
  const stand = stillstandGrund();
  assert.equal(stand.steht, true);
  assert.match(stand.grund, /Not-Aus/);
  assert.ok(stand.tun, "Bei Not-Aus muss eine Handlung genannt sein");
  setState("send_stop", "0");
});

test("offene Entwürfe werden VOR dem Anfrage-Limit genannt", () => {
  leereAktionen(); leereEntwuerfe();
  // Anfrage-Cap voll, Nachrichten-Kontingent frei, Entwürfe warten: der Nutzer ist am Zug.
  for (let i = 0; i < 25; i++) sende("connect");
  for (let i = 0; i < 3; i++) {
    db.prepare("INSERT INTO drafts(kind,thread_url,participant,draft,status) VALUES('first',?,?,?,'pending')")
      .run(`https://example.test/${i}`, "A", "Text");
  }
  const stand = stillstandGrund();
  assert.equal(stand.steht, true);
  assert.match(stand.grund, /3 Entwürfe warten auf deine Freigabe/);
  assert.match(stand.tun, /freigeben/i);
});

test("Richtungswahlen zählen nicht als freizugebender Entwurf", () => {
  leereAktionen(); leereEntwuerfe();
  for (let i = 0; i < 25; i++) sende("connect");
  db.prepare("INSERT INTO drafts(kind,thread_url,participant,draft,status,phase) VALUES('first',?,?,?,'pending','approach')")
    .run("https://example.test/approach", "A", "Richtung");
  const stand = stillstandGrund();
  assert.doesNotMatch(stand.grund, /Freigabe/, "eine nicht sendbare Richtungswahl ist kein wartender Entwurf");
});

test("ohne Hinderungsgrund wird nichts gemeldet", () => {
  leereAktionen(); leereEntwuerfe();
  const stand = stillstandGrund();
  assert.equal(stand.steht, false);
  assert.equal(stand.seitSek, null, "ohne jede Aktion gibt es keine Dauer");
});

test("die Dauer seit der letzten Sendung wird gemessen", () => {
  leereAktionen(); leereEntwuerfe();
  sende("message", 4 * 3600);
  const stand = stillstandGrund();
  assert.ok(stand.seitSek !== null && stand.seitSek > 3.5 * 3600, `erwartet ~4h, war ${stand.seitSek}`);
});

test("ein defekter oder ungeprüfter Sendeweg ist ein benannter Grund", () => {
  leereAktionen(); leereEntwuerfe();
  setState("send_health", "broken"); setState("send_health_grund", "Senden-Knopf nicht gefunden");
  let stand = stillstandGrund();
  assert.equal(stand.steht, true);
  assert.match(stand.grund, /defekt.*Senden-Knopf/);
  // Prüfung älter als 8 h = Governor blockiert ebenfalls → muss erklärt werden.
  setState("send_health", "ok"); setState("send_health_ts", new Date(Date.now() - 9 * 3600_000).toISOString());
  setState("send_health_check_fehler", "2026-10-08T07:15:00.000Z Prüfung nicht möglich: net::ERR_NAME_NOT_RESOLVED");
  stand = stillstandGrund();
  assert.equal(stand.steht, true);
  assert.match(stand.grund, /nicht frisch geprüft/);
  assert.match(stand.grund, /ERR_NAME_NOT_RESOLVED/, "der Grund der ausgefallenen Prüfung gehört in die Erklärung");
  sendewegOk();
  assert.equal(stillstandGrund().steht, false);
});

test("ein nach wiederholten Fehlern angehaltener Sende-Job wird genannt", () => {
  leereAktionen(); leereEntwuerfe(); sendewegOk();
  for (let i = 0; i < 3; i++) recordJobFailure("sendApproved", new Error("Target closed"));
  const stand = stillstandGrund();
  assert.equal(stand.steht, true);
  assert.match(stand.grund, /Angehalten.*sendApproved/);
  assert.match(stand.tun, /freigeben/);
  retryJob("sendApproved");
  assert.equal(stillstandGrund().steht, false);
});

test("ein Job, der sein Zeitlimit weit überschreitet, gilt als hängend", () => {
  leereAktionen(); leereEntwuerfe(); sendewegOk();
  db.prepare("DELETE FROM bot_activity").run();
  setState("engine_active_job", "agent");
  // agent hat 20 Min Limit + 10 Min Puffer: nach 25 Minuten noch nicht hängend, nach 40 schon.
  db.prepare("INSERT INTO bot_activity(job,status,started_at) VALUES('agent','running',datetime('now','-25 minutes'))").run();
  assert.equal(jobHaengt(), null);
  db.prepare("UPDATE bot_activity SET started_at=datetime('now','-40 minutes')").run();
  const h = jobHaengt();
  assert.ok(h && h.job === "agent" && h.minuten >= 39, `erwartet hängenden agent-Job, war ${JSON.stringify(h)}`);
  const stand = stillstandGrund();
  assert.match(stand.grund, /„agent“ hängt/);
  // Kein aktiver Job → nichts hängt, egal was in der Tabelle steht.
  setState("engine_active_job", "");
  assert.equal(jobHaengt(), null);
  db.prepare("DELETE FROM bot_activity").run();
});

test.after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
