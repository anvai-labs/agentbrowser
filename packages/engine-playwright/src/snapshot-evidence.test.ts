import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyEmptyObservation } from './snapshot-evidence';

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
