/**
 * Benchmark harness (TD-025)
 *
 * Measures service-operation latencies and evaluates them against the MVP
 * spec's targets. Measurements against FakeEngine isolate the service's
 * dispatch overhead - exactly what the "excluding site/network" targets
 * describe; the same harness measures a real engine when one is injected.
 */

export interface LatencyTarget {
  p50: number;
  p95: number;
}

/** Performance targets from the MVP spec, section 17.1 (milliseconds). */
export const TARGETS = {
  sessionCreateWarm: { p50: 350, p95: 1000 },
  observation: { p50: 150, p95: 500 },
  actionDispatch: { p50: 100, p95: Number.POSITIVE_INFINITY },
} as const satisfies Record<string, LatencyTarget>;

export type TargetName = keyof typeof TARGETS;

export interface BenchmarkResult {
  name: TargetName;
  samples: number[];
  pass: boolean;
  p50: number;
  p95: number;
  reason?: string;
}

/** Nearest-rank percentile of a sample set. */
export function percentile(samples: number[], q: number): number {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(q * sorted.length);
  const index = Math.max(0, Math.min(sorted.length - 1, rank - 1));
  return sorted[index] as number;
}

/** Evaluate one measured sample set against its named target. */
export function evaluateTarget(name: TargetName, samples: number[]): BenchmarkResult {
  const target = TARGETS[name];
  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);

  if (p50 > target.p50) {
    return {
      name,
      samples,
      pass: false,
      p50,
      p95,
      reason: `p50 ${p50}ms exceeds ${target.p50}ms`,
    };
  }
  if (p95 > target.p95) {
    return {
      name,
      samples,
      pass: false,
      p50,
      p95,
      reason: `p95 ${p95}ms exceeds ${target.p95}ms`,
    };
  }
  return { name, samples, pass: true, p50, p95 };
}

/** Render a human-readable report. */
export function summarize(results: BenchmarkResult[]): string {
  const lines = results.map((result) => {
    const mark = result.pass ? 'PASS' : 'FAIL';
    const stats = `p50=${result.p50}ms p95=${result.p95}ms n=${result.samples.length}`;
    const reason = result.reason !== undefined ? ` - ${result.reason}` : '';
    return `${mark} ${result.name} ${stats}${reason}`;
  });
  const failed = results.filter((r) => !r.pass).length;
  lines.push('');
  lines.push(`${results.length - failed}/${results.length} benchmarks within target`);
  return lines.join('\n');
}

/** Time one invocation of an operation, in milliseconds. */
export async function measure(operation: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await operation();
  return performance.now() - started;
}

/** Run an operation `iterations` times (after `warmup` unmeasured runs). */
export async function sample(
  operation: () => Promise<unknown>,
  iterations: number,
  warmup = 2
): Promise<number[]> {
  for (let i = 0; i < warmup; i++) {
    await operation();
  }
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    samples.push(await measure(operation));
  }
  return samples;
}
