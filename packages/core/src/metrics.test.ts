/**
 * TDD Tests for the metrics registry (TD-021)
 *
 * Prometheus-shaped counters, gauges and latency summaries, rendered in the
 * text exposition format. Metric and label names are sanitized to the
 * Prometheus character set.
 */

import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from './metrics';

describe('MetricsRegistry', () => {
  it('should count increments', () => {
    const metrics = new MetricsRegistry();
    metrics.incrementCounter('sessions_created_total');
    metrics.incrementCounter('sessions_created_total');

    const rendered = metrics.render();
    expect(rendered).toContain('sessions_created_total 2');
  });

  it('should count with labels', () => {
    const metrics = new MetricsRegistry();
    metrics.incrementCounter('operations_total', { operation: 'navigate', outcome: 'ok' });
    metrics.incrementCounter('operations_total', { operation: 'navigate', outcome: 'ok' });
    metrics.incrementCounter('operations_total', { operation: 'act', outcome: 'error' });

    const rendered = metrics.render();
    expect(rendered).toContain('operations_total{operation="navigate",outcome="ok"} 2');
    expect(rendered).toContain('operations_total{operation="act",outcome="error"} 1');
  });

  it('should track gauges', () => {
    const metrics = new MetricsRegistry();
    metrics.setGauge('sessions_active', 3);
    metrics.setGauge('sessions_active', 5);

    expect(metrics.render()).toContain('sessions_active 5');
  });

  it('should expose latency percentiles as a summary', () => {
    const metrics = new MetricsRegistry();
    // 1..100 ms: p50=50, p95=95, p99=99 (nearest-rank on sorted samples).
    for (let ms = 1; ms <= 100; ms++) {
      metrics.observe('operation_duration_ms', ms, { operation: 'navigate' });
    }

    const rendered = metrics.render();
    expect(rendered).toContain('operation_duration_ms{operation="navigate",quantile="0.5"} 50');
    expect(rendered).toContain('operation_duration_ms{operation="navigate",quantile="0.95"} 95');
    expect(rendered).toContain('operation_duration_ms{operation="navigate",quantile="0.99"} 99');
    expect(rendered).toContain('operation_duration_ms_count{operation="navigate"} 100');
  });

  it('should emit TYPE lines for each metric', () => {
    const metrics = new MetricsRegistry();
    metrics.incrementCounter('c_total');
    metrics.setGauge('g', 1);
    metrics.observe('d_ms', 1);

    const rendered = metrics.render();
    expect(rendered).toContain('# TYPE c_total counter');
    expect(rendered).toContain('# TYPE g gauge');
    expect(rendered).toContain('# TYPE d_ms summary');
  });

  it('should sanitize metric and label names to the Prometheus charset', () => {
    const metrics = new MetricsRegistry();
    metrics.incrementCounter('bad name!', { 'weird label?': 'also bad' });

    const rendered = metrics.render();
    expect(rendered).toContain('bad_name{weird_label="also bad"} 1');
  });

  it('should render empty when nothing was recorded', () => {
    expect(new MetricsRegistry().render()).toBe('');
  });

  it('should reset', () => {
    const metrics = new MetricsRegistry();
    metrics.incrementCounter('c_total');
    metrics.reset();

    expect(metrics.render()).toBe('');
  });
});
