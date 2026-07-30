/**
 * Serielle Warteschlange für alle Engine-Aufgaben.
 *
 * Playwright arbeitet mit genau einer LinkedIn-Session. Parallel laufende Jobs würden sich dort
 * gegenseitig weg-navigieren; früher wurden sie deshalb verworfen. Diese Queue behält jeden
 * fälligen Job einmal vor und führt ihn anschliessend nach Priorität aus.
 */
export type JobQueueSnapshot = {
  activeJob: string | null;
  queuedJobs: number;
  nextJob: string | null;
};

type QueuedJob = {
  name: string;
  priority: number;
  order: number;
  run: () => Promise<unknown>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export type EnqueueResult = { queued: boolean; done: Promise<void> };

export class SerialJobQueue {
  private active: QueuedJob | null = null;
  private queued = new Map<string, QueuedJob>();
  private sequence = 0;
  private draining = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly onChange?: (snapshot: JobQueueSnapshot) => void) {}

  enqueue(name: string, run: () => Promise<unknown>, priority = 50): EnqueueResult {
    // Ein Cron-Tick desselben Typs kann nichts Neues beitragen, solange sein Vorgänger noch
    // arbeitet oder bereits wartet. So bleibt die Queue klein, ohne Arbeit anderer Jobs zu verlieren.
    if (this.active?.name === name || this.queued.has(name)) {
      return { queued: false, done: Promise.resolve() };
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    this.queued.set(name, { name, priority, order: this.sequence++, run, resolve, reject });
    this.emit();
    void this.drain();
    return { queued: true, done };
  }

  snapshot(): JobQueueSnapshot {
    const next = this.next();
    return { activeJob: this.active?.name ?? null, queuedJobs: this.queued.size, nextJob: next?.name ?? null };
  }

  async whenIdle(): Promise<void> {
    if (!this.active && this.queued.size === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private next(): QueuedJob | undefined {
    return [...this.queued.values()].sort((a, b) => b.priority - a.priority || a.order - b.order)[0];
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queued.size > 0) {
        const job = this.next();
        if (!job) break;
        this.queued.delete(job.name);
        this.active = job;
        this.emit();
        try {
          await job.run();
          job.resolve();
        } catch (error) {
          job.reject(error);
        } finally {
          this.active = null;
          this.emit();
        }
      }
    } finally {
      this.draining = false;
      if (!this.active && this.queued.size === 0) {
        for (const resolve of this.idleWaiters.splice(0)) resolve();
      }
    }
  }

  private emit() {
    this.onChange?.(this.snapshot());
  }
}
