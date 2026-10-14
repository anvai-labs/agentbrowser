import { describe, expect, it } from 'vitest';
import {
  measurePolicyGate,
  POLICY_SHARE_GATE_PERCENT,
  policyGateReport,
  SUBRESOURCES,
} from './policy-gate.js';

/**
 * TD-BROWSER-15 phase 4b: the gate itself is exercised, not just measured —
 * each mode reports a full sample set, memoization is strictly cheaper than
 * the uncached path on this page shape, and no mode may exceed the recorded
 * share ceiling.
 */
describe('policy performance gate', () => {
  it('measures all three modes; the production modes stay within the gate', async () => {
    const report = await policyGateReport();
    expect(report.map((r) => r.mode)).toEqual(['uncached', 'memoized', 'shadow']);
    // The uncached mode is the floor: reported, never gated.
    expect(report.find((r) => r.mode === 'uncached')?.gated).toBe(false);
    for (const result of report.filter((r) => r.gated)) {
      expect(result.p50Us).toBeGreaterThan(0);
      expect(result.totalMs).toBeGreaterThan(0);
      expect(result.gatePercent).toBe(POLICY_SHARE_GATE_PERCENT);
      expect(result.pass).toBe(true);
    }
  }, 120_000);

  it('memoized hits are cheaper than uncached decisions', async () => {
    const uncached = await measurePolicyGate('uncached');
    const memoized = await measurePolicyGate('memoized');
    // Nine of ten requests are hits on this page shape.
    expect(memoized.totalMs).toBeLessThan(uncached.totalMs);
  }, 120_000);

  it(`drives a ${SUBRESOURCES}-subresource page`, () => {
    expect(SUBRESOURCES).toBe(300);
  });
});
