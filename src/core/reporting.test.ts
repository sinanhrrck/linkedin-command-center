import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "nextlead-reporting-"));
process.env.DB_PATH = join(dir, "reporting.sqlite");

const received: unknown[] = [];
const relay = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    received.push(JSON.parse(body));
    res.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
  });
});
await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
const address = relay.address();
if (!address || typeof address === "string") throw new Error("Test-Relay konnte nicht starten");
process.env.NEXTLEAD_REPORT_ENDPOINT = `http://127.0.0.1:${address.port}/api/nextlead-report`;

const { db } = await import("../db/index.js");
const { queueUserReport } = await import("../modules/reporting.js");

test("Fehlerbericht stammt aus der DB und entfernt persönliche oder geheime Werte", async () => {
  const activityId = Number(db.prepare(
    `INSERT INTO bot_activity(job,status,detail,finished_at)
     VALUES('feed','failed',?,datetime('now'))`,
  ).run("Fehler auf https://linkedin.com/in/person token=sehrgeheim bei /Users/test/privat").lastInsertRowid);

  const result = await queueUserReport({
    kind: "error",
    activityId,
    message: "Bitte an person@example.com antworten; Profil https://linkedin.com/in/person",
  });
  assert.equal(result.sent, true);
  const stored = db.prepare("SELECT activity_detail,message,status FROM user_reports WHERE report_id=?").get(result.reportId) as
    { activity_detail: string; message: string; status: string };
  assert.equal(stored.status, "sent");
  assert.doesNotMatch(stored.activity_detail, /linkedin|sehrgeheim|\/Users\/test/);
  assert.doesNotMatch(stored.message, /person@example|linkedin/);
  assert.equal(received.length, 1);
});

test("allgemeines Feedback kann installationsübergreifend versendet werden", async () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(140, 7)]).toString("base64");
  const result = await queueUserReport({
    kind: "feedback",
    message: "Die Kampagnenanzeige ist unklar.",
    screenshot: { mimeType: "image/jpeg", base64: jpeg, width: 640, height: 320 },
  });
  assert.equal(result.sent, true);
  assert.equal(received.length, 2);
  assert.deepEqual((received[1] as { screenshot: { mimeType: string; width: number; height: number } }).screenshot,
    { mimeType: "image/jpeg", base64: jpeg, width: 640, height: 320 });
});

test("weist fremde oder beschädigte Bilddaten ab", async () => {
  await assert.rejects(() => queueUserReport({
    kind: "feedback", message: "Bildtest", screenshot: { mimeType: "image/png", base64: "nicht-echt" },
  }), /JPEG/);
});

test.after(async () => {
  db.close();
  await new Promise<void>((resolve, reject) => relay.close((error) => error ? reject(error) : resolve()));
  rmSync(dir, { recursive: true, force: true });
});
