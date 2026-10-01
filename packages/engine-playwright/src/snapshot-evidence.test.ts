import { afterEach, describe, expect, it, vi } from 'vitest';
import { SnapshotBudget, classifyEmptyObservation, frameSliceMs } from './snapshot-evidence';

describe('classifyEmptyObservation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is false when the accessibility tree yielded any elements', () => {
    expect(
      classifyEmptyObservation({ elementCount: 3, bodyTextLength: 10_000, domNodeCount: 2_000 })
    ).toBe(false);
  });

  it('is false for a genuinely empty page (no elements, sparse DOM)', () => {
    expect(classifyEmptyObservation({ elementCount: 0, bodyTextLength: 4, domNodeCount: 3 })).toBe(
      false
    );
  });

  it('is true when no elements but the DOM body carries substantial text', () => {
    expect(
      classifyEmptyObservation({ elementCount: 0, bodyTextLength: 5_000, domNodeCount: 10 })
    ).toBe(true);
  });

  it('is true when no elements but the DOM has many nodes (rich but role-less)', () => {
    expect(
      classifyEmptyObservation({ elementCount: 0, bodyTextLength: 20, domNodeCount: 1_200 })
    ).toBe(true);
  });

  it('honours the AGENTBROWSER_EMPTY_DOM_MIN_TEXT override', () => {
    vi.stubEnv('AGENTBROWSER_EMPTY_DOM_MIN_TEXT', '50');
    expect(classifyEmptyObservation({ elementCount: 0, bodyTextLength: 60, domNodeCount: 1 })).toBe(
      true
    );
    vi.stubEnv('AGENTBROWSER_EMPTY_DOM_MIN_TEXT', '100000');
    expect(classifyEmptyObservation({ elementCount: 0, bodyTextLength: 60, domNodeCount: 1 })).toBe(
      false
    );
  });

  it('honours the AGENTBROWSER_EMPTY_DOM_MIN_NODES override', () => {
    vi.stubEnv('AGENTBROWSER_EMPTY_DOM_MIN_NODES', '5');
    expect(classifyEmptyObservation({ elementCount: 0, bodyTextLength: 0, domNodeCount: 6 })).toBe(
      true
    );
  });

  it('ignores non-numeric env overrides and falls back to defaults', () => {
    vi.stubEnv('AGENTBROWSER_EMPTY_DOM_MIN_TEXT', 'not-a-number');
    // default min text is 200; 150 nodes is the default node floor
    expect(
      classifyEmptyObservation({ elementCount: 0, bodyTextLength: 199, domNodeCount: 10 })
    ).toBe(false);
    expect(
      classifyEmptyObservation({ elementCount: 0, bodyTextLength: 200, domNodeCount: 10 })
    ).toBe(true);
  });
});

describe('SnapshotBudget frame slices', () => {
  it('exposes the remaining envelope and honors a per-capture timeout override', async () => {
    const budget = new SnapshotBudget(5_000);
    expect(budget.remaining()).toBeLessThanOrEqual(5_000);
    expect(budget.remaining()).toBeGreaterThan(4_000);

    const seen: number[] = [];
    const locator = {
      ariaSnapshot: async (options?: { timeout?: number }) => {
        seen.push(options?.timeout ?? -1);
        return '- button "x"';
      },
    } as never;
    const yaml = await budget.capture(locator, 1_234);
    expect(yaml).toBe('- button "x"');
    expect(seen[0]).toBe(1_234);
  });

  it('exhausted budgets report remaining zero and skip the capture entirely', async () => {
    const budget = new SnapshotBudget(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(budget.remaining()).toBe(0);
    expect(budget.exhausted).toBe(true);
    let probeCalls = 0;
    const locator = {
      ariaSnapshot: async () => {
        probeCalls += 1;
        return '- button';
      },
    } as never;
    expect(await budget.capture(locator, 500)).toBeUndefined();
    expect(probeCalls).toBe(0);
  });

  it('computes non-increasing per-frame slices that sum within the envelope', () => {
    let remaining = 4_000;
    const framesLeft = 4;
    let total = 0;
    for (let index = 0; index < 4; index += 1) {
      const slice = frameSliceMs(remaining, framesLeft - index);
      expect(slice).toBeGreaterThan(0);
      total += slice;
      remaining -= slice;
    }
    expect(total).toBeLessThanOrEqual(4_000);
    expect(frameSliceMs(0, 3)).toBe(0);
  });
});
