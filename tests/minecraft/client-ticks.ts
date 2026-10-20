/** Physics ticks observed by a scenario's own client. */
interface PhysicsTickSource {
  on(event: "physicsTick", listener: () => void): unknown;
  off(event: "physicsTick", listener: () => void): unknown;
}

/**
 * Wait for the client's own physics ticks, with no wall-clock deadline.
 *
 * Mineflayer's `waitForTicks` rejects once `ticks * 50 ms` plus five seconds
 * have passed. A loaded machine runs the client below twenty ticks a second:
 * on 2026-10-20 a fortress trial held its hundred ticks for ten seconds, saw
 * ninety-one, and failed a hunt that had already succeeded. The trial's goal
 * timeout bounds the wait; cancellation releases it.
 */
export function waitForClientTicks(source: PhysicsTickSource, ticks: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (ticks <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let remaining = ticks;
    const cleanup = () => {
      source.off("physicsTick", tick);
      signal.removeEventListener("abort", abort);
    };
    const tick = () => {
      if (--remaining > 0) return;
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    source.on("physicsTick", tick);
    signal.addEventListener("abort", abort, { once: true });
  });
}
