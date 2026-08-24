/**
 * Metrics Registry (TD-021)
 *
 * Prometheus-shaped counters, gauges and latency summaries rendered in the
 * text exposition format. Metric and label names are sanitized to the
 * Prometheus character set; label values are escaped.
 */

type Labels = Record<string, string | number>;

interface Entry {
  name: string;
  labels: Labels;
}

/** Characters Prometheus allows in metric and label names. */
function sanitizeName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_:]/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
}

/** Escape a label value per the exposition format. */
function escapeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Render `{k="v",...}` in sorted key order. */
function renderLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) {
    return '';
  }
  return `{${keys.map((key) => `${sanitizeName(key)}="${escapeValue(String(labels[key]))}"`).join(',')}}`;
}

/** Stable identity for a labeled series. */
function seriesId(name: string, labels: Labels): string {
  return `${sanitizeName(name)}${renderLabels(labels)}`;
}

/** Nearest-rank percentile of a sorted sample. */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const rank = Math.ceil(q * sorted.length);
  const index = Math.max(0, Math.min(sorted.length - 1, rank - 1));
  return sorted[index] as number;
}

const QUANTILES = [0.5, 0.95, 0.99] as const;

export class MetricsRegistry {
  private readonly counters = new Map<string, { entry: Entry; value: number }>();
  private readonly gauges = new Map<string, { entry: Entry; value: number }>();
  private readonly samples = new Map<string, { entry: Entry; values: number[] }>();
  private readonly types = new Map<string, 'counter' | 'gauge' | 'summary'>();

  incrementCounter(name: string, labels: Labels = {}): void {
    this.declare(name, 'counter');
    const id = seriesId(name, labels);
    const current = this.counters.get(id);
    this.counters.set(id, {
      entry: { name: sanitizeName(name), labels },
      value: (current?.value ?? 0) + 1,
    });
  }

  setGauge(name: string, value: number, labels: Labels = {}): void {
    this.declare(name, 'gauge');
    this.gauges.set(seriesId(name, labels), {
      entry: { name: sanitizeName(name), labels },
      value,
    });
  }

  /** Record a latency sample (milliseconds) for summary percentiles. */
  observe(name: string, valueMs: number, labels: Labels = {}): void {
    this.declare(name, 'summary');
    const id = seriesId(name, labels);
    const current = this.samples.get(id);
    this.samples.set(id, {
      entry: { name: sanitizeName(name), labels },
      values: [...(current?.values ?? []), valueMs],
    });
  }

  /** Render the registry in the Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];

    for (const [name, type] of this.types) {
      lines.push(`# TYPE ${name} ${type}`);
    }

    for (const { entry, value } of this.counters.values()) {
      lines.push(`${entry.name}${renderLabels(entry.labels)} ${value}`);
    }
    for (const { entry, value } of this.gauges.values()) {
      lines.push(`${entry.name}${renderLabels(entry.labels)} ${value}`);
    }
    for (const { entry, values } of this.samples.values()) {
      const sorted = [...values].sort((a, b) => a - b);
      const labels = renderLabels(entry.labels);

      for (const q of QUANTILES) {
        const qLabels = labels
          ? `${labels.slice(0, -1)},quantile="${q}"}`
          : `{quantile="${q}"}`;
        lines.push(`${entry.name}${qLabels} ${percentile(sorted, q)}`);
      }
      lines.push(`${entry.name}_count${labels} ${sorted.length}`);
      lines.push(
        `${entry.name}_sum${labels} ${sorted.reduce((total, sample) => total + sample, 0)}`
      );
    }

    return lines.join('\n');
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.samples.clear();
    this.types.clear();
  }

  private declare(name: string, type: 'counter' | 'gauge' | 'summary'): void {
    const sanitized = sanitizeName(name);
    const existing = this.types.get(sanitized);
    if (existing === undefined) {
      this.types.set(sanitized, type);
    }
    // Re-declaring with a different type is a caller bug; the first
    // declaration wins so the exposition stays well-formed.
  }
}
