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
  budget: {
    maxReads: 3,
    timeoutMs: 1000,
    pollIntervalMs: 10,
    cleanupTimeoutMs: 100,
    maxEvidenceRefs: 2,
  },
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
  it('refuses asynchronous preparation and evaluation callbacks without unhandled rejection', async () => {
    const reject = () => Promise.reject(new Error('PRIVATE-ASYNC'));
    const raw = new TrustedVerifierRegistry([
      { descriptor: descriptor(), prepare: reject as never, evaluate: reject as never },
    ]);
    expect(() => raw.prepare('counter-equals', '1.0.0', 2)).toThrow(
      'Invalid verifier input preparation'
    );
    expect(raw.evaluate('counter-equals', '1.0.0', 2, 2, ['ev_1']).status).toBe('unknown');
    for (const asyncCallback of ['evidence', 'predicate'] as const) {
      const registry = new TrustedVerifierRegistry([
        defineVerifier({
          descriptor: descriptor(),
          parseInput: Number,
          parseEvidence: asyncCallback === 'evidence' ? reject : Number,
          predicate: asyncCallback === 'predicate' ? (reject as never) : () => true,
        }),
      ]);
      const prepared = registry.prepare('counter-equals', '1.0.0', 2);
      expect(prepared?.evaluate(2, ['ev_1']).status).toBe('unknown');
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it('prepares once from a detached bounded input and captures the registered callback', () => {
    const parseInput = vi.fn((input: unknown) => input as { expected: number });
    const definition = defineVerifier({
      descriptor: descriptor(),
      parseInput,
      parseEvidence: Number,
      predicate: (input, evidence) => input.expected === evidence,
    });
    const mutable = { ...definition };
    const registry = new TrustedVerifierRegistry([mutable]);
    mutable.prepare = () => () => false;
    const input = { expected: 2 };
    const prepared = registry.prepare('counter-equals', '1.0.0', input);
    expect(Object.keys(prepared ?? {})).toEqual(['authorizationInput', 'evaluate']);
    expect(Object.isFrozen(prepared)).toBe(true);
    input.expected = 3;
    expect(prepared?.evaluate(2, ['ev_1']).status).toBe('passed');
    expect(prepared?.evaluate(3, ['ev_2']).status).toBe('failed');
    expect(parseInput).toHaveBeenCalledOnce();
    expect(parseInput.mock.calls[0]?.[0]).not.toBe(input);
  });

  it('captures deeply frozen raw authorization input apart from parser evaluation state', () => {
    const caller = {
      expected: { value: 2 },
      policy: { tenants: ['fixture-tenant'] },
    };
    let parserInput: { expected: { value: number }; policy: { tenants: string[] } } | undefined;
    const parseInput = vi.fn((input: unknown) => {
      parserInput = input as typeof parserInput;
      if (!parserInput) throw new Error('missing input');
      parserInput.expected.value = 3;
      parserInput.policy.tenants.push('parser-only');
      return parserInput.expected.value;
    });
    const registry = new TrustedVerifierRegistry([
      defineVerifier({
        descriptor: descriptor(),
        parseInput,
        parseEvidence: Number,
        predicate: (expected, evidence) => expected === evidence,
      }),
    ]);

    const prepared = registry.prepare('counter-equals', '1.0.0', caller);
    expect(prepared?.authorizationInput).toEqual({
      expected: { value: 2 },
      policy: { tenants: ['fixture-tenant'] },
    });
    expect(prepared?.authorizationInput).not.toBe(caller);
    expect((prepared?.authorizationInput as typeof caller).expected).not.toBe(caller.expected);
    expect(Object.isFrozen(prepared?.authorizationInput)).toBe(true);
    expect(Object.isFrozen((prepared?.authorizationInput as typeof caller).expected)).toBe(true);
    expect(Object.isFrozen((prepared?.authorizationInput as typeof caller).policy.tenants)).toBe(
      true
    );
    expect(parserInput).not.toBe(prepared?.authorizationInput);
    expect(parserInput).toEqual({
      expected: { value: 3 },
      policy: { tenants: ['fixture-tenant', 'parser-only'] },
    });
    expect(caller).toEqual({
      expected: { value: 2 },
      policy: { tenants: ['fixture-tenant'] },
    });

    caller.expected.value = 99;
    caller.policy.tenants.push('caller-only');
    expect(() => {
      (prepared?.authorizationInput as typeof caller).expected.value = 100;
    }).toThrow(TypeError);
    expect(prepared?.authorizationInput).toEqual({
      expected: { value: 2 },
      policy: { tenants: ['fixture-tenant'] },
    });
    expect(prepared?.evaluate(3, ['ev_1']).status).toBe('passed');
    expect(prepared?.evaluate(99, ['ev_2']).status).toBe('failed');
    expect(parseInput).toHaveBeenCalledOnce();
  });

  it('rejects unsafe input before invoking trusted preparation without leaking parser data', () => {
    const parseInput = vi.fn((input: unknown) => input);
    const registry = new TrustedVerifierRegistry([
      defineVerifier({
        descriptor: descriptor(),
        parseInput,
        parseEvidence: Number,
        predicate: () => true,
      }),
    ]);
    const getter = vi.fn(() => 1);
    const accessor = Object.defineProperty({}, 'expected', { enumerable: true, get: getter });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let deep: unknown = 1;
    for (let i = 0; i < 17; i++) deep = { next: deep };
    for (const input of [accessor, cycle, deep, 'x'.repeat(65_537)]) {
      expect(() => registry.prepare('counter-equals', '1.0.0', input)).toThrow(
        'Invalid verifier input preparation'
      );
    }
    expect(getter).not.toHaveBeenCalled();
    expect(parseInput).not.toHaveBeenCalled();
    const strict = new TrustedVerifierRegistry([counterVerifier()]);
    expect(() => strict.prepare('counter-equals', '1.0.0', 'PRIVATE')).toThrow(
      /^Invalid verifier input preparation$/
    );
  });

  it('keeps prepared evidence validation, cancellation and private-safe projection conservative', () => {
    const predicate = vi.fn((input: number, evidence: number) => input === evidence);
    const registry = new TrustedVerifierRegistry([counterVerifier(predicate)]);
    const prepared = registry.prepare('counter-equals', '1.0.0', 2);
    expect(prepared?.evaluate('PRIVATE', ['ev_1'])).toMatchObject({
      status: 'unknown',
      evidenceRefIds: ['ev_1'],
    });
    const controller = new AbortController();
    controller.abort();
    expect(prepared?.evaluate(2, ['ev_2'], controller.signal).status).toBe('unknown');
    expect(() => prepared?.evaluate(2, ['ev_1', 'ev_1'])).toThrow('Invalid evidence references');
    expect(predicate).not.toHaveBeenCalled();
    predicate.mockImplementation(() => {
      throw new Error('PRIVATE-PREDICATE');
    });
    const failed = prepared?.evaluate(2, ['ev_3']);
    expect(failed).toMatchObject({ status: 'unknown', evidenceRefIds: ['ev_3'] });
    expect(JSON.stringify(failed)).not.toContain('PRIVATE');
    expect(predicate).toHaveBeenCalledOnce();
  });

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
