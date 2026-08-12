import { AsyncLocalStorage } from "node:async_hooks";

type JobExecution = { job: string; signal: AbortSignal };
const execution = new AsyncLocalStorage<JobExecution>();

export class JobTimeoutError extends Error {
  constructor(public readonly job: string, public readonly timeoutMs: number) {
    super(`Zeitlimit für ${job} nach ${Math.round(timeoutMs / 60_000)} Minuten erreicht`);
    this.name = "JobTimeoutError";
  }
}

export const JOB_TIMEOUT_MS: Readonly<Record<string, number>> = Object.freeze({
  backup: 5 * 60_000,
  healthcheck: 8 * 60_000,
  acceptance: 15 * 60_000,
  outreach: 15 * 60_000,
  drafts: 20 * 60_000,
  sendApproved: 12 * 60_000,
  feed: 15 * 60_000,
  campaign: 20 * 60_000,
  post: 10 * 60_000,
  followup: 15 * 60_000,
  agent: 20 * 60_000,
  netzwerk: 30 * 60_000,
  offene: 30 * 60_000,
  comment: 15 * 60_000,
  pitch: 15 * 60_000,
  wiederbeleben: 20 * 60_000,
  reichweite: 15 * 60_000,
  content: 10 * 60_000,
  learning: 10 * 60_000,
});

export const DEFAULT_JOB_TIMEOUT_MS = 15 * 60_000;

export function currentJobSignal(): AbortSignal | null {
  return execution.getStore()?.signal ?? null;
}

export function throwIfJobAborted(): void {
  const signal = currentJobSignal();
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Aufgabe abgebrochen");
}

/**
 * Zentrales, kooperatives Zeitlimit. `onTimeout` schließt den gemeinsamen Browser-Kontext;
 * dadurch brechen laufende Playwright-Aufrufe ab. Die Promise wartet trotzdem auf das echte Ende
 * des Jobs: Die serielle Queue darf niemals weiterlaufen, solange alter Code noch aktiv ist.
 */
export async function runWithJobTimeout<T>(
  job: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; onTimeout?: (error: JobTimeoutError) => void | Promise<void> } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? JOB_TIMEOUT_MS[job] ?? DEFAULT_JOB_TIMEOUT_MS;
  const controller = new AbortController();
  let timeoutError: JobTimeoutError | null = null;
  let timeoutAction: Promise<void> | null = null;

  const timer = setTimeout(() => {
    timeoutError = new JobTimeoutError(job, timeoutMs);
    controller.abort(timeoutError);
    timeoutAction = Promise.resolve(options.onTimeout?.(timeoutError)).then(() => undefined);
  }, timeoutMs);

  try {
    const result = await execution.run({ job, signal: controller.signal }, fn);
    const actionAfterRun = timeoutAction as Promise<void> | null;
    if (actionAfterRun) await actionAfterRun;
    if (timeoutError) throw timeoutError;
    return result;
  } catch (error) {
    const actionAfterError = timeoutAction as Promise<void> | null;
    if (actionAfterError) await actionAfterError.catch(() => {});
    if (timeoutError) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
