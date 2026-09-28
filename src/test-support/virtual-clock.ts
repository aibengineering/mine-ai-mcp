import type { TestContext } from "node:test";

/**
 * Settle `start()` on node:test's mocked `setTimeout` and `Date`, advancing
 * virtual time in small steps between event-loop turns, and report how much
 * time passed.
 *
 * Actions bound their waits with real deadlines (an acknowledgement window, a
 * slot that must settle, a drop that may still arrive), some measured with
 * `Date.now`. A test that asserts what happens when such a deadline lapses
 * would otherwise sleep through it. Stepping keeps the order real time would
 * give: each timer fires only after the work scheduled before it has run.
 * The clock starts at the real time, and real timers return once it settles.
 */
export async function onVirtualClock<T>(
  t: TestContext,
  start: () => Promise<T>,
): Promise<{ value: T; elapsedMs: number }> {
  const stepMs = 10;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    let settled = false;
    const pending = start().finally(() => { settled = true; });
    let elapsedMs = 0;
    while (!settled) {
      await new Promise((resolve) => setImmediate(resolve));
      if (settled) break;
      if (elapsedMs >= 60_000) throw new Error("The operation never settled on the virtual clock.");
      t.mock.timers.tick(stepMs);
      elapsedMs += stepMs;
    }
    return { value: await pending, elapsedMs };
  } finally {
    t.mock.timers.reset();
  }
}
