import assert from "node:assert/strict";
import test from "node:test";

import { TaskCoordinator } from "../src/concurrency/task-coordinator.js";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("runs tasks for one user sequentially", async () => {
  const coordinator = new TaskCoordinator(2);
  const service = new AbortController();
  const gate = deferred();
  const events: string[] = [];

  const first = coordinator.enqueue(
    "1001",
    async () => {
      events.push("first-start");
      await gate.promise;
      events.push("first-end");
    },
    service.signal,
  );
  const second = coordinator.enqueue(
    "1001",
    async () => {
      events.push("second");
    },
    service.signal,
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, ["first-start"]);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second"]);
});

test("allows different users up to the global limit", async () => {
  const coordinator = new TaskCoordinator(2);
  const service = new AbortController();
  const gate = deferred();
  let active = 0;
  let maximumActive = 0;

  const tasks = ["1001", "1002", "1003"].map((userId) =>
    coordinator.enqueue(
      userId,
      async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await gate.promise;
        active -= 1;
      },
      service.signal,
    ),
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(maximumActive, 2);
  gate.resolve();
  await Promise.all(tasks);
});

test("cancels the active task for one user", async () => {
  const coordinator = new TaskCoordinator(1);
  const service = new AbortController();
  let aborted = false;

  const running = coordinator.enqueue(
    "1001",
    (signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
      }),
    service.signal,
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(coordinator.cancel("1001"), true);
  await running;
  assert.equal(aborted, true);
});
