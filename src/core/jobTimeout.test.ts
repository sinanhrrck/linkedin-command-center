import assert from "node:assert/strict";
import test from "node:test";
import { currentJobSignal, JobTimeoutError, runWithJobTimeout, throwIfJobAborted } from "./jobTimeout.js";

test("lässt einen schnellen Job unverändert durchlaufen", async () => {
  const result = await runWithJobTimeout("test", async () => 42, { timeoutMs: 100 });
  assert.equal(result, 42);
  assert.equal(currentJobSignal(), null);
});

test("bricht kooperativ ab und wartet auf das wirkliche Jobende", async () => {
  const order: string[] = [];
  await assert.rejects(
    runWithJobTimeout("drafts", async () => {
      const signal = currentJobSignal()!;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
        order.push("job beendet");
        resolve();
      }, { once: true }));
      throwIfJobAborted();
    }, {
      timeoutMs: 15,
      onTimeout: async () => { order.push("browser geschlossen"); },
    }),
    (error: unknown) => error instanceof JobTimeoutError && error.job === "drafts",
  );
  assert.deepEqual(order, ["job beendet", "browser geschlossen"]);
});

test("auch ein intern abgefangener Abbruch bleibt ein Timeout", async () => {
  await assert.rejects(
    runWithJobTimeout("campaign", async () => {
      const signal = currentJobSignal()!;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      try { throwIfJobAborted(); } catch { return "fälschlich erfolgreich"; }
    }, { timeoutMs: 10 }),
    JobTimeoutError,
  );
});
