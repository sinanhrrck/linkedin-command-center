import assert from "node:assert/strict";
import test from "node:test";
import { SerialJobQueue } from "./jobQueue.js";

test("führt wartende Jobs nach Priorität aus", async () => {
  const queue = new SerialJobQueue();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = queue.enqueue("outreach", async () => { order.push("outreach"); await firstGate; }, 20);
  await Promise.resolve();
  const low = queue.enqueue("content", async () => { order.push("content"); }, 10);
  const high = queue.enqueue("sendApproved", async () => { order.push("sendApproved"); }, 100);
  releaseFirst();

  await Promise.all([first.done, low.done, high.done]);
  assert.deepEqual(order, ["outreach", "sendApproved", "content"]);
});

test("merkt denselben Job nur einmal vor", async () => {
  const queue = new SerialJobQueue();
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const first = queue.enqueue("drafts", async () => { runs += 1; await gate; });
  await Promise.resolve();
  const duplicate = queue.enqueue("drafts", async () => { runs += 1; });
  assert.equal(duplicate.queued, false);
  release();
  await first.done;
  assert.equal(runs, 1);
});
