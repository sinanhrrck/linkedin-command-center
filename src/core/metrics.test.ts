import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Die Module öffnen SQLite beim Import. Deshalb den isolierten Pfad setzen, bevor sie geladen
// werden – der Test berührt weder die Entwicklungs- noch die App-Datenbank.
const dir = mkdtempSync(join(tmpdir(), "nextlead-metrics-"));
process.env.DB_PATH = join(dir, "metrics.sqlite");
const { db } = await import("../db/index.js");
const { getDashboardData } = await import("../modules/dashboard.js");
const { recordCrmStage } = await import("../modules/crmStages.js");
const { getAnalytics } = await import("../modules/analytics.js");

test("trennt Funnel, aktive Antworten und Aktionsereignisse", () => {
  const old = "2026-07-20 10:00:00";
  const sourceId = Number(
    db.prepare("INSERT INTO lead_sources(label,search_url) VALUES(?,?)")
      .run("Testquelle", "https://example.test/search").lastInsertRowid,
  );
  const add = (slug: string, status: string, invited: boolean, accepted: boolean, messaged: boolean, replied: boolean) =>
    db.prepare(
      "INSERT INTO contacts(profile_url,full_name,status,source_id,invited_at,accepted_at,messaged_at,replied_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(`https://example.test/${slug}`, slug, status, sourceId, invited ? old : null, accepted ? old : null, messaged ? old : null, replied ? old : null);

  add("a", "replied", true, true, true, true);
  add("b", "closed", true, true, true, true);
  add("c", "messaged", true, true, true, false);
  add("d", "accepted", true, true, false, false);
  add("e", "invited", true, false, false, false);
  // Eine bestehende Verbindung hat keine Einladung durch dieses System durchlaufen. Sie darf
  // weder Annahmequote noch offene Outreach-Annahmen künstlich erhöhen.
  db.prepare(
    "INSERT INTO contacts(profile_url,full_name,status,accepted_at,aus_netzwerk) VALUES(?,?,?,?,1)",
  ).run("https://example.test/network", "network", "accepted", old);
  db.prepare("INSERT INTO actions(type,target) VALUES(?,?)").run("connect", "https://example.test/a");
  db.prepare("INSERT INTO actions(type,target) VALUES(?,?)").run("connect", "https://example.test/a");
  db.prepare("INSERT INTO actions(type,target) VALUES(?,?)").run("reply", "https://example.test/a");
  db.prepare("INSERT INTO drafts(kind,thread_url,participant,incoming,draft) VALUES('message',?,?,?,?)")
    .run("https://example.test/thread-a", "a", "Hallo", "Antwort");

  const dashboard = getDashboardData();
  const analytics = getAnalytics();

  assert.deepEqual(dashboard.metrics.historical, { invited: 5, accepted: 4, messaged: 3, replied: 2 });
  assert.deepEqual(dashboard.metrics.active, { accepted: 1, replies: 1, closedReplies: 1 });
  assert.deepEqual(dashboard.funnel.map((x) => x.count), [5, 5, 4, 3, 2]);
  assert.deepEqual(analytics.funnel.map((x) => x.count), [5, 5, 4, 3, 2]);
  assert.deepEqual(dashboard.metrics.connectEvents, { total: 2, uniqueTargets: 1, duplicates: 1 });
  assert.equal(dashboard.weekActivity.reduce((n, day) => n + day.total, 0), 3, "Antworten zählen zur Wochenaktivität");
  assert.equal(analytics.quellen[0]?.antwortPct, 67, "Quellenquote teilt durch angeschriebene Kontakte");
  assert.equal(analytics.projektion.anschreibRate, 75);
  assert.equal(analytics.projektion.szenarien.at(-1)?.hotLeads, 40, "Forecast enthält den Schritt Annahme → Nachricht");
  assert.equal(dashboard.drafts[0]?.profile?.profileUrl, "https://example.test/a", "Entwurf enthält die passende Profilvorschau");

  const campaignId = Number(db.prepare("INSERT INTO campaigns(name,goal_code) VALUES('B1-Rechner','B1')").run().lastInsertRowid);
  const first = Number(db.prepare(
    "INSERT INTO contacts(profile_url,full_name,status,campaign_id,messaged_at) VALUES('https://example.test/b1-a','B1 A','closed',?,?)",
  ).run(campaignId, old).lastInsertRowid);
  db.prepare(
    "INSERT INTO contacts(profile_url,full_name,status,campaign_id,messaged_at) VALUES('https://example.test/b1-b','B1 B','messaged',?,?)",
  ).run(campaignId, old);
  db.prepare("INSERT INTO sales_outcomes(contact_id,campaign_id,stage,value_cents) VALUES(?,?,?,?)")
    .run(first, campaignId, "won", 150_000);
  recordCrmStage(first, "messaged", "backfill");
  recordCrmStage(first, "won", "manual");
  const second = db.prepare("SELECT id FROM contacts WHERE profile_url='https://example.test/b1-b'").get() as { id: number };
  recordCrmStage(second.id, "messaged", "backfill");
  const economics = getDashboardData().goalEconomics.find((item) => item.goal === "B1");
  assert.deepEqual(economics, {
    goal: "B1", messaged: 2, replied: 0, qualified: 0, meeting: 0, won: 1, won_value_cents: 150_000,
    rates: { reply: 0, qualified: null, meeting: null, won: null }, conversionPct: 50, averageValueEur: 1500,
  });
});

test.after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
