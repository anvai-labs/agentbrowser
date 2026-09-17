import { describe, expect, it } from 'vitest';
import { isPassingOutcome, parseOutcomeProjection } from './outcome.js';

const passing = () => ({
  availability: 'available',
  execution: 'completed',
  verification: {
    status: 'passed',
    verifier: { id: 'native-input', version: '1.0.0' },
    requiredLayer: 'G5',
    achievedLayer: 'G5',
    evidenceRefIds: ['ev_native_1'],
  },
  cleanup: 'complete',
  testedSeam: 'ui',
});

describe('canonical outcome projection', () => {
  it('derives a pass only from independently satisfied axes', () => {
    expect(isPassingOutcome(passing())).toBe(true);
    expect(isPassingOutcome({ ...passing(), cleanup: 'not_needed' })).toBe(true);

    for (const outcome of [
      { ...passing(), availability: 'blocked' },
      { ...passing(), availability: 'unsupported' },
      { ...passing(), execution: 'failed' },
      { ...passing(), execution: 'unknown' },
      { ...passing(), cleanup: 'pending' },
      { ...passing(), cleanup: 'failed' },
      { ...passing(), cleanup: 'unknown' },
      {
        ...passing(),
        verification: {
          status: 'not_requested',
          requiredLayer: 'G5',
          evidenceRefIds: [],
        },
      },
      {
        ...passing(),
        verification: {
          ...passing().verification,
          status: 'failed',
        },
      },
      {
        ...passing(),
        verification: {
          ...passing().verification,
          status: 'unknown',
        },
      },
    ]) {
      expect(isPassingOutcome(outcome)).toBe(false);
    }
  });

  it('rejects a claimed pass below the required grounding layer', () => {
    expect(() =>
      parseOutcomeProjection({
        ...passing(),
        verification: { ...passing().verification, requiredLayer: 'G6', achievedLayer: 'G4' },
      })
    ).toThrow('Invalid outcome projection');
  });

  it('rejects private, inherited, accessor-backed and cyclic report data', () => {
    for (const verification of [
      { ...passing().verification, actual: 'PRIVATE-ACTUAL' },
      Object.assign(Object.create({ actual: 'PRIVATE-INHERITED' }), passing().verification),
    ]) {
      expect(() => parseOutcomeProjection({ ...passing(), verification })).toThrow(
        'Invalid outcome projection'
      );
    }

    let reads = 0;
    const accessor = Object.defineProperty(passing(), 'cleanup', {
      enumerable: true,
      get: () => {
        reads++;
        return 'complete';
      },
    });
    expect(() => parseOutcomeProjection(accessor)).toThrow('Invalid outcome projection');
    expect(reads).toBe(0);

    const cycle = passing() as ReturnType<typeof passing> & { self?: unknown };
    cycle.self = cycle;
    expect(() => parseOutcomeProjection(cycle)).toThrow('Invalid outcome projection');
    try {
      parseOutcomeProjection({
        ...passing(),
        verification: { ...passing().verification, actual: 'PRIVATE-ACTUAL' },
      });
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE-ACTUAL');
    }
  });

  it('returns a detached bounded projection and rejects caller-supplied pass flags', () => {
    const input = passing();
    const parsed = parseOutcomeProjection(input);
    input.verification.evidenceRefIds[0] = 'PRIVATE-MUTATION';
    expect(parsed.verification.evidenceRefIds).toEqual(['ev_native_1']);
    expect(() => parseOutcomeProjection({ ...passing(), pass: true })).toThrow(
      'Invalid outcome projection'
    );
    expect(() =>
      parseOutcomeProjection({
        ...passing(),
        verification: {
          ...passing().verification,
          evidenceRefIds: Array.from({ length: 33 }, (_, index) => `ev_${index}`),
        },
      })
    ).toThrow('Invalid outcome projection');
  });
});
