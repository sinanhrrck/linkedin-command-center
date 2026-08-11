import { db } from "../db/index.js";

export type JobReliabilityState = {
  job: string;
  status: "ready" | "backoff" | "dead" | "resolved";
  consecutiveFailures: number;
  lastError: string | null;
  lastFailedAt: string | null;
  nextAttemptAt: string | null;
  deadAt: string | null;
};

const MAX_FAILURES = 3;
const BACKOFF_MINUTES = [5, 30] as const;
const iso = (date: Date) => date.toISOString();

function row(job: string): JobReliabilityState | null {
  const value = db.prepare(
    `SELECT job,status,consecutive_failures consecutiveFailures,last_error lastError,
            last_failed_at lastFailedAt,next_attempt_at nextAttemptAt,dead_at deadAt
       FROM job_reliability WHERE job=?`,
  ).get(job) as JobReliabilityState | undefined;
  return value ?? null;
}

export function jobRunPermission(job: string, now = new Date()): { allowed: boolean; state: JobReliabilityState | null; reason?: string } {
  const state = row(job);
  if (!state || state.status === "ready" || state.status === "resolved") return { allowed: true, state };
  if (state.status === "dead") return { allowed: false, state, reason: "Nach wiederholten Fehlern angehalten – manuelle Prüfung nötig" };
  if (!state.nextAttemptAt || new Date(state.nextAttemptAt).getTime() <= now.getTime()) return { allowed: true, state };
  return { allowed: false, state, reason: `Nächster kontrollierter Versuch ${state.nextAttemptAt}` };
}

export function recordJobSuccess(job: string, now = new Date()): void {
  db.prepare(
    `UPDATE job_reliability
        SET status='resolved',consecutive_failures=0,last_error=NULL,next_attempt_at=NULL,
            dead_at=NULL,resolved_at=?,updated_at=?
      WHERE job=?`,
  ).run(iso(now), iso(now), job);
}

export function recordJobFailure(job: string, error: unknown, now = new Date()): JobReliabilityState {
  const previous = row(job);
  const failures = (previous?.status === "resolved" ? 0 : previous?.consecutiveFailures || 0) + 1;
  const dead = failures >= MAX_FAILURES;
  const delay = BACKOFF_MINUTES[Math.min(failures - 1, BACKOFF_MINUTES.length - 1)];
  const next = dead ? null : iso(new Date(now.getTime() + delay * 60_000));
  const message = String((error as Error)?.message || error || "Unbekannter Fehler").slice(0, 500);
  db.prepare(
    `INSERT INTO job_reliability(job,status,consecutive_failures,last_error,last_failed_at,next_attempt_at,dead_at,resolved_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(job) DO UPDATE SET
       status=excluded.status,consecutive_failures=excluded.consecutive_failures,last_error=excluded.last_error,
       last_failed_at=excluded.last_failed_at,next_attempt_at=excluded.next_attempt_at,dead_at=excluded.dead_at,
       resolved_at=NULL,updated_at=excluded.updated_at`,
  ).run(job, dead ? "dead" : "backoff", failures, message, iso(now), next, dead ? iso(now) : null, null, iso(now));
  return row(job)!;
}

export function retryJob(job: string, now = new Date()): boolean {
  return db.prepare(
    `UPDATE job_reliability
        SET status='ready',consecutive_failures=0,last_error=NULL,next_attempt_at=NULL,
            dead_at=NULL,resolved_at=NULL,updated_at=?
      WHERE job=? AND status IN ('backoff','dead')`,
  ).run(iso(now), job).changes > 0;
}

export function openJobFailures(): JobReliabilityState[] {
  return db.prepare(
    `SELECT job,status,consecutive_failures consecutiveFailures,last_error lastError,
            last_failed_at lastFailedAt,next_attempt_at nextAttemptAt,dead_at deadAt
       FROM job_reliability WHERE status IN ('backoff','dead')
      ORDER BY status='dead' DESC,updated_at DESC`,
  ).all() as JobReliabilityState[];
}
