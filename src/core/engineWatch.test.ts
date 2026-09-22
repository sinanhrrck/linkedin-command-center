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
  kuerzeNeustartProtokoll, stillstandGrund,
} = await import("../modules/engineWatch.js");

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

test.after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
