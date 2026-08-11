import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { db, getState, setState } from "../db/index.js";

export type UserReportInput = {
  kind: "error" | "feedback";
  message?: string;
  replyEmail?: string;
  activityId?: number;
  screenshot?: { mimeType?: string; base64?: string; width?: number; height?: number } | null;
};

type QueuedReport = {
  id: number;
  report_id: string;
  kind: "error" | "feedback";
  message: string | null;
  reply_email: string | null;
  activity_job: string | null;
  activity_detail: string | null;
  activity_at: string | null;
  screenshot_base64: string | null;
  screenshot_mime: string | null;
  screenshot_width: number | null;
  screenshot_height: number | null;
  created_at: string;
};

type FailedActivity = { job: string; detail: string | null; finished_at: string | null; started_at: string };

const cleanText = (value: unknown, max: number): string => String(value ?? "")
  .replace(/https?:\/\/\S+/gi, "[Link entfernt]")
  .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[E-Mail entfernt]")
  .replace(/(?:\/Users\/|[A-Z]:\\Users\\)[^\s]+/gi, "[lokaler Pfad entfernt]")
  .replace(/((?:api[_-]?key|token|secret|password)\s*)[:=]\s*\S+/gi, "$1=[entfernt]")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const validReplyEmail = (value: unknown): string | null => {
  const email = String(value ?? "").trim().slice(0, 180);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
};

function validScreenshot(input: UserReportInput["screenshot"]): { mimeType: "image/jpeg"; base64: string; width: number; height: number } | null {
  if (!input) return null;
  if (input.mimeType !== "image/jpeg") throw new Error("Der Screenshot muss ein JPEG-Bild sein.");
  const base64 = String(input.base64 || "").trim();
  if (!base64.startsWith("/9j/") || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error("Der Screenshot ist beschädigt.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 100 || bytes.length > 1_100_000) throw new Error("Der Screenshot ist zu groß oder leer.");
  const width = Math.max(1, Math.min(4000, Math.round(Number(input.width) || 1)));
  const height = Math.max(1, Math.min(4000, Math.round(Number(input.height) || 1)));
  return { mimeType: "image/jpeg", base64, width, height };
}

function installationId(): string {
  let id = getState("report_installation_id");
  if (!id) {
    id = randomUUID();
    setState("report_installation_id", id);
  }
  return id;
}

export async function queueUserReport(input: UserReportInput): Promise<{ sent: boolean; queued: boolean; reportId: string }> {
  if (input.kind !== "error" && input.kind !== "feedback") throw new Error("Unbekannte Meldungsart.");
  const message = cleanText(input.message, 2000);
  const screenshot = validScreenshot(input.screenshot);
  if (input.kind === "feedback" && message.length < 3) throw new Error("Bitte beschreibe dein Feedback kurz.");

  let activity: FailedActivity | undefined;
  if (input.kind === "error") {
    const id = Number(input.activityId);
    if (!Number.isInteger(id) || id <= 0) throw new Error("Der Fehler konnte nicht zugeordnet werden.");
    activity = db.prepare(
      "SELECT job,detail,finished_at,started_at FROM bot_activity WHERE id=? AND status='failed'",
    ).get(id) as FailedActivity | undefined;
    if (!activity) throw new Error("Dieser Fehler ist nicht mehr im lokalen Protokoll vorhanden.");
  }

  const reportId = randomUUID();
  db.prepare(
    `INSERT INTO user_reports(report_id,kind,message,reply_email,activity_job,activity_detail,activity_at,
                              screenshot_base64,screenshot_mime,screenshot_width,screenshot_height)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    reportId,
    input.kind,
    message || null,
    validReplyEmail(input.replyEmail),
    activity?.job ? cleanText(activity.job, 80) : null,
    activity?.detail ? cleanText(activity.detail, 600) : null,
    activity?.finished_at || activity?.started_at || null,
    screenshot?.base64 || null,
    screenshot?.mimeType || null,
    screenshot?.width || null,
    screenshot?.height || null,
  );

  const sent = (await flushPendingReports(1)).includes(reportId);
  return { sent, queued: !sent, reportId };
}

let flushPromise: Promise<string[]> | null = null;

/** Versendet lokal vorgemerkte Meldungen; nur ein Flush gleichzeitig, damit keine Mail doppelt geht. */
export function flushPendingReports(limit = 8): Promise<string[]> {
  if (flushPromise) return flushPromise;
  flushPromise = flushPendingReportsNow(limit).finally(() => { flushPromise = null; });
  return flushPromise;
}

async function flushPendingReportsNow(limit: number): Promise<string[]> {
  const endpoint = config.reporting.endpoint.trim();
  // Kein Relay wurde bewusst konfiguriert: lokal aufbewahren und keinerlei fremde Domain
  // anhand der Empfängeradresse erraten oder kontaktieren.
  if (!endpoint) return [];
  const rows = db.prepare(
    `SELECT id,report_id,kind,message,reply_email,activity_job,activity_detail,activity_at,
            screenshot_base64,screenshot_mime,screenshot_width,screenshot_height,created_at
       FROM user_reports
      WHERE status='pending' AND (next_attempt IS NULL OR next_attempt<=datetime('now'))
      ORDER BY created_at LIMIT ?`,
  ).all(Math.max(1, Math.min(20, limit))) as QueuedReport[];
  const sent: string[] = [];
  for (const row of rows) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "NextLead-Desktop" },
        body: JSON.stringify({
          reportId: row.report_id,
          installationId: installationId(),
          kind: row.kind,
          message: row.message,
          replyEmail: row.reply_email,
          activity: row.activity_job ? { job: row.activity_job, detail: row.activity_detail, at: row.activity_at } : null,
          screenshot: row.screenshot_base64 ? {
            mimeType: row.screenshot_mime,
            base64: row.screenshot_base64,
            width: row.screenshot_width,
            height: row.screenshot_height,
          } : null,
          appVersion: getState("engine_code_version") || "unbekannt",
          platform: process.platform,
          arch: process.arch,
          createdAt: row.created_at,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Meldedienst HTTP ${response.status}`);
      db.prepare("UPDATE user_reports SET status='sent',sent_at=datetime('now'),attempts=attempts+1,last_error=NULL WHERE id=?")
        .run(row.id);
      sent.push(row.report_id);
    } catch (error) {
      db.prepare(
        `UPDATE user_reports SET attempts=attempts+1,last_error=?,
           next_attempt=datetime('now', CASE WHEN attempts<3 THEN '+5 minutes' ELSE '+1 hour' END)
         WHERE id=?`,
      ).run(cleanText((error as Error)?.message || error, 180), row.id);
    }
  }
  return sent;
}
