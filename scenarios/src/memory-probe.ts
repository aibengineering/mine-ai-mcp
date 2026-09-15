/**
 * Process memory sampling shared across all Mine AI scenario clients.
 *
 * Runs inside the scenario process, tracking heap and RSS growth during
 * execution so memory footprint and leaks are recorded on completion.
 */
export interface MemoryStats {
  readonly startHeapMb: number;
  readonly peakHeapMb: number;
  readonly growthHeapMb: number;
  readonly finalHeapMb: number;
  readonly startRssMb: number;
  readonly peakRssMb: number;
  readonly growthRssMb: number;
  readonly samples: number;
}

export interface MemoryProbe {
  sample(): void;
  stats(): MemoryStats;
  summary(): string;
  close(): void;
}

const MEGABYTE = 1024 * 1024;
const toMb = (bytes: number): number => Math.round(bytes / MEGABYTE);

export function startMemoryProbe(intervalMs = 100): MemoryProbe {
  const baseline = process.memoryUsage();
  let peakHeap = baseline.heapUsed;
  let peakRss = baseline.rss;
  let samples = 1;

  const sample = (): void => {
    const usage = process.memoryUsage();
    peakHeap = Math.max(peakHeap, usage.heapUsed);
    peakRss = Math.max(peakRss, usage.rss);
    samples += 1;
  };

  const timer = setInterval(sample, intervalMs);
  timer.unref();

  const computeStats = (): MemoryStats => {
    sample();
    const final = process.memoryUsage();
    return {
      startHeapMb: toMb(baseline.heapUsed),
      peakHeapMb: toMb(peakHeap),
      growthHeapMb: toMb(peakHeap - baseline.heapUsed),
      finalHeapMb: toMb(final.heapUsed),
      startRssMb: toMb(baseline.rss),
      peakRssMb: toMb(peakRss),
      growthRssMb: toMb(peakRss - baseline.rss),
      samples,
    };
  };

  return {
    sample,
    stats: computeStats,
    summary() {
      const s = computeStats();
      return (
        `memory start heap ${s.startHeapMb} MB, peak heap ${s.peakHeapMb} MB, ` +
        `growth ${s.growthHeapMb} MB, final heap ${s.finalHeapMb} MB, ` +
        `start rss ${s.startRssMb} MB, peak rss ${s.peakRssMb} MB, ` +
        `rss growth ${s.growthRssMb} MB, samples ${s.samples}`
      );
    },
    close() {
      clearInterval(timer);
    },
  };
}

export function parseMemorySummary(detail?: string): MemoryStats | null {
  if (!detail) return null;
  const match = detail.match(
    /memory start heap (\d+) MB, peak heap (\d+) MB, growth (\d+) MB, final heap (\d+) MB, start rss (\d+) MB, peak rss (\d+) MB, rss growth (\d+) MB, samples (\d+)/,
  );
  if (!match) return null;
  return {
    startHeapMb: Number(match[1]),
    peakHeapMb: Number(match[2]),
    growthHeapMb: Number(match[3]),
    finalHeapMb: Number(match[4]),
    startRssMb: Number(match[5]),
    peakRssMb: Number(match[6]),
    growthRssMb: Number(match[7]),
    samples: Number(match[8]),
  };
}
