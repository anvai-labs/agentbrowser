import { describe, expect, it, vi } from 'vitest';
import { TrustedVerifierRegistry, defineVerifier } from './verifier-registry.js';

const descriptor = () => ({
  id: 'counter-equals',
  version: '1.0.0',
  inputSchemaId: 'counter-expected-v1',
  evidenceSchemaId: 'counter-snapshot-v1',
  requiredCapability: 'application.read.counter',
  evidenceSource: 'fixture.counter.snapshot',
  requiredLayer: 'G6' as const,
  budget: { maxReads: 3, timeoutMs: 1000, maxEvidenceRefs: 2 },
  redaction: 'reference_only' as const,
  unsupported: ['counter unavailable'],
  cleanup: 'not_needed' as const,
});

const counterVerifier = (
  predicate = (expected: number, evidence: number) => expected === evidence
) =>
  defineVerifier({
    descriptor: descriptor(),
    parseInput: (value) => {
      if (!Number.isSafeInteger(value)) throw new Error('PRIVATE-INPUT');
      return Number(value);
    },
    parseEvidence: (value) => {
      if (!Number.isSafeInteger(value)) throw new Error('PRIVATE-EVIDENCE');
      return Number(value);
    },
    predicate,
  });

describe('trusted verifier registry', () => {
  it('evaluates a trusted predicate once and returns only evidence references', () => {
    const predicate = vi.fn((expected: number, evidence: number) => expected === evidence);
    const registry = new TrustedVerifierRegistry([counterVerifier(predicate)]);
    expect(registry.evaluate('counter-equals', '1.0.0', 2, 2, ['ev_counter_1'])).toEqual({
      status: 'passed',
      verifier: { id: 'counter-equals', version: '1.0.0' },
      requiredLayer: 'G6',
      achievedLayer: 'G6',
      evidenceRefIds: ['ev_counter_1'],
    });
    expect(predicate).toHaveBeenCalledTimes(1);
    expect(registry.evaluate('counter-equals', '1.0.0', 2, 3, ['ev_counter_2']).status).toBe(
      'failed'
    );
  });

  it('snapshots immutable descriptor data and rejects duplicates or executable fields', () => {
    const mutable = descriptor();
    const verifier = defineVerifier({
      descriptor: mutable,
      parseInput: (value) => value,
      parseEvidence: (value) => value,
      predicate: () => true,
    });
    mutable.id = 'changed';
    mutable.budget.maxReads = 99;
    mutable.unsupported[0] = 'changed';
    const registry = new TrustedVerifierRegistry([verifier]);
    expect(registry.describe('counter-equals', '1.0.0')).toEqual(descriptor());
    expect(() => new TrustedVerifierRegistry([verifier, verifier])).toThrow('duplicate');
    expect(() =>
      defineVerifier({
        descriptor: { ...descriptor(), script: 'PRIVATE-SCRIPT' } as never,
        parseInput: (value) => value,
        parseEvidence: (value) => value,
        predicate: () => true,
      })
    ).toThrow('Invalid verifier descriptor');
    expect('register' in registry).toBe(false);

    const raw = descriptor();
    const fromRaw = new TrustedVerifierRegistry([{ descriptor: raw, evaluate: () => true }]);
    raw.evidenceSource = 'changed';
    expect(fromRaw.describe('counter-equals', '1.0.0').evidenceSource).toBe(
      'fixture.counter.snapshot'
    );

    const definition = {
      descriptor: descriptor(),
      parseInput: (value: unknown) => value,
      parseEvidence: (value: unknown) => value,
      predicate: () => true,
    };
    const captured = defineVerifier(definition);
    definition.predicate = () => false;
    expect(
      new TrustedVerifierRegistry([captured]).evaluate('counter-equals', '1.0.0', 1, 1, ['ev_1'])
        .status
    ).toBe('passed');
  });

  it('turns parser, predicate and cancellation failures into unknown without retrying', () => {
    const predicate = vi.fn(() => {
      throw new Error('PRIVATE-PREDICATE');
    });
    const registry = new TrustedVerifierRegistry([counterVerifier(predicate)]);
    const thrown = registry.evaluate('counter-equals', '1.0.0', 1, 1, ['ev_1']);
    expect(thrown).toEqual({
      status: 'unknown',
      verifier: { id: 'counter-equals', version: '1.0.0' },
      requiredLayer: 'G6',
      evidenceRefIds: ['ev_1'],
    });
    expect(JSON.stringify(thrown)).not.toContain('PRIVATE');
    expect(predicate).toHaveBeenCalledTimes(1);

    const during = new AbortController();
    const cancels = new TrustedVerifierRegistry([
      counterVerifier(() => {
        during.abort();
        return true;
      }),
    ]);
    expect(cancels.evaluate('counter-equals', '1.0.0', 1, 1, ['ev_4'], during.signal).status).toBe(
      'unknown'
    );

    const wrongType = new TrustedVerifierRegistry([
      { descriptor: descriptor(), evaluate: () => 'true' as never },
    ]);
    expect(wrongType.evaluate('counter-equals', '1.0.0', 1, 1, ['ev_5']).status).toBe('unknown');

    let accessorReads = 0;
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        accessorReads++;
        return 1;
      },
    });
    const rawEvaluate = vi.fn(() => true);
    const rawRegistry = new TrustedVerifierRegistry([
      { descriptor: descriptor(), evaluate: rawEvaluate },
    ]);
    expect(rawRegistry.evaluate('counter-equals', '1.0.0', 1, accessor, ['ev_6']).status).toBe(
      'unknown'
    );
    expect(accessorReads).toBe(0);
    expect(rawEvaluate).not.toHaveBeenCalled();

    const abortsWhileSnapshotting = new AbortController();
    const abortingProxy = new Proxy(
      { value: 1 },
      {
        getPrototypeOf(target) {
          abortsWhileSnapshotting.abort();
          return Reflect.getPrototypeOf(target);
        },
      }
    );
    expect(
      rawRegistry.evaluate(
        'counter-equals',
        '1.0.0',
        abortingProxy,
        1,
        ['ev_abort'],
        abortsWhileSnapshotting.signal
      ).status
    ).toBe('unknown');
    expect(rawEvaluate).not.toHaveBeenCalled();

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(rawRegistry.evaluate('counter-equals', '1.0.0', cycle, 1, ['ev_7']).status).toBe(
      'unknown'
    );
    expect(rawEvaluate).not.toHaveBeenCalled();

    let deep: unknown = 1;
    for (let index = 0; index < 17; index++) deep = { next: deep };
    expect(rawRegistry.evaluate('counter-equals', '1.0.0', deep, 1, ['ev_8']).status).toBe(
      'unknown'
    );
    expect(
      rawRegistry.evaluate('counter-equals', '1.0.0', 'x'.repeat(65_537), 1, ['ev_9']).status
    ).toBe('unknown');
    expect(rawEvaluate).not.toHaveBeenCalled();

    const aborted = new AbortController();
    aborted.abort();
    expect(
      registry.evaluate('counter-equals', '1.0.0', 1, 1, ['ev_2'], aborted.signal).status
    ).toBe('unknown');
    expect(predicate).toHaveBeenCalledTimes(1);

    const parseFailure = registry.evaluate('counter-equals', '1.0.0', 'PRIVATE-INPUT', 1, ['ev_3']);
    expect(parseFailure.status).toBe('unknown');
    expect(JSON.stringify(parseFailure)).not.toContain('PRIVATE');
  });

  it('rejects malformed descriptors, unknown verifiers and unbounded evidence references', () => {
    for (const bad of [
      { ...descriptor(), id: '' },
      { ...descriptor(), requiredLayer: 'G7' },
      { ...descriptor(), redaction: 'raw' },
      { ...descriptor(), budget: { maxReads: 0, timeoutMs: 1000, maxEvidenceRefs: 2 } },
      { ...descriptor(), unsupported: Array(17).fill('case') },
    ]) {
      expect(() =>
        defineVerifier({
          descriptor: bad as never,
          parseInput: (value) => value,
          parseEvidence: (value) => value,
          predicate: () => true,
        })
      ).toThrow('Invalid verifier descriptor');
    }
    const registry = new TrustedVerifierRegistry([counterVerifier()]);
    expect(() => registry.describe('missing', '1.0.0')).toThrow('Unknown verifier');
    expect(() =>
      registry.evaluate('counter-equals', '1.0.0', 1, 1, ['ev_1', 'ev_2', 'ev_3'])
    ).toThrow('Invalid evidence references');
    expect(() => registry.evaluate('counter-equals', '1.0.0', 1, 1, ['ev_1', 'ev_1'])).toThrow(
      'Invalid evidence references'
    );
  });
});
