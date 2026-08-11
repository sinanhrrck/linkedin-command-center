import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-job-reliability-"));
process.env.DB_PATH = join(dir, "reliability.sqlite");

const { db } = await import("../db/index.js");
const { jobRunPermission, openJobFailures, recordJobFailure, recordJobSuccess, retryJob } = await import("./jobReliability.js");

test("bremst technische Wiederholungen und verschiebt den nächsten Versuch", () => {
  db.prepare("DELETE FROM job_reliability").run();
  const now = new Date("2026-08-11T10:00:00.000Z");
  const state = recordJobFailure("healthcheck", new Error("Browser nicht erreichbar"), now);
  assert.equal(state.status, "backoff");
  assert.equal(state.consecutiveFailures, 1);
  assert.equal(jobRunPermission("healthcheck", new Date("2026-08-11T10:04:59.000Z")).allowed, false);
  assert.equal(jobRunPermission("healthcheck", new Date("2026-08-11T10:05:00.000Z")).allowed, true);
});

test("legt nach drei Fehlern einen Dead-Letter-Fall an und lässt ihn gezielt freigeben", () => {
  db.prepare("DELETE FROM job_reliability").run();
  const start = new Date("2026-08-11T10:00:00.000Z");
  recordJobFailure("campaign", "eins", start);
  recordJobFailure("campaign", "zwei", new Date(start.getTime() + 5 * 60_000));
  const dead = recordJobFailure("campaign", "drei", new Date(start.getTime() + 35 * 60_000));
  assert.equal(dead.status, "dead");
  assert.equal(jobRunPermission("campaign", new Date("2026-08-12T10:00:00.000Z")).allowed, false);
  assert.equal(openJobFailures().length, 1);
  assert.equal(retryJob("campaign"), true);
  assert.equal(jobRunPermission("campaign").allowed, true);
});

test("ein erfolgreicher Lauf löst eine frühere Fehlerfolge", () => {
  db.prepare("DELETE FROM job_reliability").run();
  recordJobFailure("drafts", "kurzer Ausfall");
  recordJobSuccess("drafts");
  assert.equal(openJobFailures().length, 0);
  assert.equal(jobRunPermission("drafts").allowed, true);
});
