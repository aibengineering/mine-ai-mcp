import type { IncidentCaptureResult, IncidentReference, IncidentTrigger } from "../bot-data/incident-log.js";

// Twenty seconds covers the 12.6-second fatal run-12 leg. The byte budget
// bounds serialized history during entity/block bursts, not JavaScript heap.
export const INCIDENT_HISTORY_MS = 20_000;
export const INCIDENT_HISTORY_BYTES = 8 * 1024 * 1024;

export type SourceIdentity =
  | { readonly kind: "git"; readonly revision: string; readonly dirtyFingerprint: string }
  | { readonly kind: "unavailable"; readonly reason: string };
export interface IncidentProvenance {
  readonly source: SourceIdentity;
  readonly instanceId: string;
  readonly minecraft: { readonly host: string; readonly port: number };
}

interface Entry {
  readonly atMs: number;
  readonly bytes: Buffer;
}
export interface IncidentCapture {
  readonly trigger: IncidentTrigger;
  readonly requestId: number | null;
  readonly precedingRequestId: number | null;
  readonly contents: readonly Uint8Array[];
}

interface PendingCapture {
  readonly atMs: number;
  readonly capture: IncidentCapture;
  readonly settle: (result: IncidentCaptureResult) => void;
}

/** Bounded immutable history and one writer. It observes; it never controls the bot. */
export class IncidentRecorder {
  #entries: Entry[] = [];
  #bytes = 0;
  #omitted = { records: 0, firstAtMs: null as number | null, lastAtMs: null as number | null };
  #plan: Buffer | null = null;
  #writing: Promise<void> | null = null;
  #saving: IncidentCapture | null = null;
  #pending: PendingCapture | null = null;
  #coalesced = 0;
  #lastSavedDamageCapturedAt: number | null = null;
  #recordingMs = 0;
  #samples = 0;
  #writeFailures = 0;
  #lastWriteError: string | null = null;
  #maxRecordingMs = 0;

  constructor(
    private readonly identity: object,
    private readonly save: (capture: IncidentCapture) => Promise<IncidentReference>,
    private readonly published: (reference: IncidentReference) => void,
    private readonly budget = { durationMs: INCIDENT_HISTORY_MS, bytes: INCIDENT_HISTORY_BYTES },
    private readonly context: () => object = () => ({}),
  ) {}

  record(kind: string, facts: object, atMs = Date.now()): void {
    const started = performance.now();
    // Fine-grained events correlate with physics and decision snapshots by
    // timestamp. Repeating the full policy/ownership state on every route or
    // execution event consumed most of the byte window during combat.
    const context = ["execution", "navigation", "packet", "server_position_applied", "nearby_block_change", "survival_receipt", "combat_decision"].includes(kind)
      ? {}
      : this.context();
    const bytes = Buffer.from(`${JSON.stringify({ kind, atMs, ...facts, ...context })}\n`);
    this.#entries.push({ atMs, bytes });
    this.#bytes += bytes.length;
    this.#trim(atMs);
    const cost = performance.now() - started;
    this.#recordingMs += cost;
    this.#maxRecordingMs = Math.max(this.#maxRecordingMs, cost);
    this.#samples += 1;
  }

  retainPlan(plan: object): void {
    this.#plan = Buffer.from(`${JSON.stringify({ kind: "retained_plan", ...plan })}\n`);
  }

  #trim(now: number): void {
    let removed = 0;
    for (const entry of this.#entries) {
      const expired = entry.atMs < now - this.budget.durationMs;
      if (!expired && this.#bytes <= this.budget.bytes) break;
      this.#bytes -= entry.bytes.length;
      removed += 1;
      if (!expired) {
        this.#omitted.records += 1;
        this.#omitted.firstAtMs ??= entry.atMs;
        this.#omitted.lastAtMs = entry.atMs;
      }
    }
    if (removed) this.#entries.splice(0, removed);
  }

  capture(
    trigger: IncidentTrigger,
    requestId: number | null,
    precedingRequestId: number | null = null,
  ): Promise<IncidentCaptureResult> {
    const atMs = Date.now();
    this.#trim(atMs);
    if (this.#damageCheckpointRecent(trigger, atMs)) {
      this.#coalesced += 1;
      return Promise.resolve({ kind: "coalesced" });
    }
    if (this.#pending) {
      this.#coalesced += 1;
      this.#pending.settle({ kind: "coalesced" });
    }
    const header = Buffer.from(
      `${JSON.stringify({
        kind: "incident",
        version: 1,
        atMs,
        trigger,
        requestId,
        precedingRequestId,
        identity: this.identity,
        history: {
          ...this.budget,
          retainedBytes: this.#bytes,
          firstAtMs: this.#entries[0]?.atMs ?? null,
          byteBudgetOmissions: this.#omitted,
        },
        recorder: { samples: this.#samples, recordingMs: this.#recordingMs, coalescedCaptures: this.#coalesced },
      })}\n`,
    );
    const capture: IncidentCapture = {
      trigger,
      requestId,
      precedingRequestId,
      contents: [header, ...(this.#plan ? [this.#plan] : []), ...this.#entries.map((entry) => entry.bytes)],
    };
    // A slow filesystem cannot queue an unbounded number of 8-MiB snapshots.
    // Keep the latest pending snapshot; every trigger remains in its history.
    // At most one writing and one pending capture retain older buffer entries.
    const completion = new Promise<IncidentCaptureResult>((settle) => {
      this.#pending = { atMs, capture, settle };
    });
    if (!this.#writing) this.#writing = this.#drain();
    return completion;
  }

  async #drain(): Promise<void> {
    try {
      while (this.#pending) {
        const { atMs, capture, settle } = this.#pending;
        this.#pending = null;
        if (this.#damageCheckpointRecent(capture.trigger, atMs)) {
          this.#coalesced += 1;
          settle({ kind: "coalesced" });
          continue;
        }
        this.#saving = capture;
        try {
          const reference = await this.save(capture);
          if (reference.artifact.kind === "failed") {
            this.#writeFailures++;
            this.#lastWriteError = reference.artifact.error;
          } else if (capture.trigger === "non_entity_damage") {
            this.#lastSavedDamageCapturedAt = atMs;
          }
          this.published(reference);
          settle({ kind: "completed", reference });
        } catch (cause) {
          this.#writeFailures++;
          this.#lastWriteError = String(cause);
          settle({ kind: "failed", error: String(cause) });
        }
      }
    } finally {
      this.#writing = null;
      this.#saving = null;
    }
  }

  /**
   * Recurring damage checkpoints compare capture times across the existing
   * history window; slow persistence does not extend the interval. Every hit
   * stays in the ring, but does not get an independent artifact. Byte pressure
   * can shorten that history; this cadence does not promise lossless coverage.
   * Terminal and operator captures always bypass it, as do failed writes.
   */
  #damageCheckpointRecent(trigger: IncidentTrigger, atMs: number): boolean {
    return (
      trigger === "non_entity_damage" &&
      this.#lastSavedDamageCapturedAt !== null &&
      atMs - this.#lastSavedDamageCapturedAt < this.budget.durationMs
    );
  }

  async flush(): Promise<void> {
    await this.#writing;
  }
  status() {
    return {
      samples: this.#samples,
      recordingMs: this.#recordingMs,
      maxRecordingMs: this.#maxRecordingMs,
      retainedBytes: this.#bytes,
      pendingCaptures: Number(this.#saving !== null) + Number(this.#pending !== null),
      coalescedCaptures: this.#coalesced,
      writeFailures: this.#writeFailures,
      lastWriteError: this.#lastWriteError,
    };
  }
}
