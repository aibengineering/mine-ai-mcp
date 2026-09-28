/**
 * Operator diagnostics a test provokes on purpose: supervisor failure reports,
 * host readiness and connection notices. (A persistent store's lifecycle and
 * lock records go to a sink instead; see `persistentBotData`.)
 *
 * Production writes these to stdout and stderr for whoever runs the process.
 * In a test run they are expected, so printed they only bury the report;
 * captured, a test can assert the notice an operator would have been shown.
 */
export interface CapturedOutput {
  /** Everything written so far, one entry per write, trailing newline removed. */
  readonly lines: readonly string[];
  /** The captured lines containing `text`. */
  including(text: string): string[];
}

/**
 * Capture `process.stdout`, `process.stderr` and `console.error` until the test
 * ends. Bun's `console.error` does not pass through `process.stderr.write`, so
 * it is replaced too; `console.log` is left alone for a developer's own prints.
 * Tests run one at a time, so the capture belongs to this test alone.
 *
 * `after` hooks run in the order they were registered, so call this after
 * creating any fixture whose teardown also reports (a host closing its
 * bot data reports that); otherwise that report escapes the capture.
 */
export function captureOutput(t: { after(fn: () => void): void }): CapturedOutput {
  const lines: string[] = [];
  const streams = [process.stdout, process.stderr];
  const writes = streams.map((stream) => stream.write);
  const error = console.error;
  for (const stream of streams) {
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      lines.push((typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()).replace(/\n$/, ""));
      // Honour the write callback, as the stream would once the chunk is flushed.
      const callback = rest.find((argument) => typeof argument === "function") as (() => void) | undefined;
      callback?.();
      return true;
    }) as typeof stream.write;
  }
  console.error = (...values: unknown[]) => {
    lines.push(values.map(String).join(" "));
  };
  t.after(() => {
    streams.forEach((stream, index) => {
      stream.write = writes[index]!;
    });
    console.error = error;
  });
  return { lines, including: (text) => lines.filter((line) => line.includes(text)) };
}
