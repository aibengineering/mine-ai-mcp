interface PhysicsTickSource {
  on(event: "physicsTick", listener: () => void): unknown;
  off(event: "physicsTick", listener: () => void): unknown;
}

/** Wait for observed physics, releasing immediately on abort even if physics has stopped. */
export async function waitForPhysicsTicks(
  source: PhysicsTickSource,
  ticks: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (ticks <= 0) return;
  await new Promise<void>((resolve, reject) => {
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
