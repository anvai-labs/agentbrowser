/**
 * TDD Tests for the benchmark harness (TD-025)
 *
 * Latency statistics, target evaluation and report rendering. The harness is
 * engine-agnostic: CI measures service dispatch overhead against FakeEngine
 * (exactly the "excluding site/network" targets); real Chromium can be
 * measured locally with the same harness.
 */

import { describe, expect, it } from 'vitest';
import { TARGETS, evaluateTarget, percentile, summarize } from './harness';

describe('percentile', () => {
  it('should compute nearest-rank percentiles', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(samples, 0.5)).toBe(50);
    expect(percentile(samples, 0.95)).toBe(95);
    expect(percentile(samples, 0.99)).toBe(99);
  });

  it('should handle a single sample', () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.95)).toBe(42);
  });

  it('should handle empty samples', () => {
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe('TARGETS (from the MVP spec)', () => {
  it('should carry the spec latency targets in ms', () => {
    expect(TARGETS.sessionCreateWarm).toEqual({ p50: 350, p95: 1000 });
    expect(TARGETS.observation).toEqual({ p50: 150, p95: 500 });
    expect(TARGETS.actionDispatch).toEqual({ p50: 100, p95: Number.POSITIVE_INFINITY });
  });
});

describe('evaluateTarget', () => {
  it('should pass when p50 and p95 are within target', () => {
    const result = evaluateTarget('sessionCreateWarm', [10, 20, 30, 40, 500]);
    expect(result.pass).toBe(true);
  });

  it('should fail when p50 exceeds target', () => {
    const result = evaluateTarget('sessionCreateWarm', [400, 410, 420, 430, 440]);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('p50');
  });

  it('should fail when p95 exceeds target', () => {
    const result = evaluateTarget('sessionCreateWarm', [10, 20, 30, 40, 5000]);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('p95');
  });
});

describe('summarize', () => {
  it('should produce a readable report with pass/fail marks', () => {
    const report = summarize([
      { name: 'sessionCreateWarm', samples: [10, 20, 30], pass: true, p50: 20, p95: 30 },
      {
        name: 'observation',
        samples: [10, 20, 30],
        pass: false,
        p50: 20,
        p95: 30,
        reason: 'p95 30ms exceeds 1ms',
      },
    ]);

    expect(report).toContain('PASS sessionCreateWarm');
    expect(report).toContain('FAIL observation');
    expect(report).toContain('p95 30ms exceeds 1ms');
  });
});
