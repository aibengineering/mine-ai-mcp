import type { ActionContext } from "../actions/action.js";

export interface EventSource {
  on(event: string, listener: (...args: any[]) => void): any;
  off?(event: string, listener: (...args: any[]) => void): any;
  removeListener?(event: string, listener: (...args: any[]) => void): any;
}

/**
 * Why a signal stopped waiting. These are three different facts about the
 * world, so they are three different values: a caller that collapses them
 * cannot tell "it happened" from "I gave up waiting for it".
 */
export type SignalOutcome<T> = { kind: "signalled"; value: T } | { kind: "timeout" } | { kind: "cancelled" };

export interface ArmedSignal<T> {
  promise: Promise<SignalOutcome<T>>;
  /**
   * Wait from here, rather than from when the signal was armed. A signal armed
   * before a physical act must not spend its patience on the act, so the act
   * arms and whoever begins waiting sets the deadline.
   */
  settle: (timeoutMs: number) => Promise<SignalOutcome<T>>;
  cancel: () => void;
}

export interface SignalOptions {
  /**
   * How long to wait once armed. Omit when the caller bounds the wait itself
   * with `settle`. An unbounded signal listens until cancelled or aborted.
   */
  timeoutMs?: number;
  context?: ActionContext;
}

/**
 * Watch one or more emitters and resolve as soon as `check` reports something.
 * Arm it BEFORE the act it observes, so no event fires unheard; a condition
 * already true resolves immediately without attaching any listener.
 *
 * Every deadline takes one last look before reporting a timeout, because a
 * condition can become true without any watched event announcing it.
 */
export function armSignal<T>(
  emitters: EventSource | ReadonlyArray<EventSource>,
  eventNames: string | string[],
  check: () => T | null | undefined | false,
  { timeoutMs, context }: SignalOptions,
): ArmedSignal<T> {
  if (context?.signal?.aborted) {
    const cancelled = Promise.resolve<SignalOutcome<T>>({ kind: "cancelled" });
    return { promise: cancelled, settle: () => cancelled, cancel: () => {} };
  }
  const sighted = (value: NonNullable<T>): SignalOutcome<T> => ({ kind: "signalled", value });
  const lastLook = (): SignalOutcome<T> => {
    const late = check();
    return late ? sighted(late as NonNullable<T>) : { kind: "timeout" };
  };

  const immediate = check();
  if (immediate) {
    const settled = Promise.resolve(sighted(immediate as NonNullable<T>));
    return { promise: settled, settle: () => settled, cancel: () => {} };
  }

  let cancel = () => {};

  const promise = new Promise<SignalOutcome<T>>((resolve) => {
    const sources = Array.isArray(emitters) ? emitters : [emitters as EventSource];
    const events = Array.isArray(eventNames) ? eventNames : [eventNames];
    let timer: NodeJS.Timeout | null = null;
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const source of sources) {
        for (const event of events) {
          if (typeof source.off === "function") {
            source.off(event, onEvent);
          } else if (typeof source.removeListener === "function") {
            source.removeListener(event, onEvent);
          }
        }
      }
      context?.signal?.removeEventListener("abort", onAbort);
    };

    const onEvent = () => {
      if (settled) return;
      const result = check();
      if (result) {
        cleanup();
        resolve(sighted(result as NonNullable<T>));
      }
    };

    const onAbort = () => {
      cleanup();
      resolve({ kind: "cancelled" });
    };

    cancel = () => {
      cleanup();
      resolve({ kind: "cancelled" });
    };

    for (const source of sources) {
      for (const event of events) source.on(event, onEvent);
    }
    context?.signal?.addEventListener("abort", onAbort);

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (settled) return;
        const outcome = lastLook();
        cleanup();
        resolve(outcome);
      }, timeoutMs);
      if (typeof timer?.unref === "function") timer.unref();
    }
  });

  const settle = (deadlineMs: number): Promise<SignalOutcome<T>> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(lastLook()), deadlineMs);
      if (typeof timer?.unref === "function") timer.unref();
      void promise.then((outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
    });

  return { promise, settle, cancel };
}

/**
 * Wait for one signal and report only what was observed. Callers that need to
 * tell a timeout from a cancellation arm the signal themselves.
 */
export async function waitForSignal<T>(
  check: () => T | null | undefined | false,
  emitters: EventSource | ReadonlyArray<EventSource>,
  eventNames: string | string[],
  options: SignalOptions,
): Promise<T | null> {
  const outcome = await armSignal(emitters, eventNames, check, options).promise;
  return outcome.kind === "signalled" ? outcome.value : null;
}
