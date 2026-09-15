import { channel } from "node:diagnostics_channel";
import { randomUUID } from "node:crypto";

/** Matches navigation's 8 ms search slices, leaving room in a 50 ms physics tick. */
export const EXECUTION_SLICE_MS = 8;
export const executionChannel = channel("mine-ai.execution");

export interface ExecutionOwner {
  readonly bot: string;
  readonly operation: string;
  readonly targetId: number | null;
  /** Durable action request identity, when this scope owns an action invocation. */
  readonly requestId?: number | null;
  readonly actionId?: string;
}

type ExecutionTransition =
  | { readonly kind: "entered" | "returned" | "closed" | "progress"; readonly reason: string | null }
  | {
      readonly kind: "yielded";
      readonly iterations: number;
      readonly uninterruptedMs: number;
      readonly firstYield: boolean;
    };

export type ExecutionEvent = ExecutionTransition & {
  readonly scopeId: string;
  readonly owner: ExecutionOwner;
  readonly at: number;
  readonly sequence: number;
  readonly phase: string;
  readonly activePhase: string | null;
};

/**
 * Budget uninterrupted execution, never the duration or progress of an action.
 * A setImmediate sentinel distinguishes real event-loop turns from resolved
 * promises. It is scheduled only while this scope has work, not in a busy poll.
 */
export class ExecutionScope implements Disposable {
  readonly #id = randomUUID();
  #sequence = 0;
  #phase: string | null = null;
  #yielded = false;
  #slice: { began: number; iterations: number; turn: ReturnType<typeof setImmediate> } | null = null;

  constructor(readonly owner: ExecutionOwner) {}

  /** An awaited subsystem reports its own current work without ending the scope. */
  progress(phase: string, reason: string): void {
    this.#phase = phase;
    this.#publish({ kind: "progress", reason });
  }

  #publish(event: ExecutionTransition, phase = this.#phase ?? "decide"): void {
    executionChannel.publish({
      ...event,
      scopeId: this.#id,
      owner: this.owner,
      at: Date.now(),
      sequence: ++this.#sequence,
      phase,
      activePhase: this.#phase,
    } satisfies ExecutionEvent);
  }

  async run<T>(phase: string, effect: () => Promise<T>, reason: string | null = null): Promise<T> {
    const previous = this.#phase;
    this.#phase = phase;
    this.#publish({ kind: "entered", reason });
    try {
      return await effect();
    } finally {
      this.#phase = previous;
      this.#publish({ kind: "returned", reason }, phase);
    }
  }

  /** Attribute synchronous callbacks before they can block the runtime's timer. */
  runSync<T>(phase: string, effect: () => T): T {
    const previous = this.#phase;
    this.#phase = phase;
    this.#publish({ kind: "entered", reason: null });
    try {
      return effect();
    } finally {
      this.#phase = previous;
      this.#publish({ kind: "returned", reason: null }, phase);
    }
  }

  async checkpoint(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.#slice) {
      const turn = setImmediate(() => {
        this.#slice = null;
      });
      this.#slice = { began: performance.now(), iterations: 0, turn };
    }
    const slice = this.#slice;
    slice.iterations++;
    const uninterruptedMs = performance.now() - slice.began;
    if (uninterruptedMs < EXECUTION_SLICE_MS) return;
    this.#publish({ kind: "yielded", iterations: slice.iterations, uninterruptedMs, firstYield: !this.#yielded });
    this.#yielded = true;
    await new Promise<void>((resolve) => setImmediate(resolve));
    signal?.throwIfAborted();
  }

  [Symbol.dispose](): void {
    if (this.#slice) clearImmediate(this.#slice.turn);
    this.#slice = null;
    this.#phase = null;
    this.#publish({ kind: "closed", reason: null });
  }
}

/** The channel is package-owned; subscribers receive only ExecutionScope events. */
export function observeExecution(listener: (event: ExecutionEvent) => void): () => void {
  const receive = (message: unknown) => listener(message as ExecutionEvent);
  executionChannel.subscribe(receive);
  return () => executionChannel.unsubscribe(receive);
}
