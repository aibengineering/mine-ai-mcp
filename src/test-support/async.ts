/**
 * Ordering tools for tests that hold work open and release it at a chosen
 * moment, instead of sleeping and hoping the work got that far.
 */

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

/**
 * A promise the test settles by hand: an executor awaits `promise` and the
 * test calls `resolve` when the moment it is proving has been reached.
 * `Promise.withResolvers`, which the ES2023 library this package targets does
 * not yet type.
 */
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/**
 * One event-loop turn: every microtask queued so far has run, and so has any
 * work those microtasks queued. Use it to let a started executor reach its
 * first await, not to wait for time to pass.
 */
export function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
