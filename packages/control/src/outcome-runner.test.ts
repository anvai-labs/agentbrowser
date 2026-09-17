import { isPassingOutcome } from '@agentbrowser/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  TrustedEvidenceSourceRegistry,
  defineEvidenceSource,
  runVerifiedOutcome,
} from './outcome-runner.js';
import { TrustedVerifierRegistry, defineVerifier } from './verifier-registry.js';

const verifierDescriptor = (overrides: Record<string, unknown> = {}) => ({
  id: 'counter-equals',
  version: '1.0.0',
  inputSchemaId: 'counter-input-v1',
  evidenceSchemaId: 'counter-evidence-v1',
  requiredCapability: 'application.read.counter',
  evidenceSource: 'counter.snapshot',
  requiredLayer: 'G6' as const,
  budget: {
    maxReads: 3,
    timeoutMs: 100,
    pollIntervalMs: 5,
    cleanupTimeoutMs: 25,
    maxEvidenceRefs: 2,
  },
  redaction: 'reference_only' as const,
  unsupported: ['counter unavailable'],
  cleanup: 'not_needed' as const,
  ...overrides,
});

function verifierRegistry(predicate = (expected: number, actual: number) => expected === actual) {
  return new TrustedVerifierRegistry([
    defineVerifier({
      descriptor: verifierDescriptor(),
      parseInput: (value) => Number(value),
      parseEvidence: (value) => Number(value),
      predicate,
    }),
  ]);
}

function sourceRegistry(
  read: () =>
    | { status: 'pending' }
    | { status: 'ready'; evidence: number; evidenceRefIds: readonly string[] },
  cleanup?: (context: undefined, signal: AbortSignal) => void | Promise<void>
) {
  return new TrustedEvidenceSourceRegistry<undefined>([
    defineEvidenceSource({
      descriptor: { id: 'counter.snapshot', capability: 'application.read.counter' },
      read,
      ...(cleanup ? { cleanup } : {}),
    }),
  ]);
}

const base = () => ({
  verifierRegistry: verifierRegistry(),
  evidenceSources: sourceRegistry(() => ({
    status: 'ready' as const,
    evidence: 2,
    evidenceRefIds: ['ev_counter'],
  })),
  verifier: { id: 'counter-equals', version: '1.0.0', input: 2 },
  context: undefined,
  execute: vi.fn(async () => ({ ok: true })),
  assertAuthority: vi.fn(),
  testedSeam: 'application' as const,
});

describe('verified outcome runner', () => {
  it.each(['resolved', 'rejected', 'thenable'] as const)(
    'refuses an asynchronous input parser (%s) without dispatch or unhandled rejection',
    async (mode) => {
      const options = base();
      const predicate = vi.fn(() => true);
      const result = await runVerifiedOutcome({
        ...options,
        verifierRegistry: new TrustedVerifierRegistry([
          defineVerifier({
            descriptor: verifierDescriptor(),
            parseInput: () => {
              if (mode === 'resolved') return Promise.resolve(2);
              if (mode === 'rejected') return Promise.reject(new Error('PRIVATE-ASYNC'));
              return {
                // biome-ignore lint/suspicious/noThenProperty: exercise a misconfigured thenable parser result
                then: (_resolve: unknown, reject: (error: Error) => void) =>
                  reject(new Error('PRIVATE-THENABLE')),
              };
            },
            parseEvidence: Number,
            predicate,
          }),
        ]),
      });
      // Let Node deliver any unhandled rejection to the test runner.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(options.execute).not.toHaveBeenCalled();
      expect(predicate).not.toHaveBeenCalled();
      expect(result.outcome).toMatchObject({ availability: 'blocked', execution: 'not_started' });
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    }
  );

  it('rejects verifier input before dispatch or evidence reads and still settles cleanup', async () => {
    const options = base();
    const parseInput = vi.fn(() => {
      throw new Error('PRIVATE-INPUT');
    });
    const predicate = vi.fn(() => true);
    const read = vi.fn(() => ({ status: 'ready' as const, evidence: 2, evidenceRefIds: ['ev_1'] }));
    const cleanup = vi.fn();
    const result = await runVerifiedOutcome({
      ...options,
      verifierRegistry: new TrustedVerifierRegistry([
        defineVerifier({
          descriptor: verifierDescriptor(),
          parseInput,
          parseEvidence: (value) => value,
          predicate,
        }),
      ]),
      evidenceSources: sourceRegistry(read, cleanup),
    });
    expect(options.execute).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(predicate).not.toHaveBeenCalled();
    expect(parseInput).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(result).not.toHaveProperty('result');
    expect(result.outcome).toMatchObject({
      availability: 'blocked',
      execution: 'not_started',
      verification: { status: 'unknown', evidenceRefIds: [] },
      cleanup: 'complete',
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('prepares input once and retains the original expectation across execution', async () => {
    const input = { expected: 2 };
    const parseInput = vi.fn((value: unknown) => {
      const parsed = value as { expected: number };
      if (!Number.isSafeInteger(parsed.expected)) throw new Error('invalid input');
      return parsed;
    });
    const predicate = vi.fn(
      (expected: { expected: number }, actual: number) => expected.expected === actual
    );
    const options = base();
    const result = await runVerifiedOutcome({
      ...options,
      verifier: { ...options.verifier, input },
      verifierRegistry: new TrustedVerifierRegistry([
        defineVerifier({
          descriptor: verifierDescriptor(),
          parseInput,
          parseEvidence: Number,
          predicate,
        }),
      ]),
      execute: async () => {
        expect(parseInput).toHaveBeenCalledOnce();
        await Promise.resolve();
        input.expected = 999;
        return { ok: true };
      },
    });
    expect(result.outcome.execution).toBe('completed');
    expect(result.outcome.verification.status).toBe('passed');
    expect(parseInput).toHaveBeenCalledOnce();
    expect(predicate).toHaveBeenCalledOnce();
    expect(predicate).toHaveBeenCalledWith({ expected: 2 }, 2);
  });

  it.each(['authority', 'cancellation'] as const)(
    'rechecks %s after preparing input before any dispatch',
    async (revocation) => {
      const options = base();
      const controller = new AbortController();
      let authorized = true;
      const result = await runVerifiedOutcome({
        ...options,
        signal: controller.signal,
        assertAuthority: () => {
          if (!authorized) throw new Error('revoked');
        },
        verifierRegistry: new TrustedVerifierRegistry([
          defineVerifier({
            descriptor: verifierDescriptor(),
            parseInput: (input) => {
              if (revocation === 'authority') authorized = false;
              else controller.abort();
              return input;
            },
            parseEvidence: (value) => value,
            predicate: () => true,
          }),
        ]),
      });
      expect(options.execute).not.toHaveBeenCalled();
      expect(result.outcome).toMatchObject({ availability: 'blocked', execution: 'not_started' });
    }
  );

  it('refuses execution when a legacy verifier has no input preflight contract', async () => {
    const options = base();
    const evaluate = vi.fn(() => true);
    const result = await runVerifiedOutcome({
      ...options,
      verifierRegistry: new TrustedVerifierRegistry([
        { descriptor: verifierDescriptor(), evaluate },
      ]),
    });
    expect(options.execute).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(result.outcome).toMatchObject({ availability: 'unsupported', execution: 'not_started' });
  });

  it.each(['authority', 'cancellation'] as const)(
    'withholds verified output after %s changes during asynchronous cleanup',
    async (revocation) => {
      const options = base();
      const outer = new AbortController();
      let authorized = true;
      const cleanup = vi.fn(async () => {
        await Promise.resolve();
        if (revocation === 'authority') authorized = false;
        else outer.abort();
      });
      const result = await runVerifiedOutcome({
        ...options,
        signal: outer.signal,
        assertAuthority: () => {
          if (!authorized) throw new Error('PRIVATE-REVOKED');
        },
        cleanups: [cleanup],
      });
      expect(options.execute).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(isPassingOutcome(result.outcome)).toBe(false);
      expect(result).not.toHaveProperty('result');
      expect(result.outcome).toMatchObject({
        availability: 'blocked',
        execution: 'unknown',
        verification: { status: 'unknown', evidenceRefIds: [] },
        cleanup: 'complete',
      });
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    }
  );

  it('rechecks authority after verifier evaluation even without registered cleanup', async () => {
    let authorized = true;
    const options = base();
    const result = await runVerifiedOutcome({
      ...options,
      verifierRegistry: verifierRegistry(() => {
        authorized = false;
        return true;
      }),
      assertAuthority: () => {
        if (!authorized) throw new Error('revoked');
      },
    });
    expect(isPassingOutcome(result.outcome)).toBe(false);
    expect(result).not.toHaveProperty('result');
    expect(result.outcome.verification).toMatchObject({ status: 'unknown', evidenceRefIds: [] });
    expect(options.execute).toHaveBeenCalledOnce();
  });

  it('preflights an exact source and capability before executing', async () => {
    const options = base();
    const unavailable = new TrustedEvidenceSourceRegistry<undefined>([]);
    const missing = await runVerifiedOutcome({ ...options, evidenceSources: unavailable });
    expect(missing).not.toHaveProperty('result');
    expect(missing.outcome).toMatchObject({
      availability: 'unsupported',
      execution: 'not_started',
      verification: { status: 'unknown' },
    });
    expect(options.execute).not.toHaveBeenCalled();

    const wrongCapability = new TrustedEvidenceSourceRegistry<undefined>([
      defineEvidenceSource({
        descriptor: { id: 'counter.snapshot', capability: 'application.read.other' },
        read: () => ({ status: 'ready', evidence: 2, evidenceRefIds: ['ev_counter'] }),
      }),
    ]);
    await runVerifiedOutcome({ ...options, evidenceSources: wrongCapability });
    expect(options.execute).not.toHaveBeenCalled();
  });

  it('executes once, reads only after completion, and evaluates the first ready evidence once', async () => {
    const events: string[] = [];
    const predicate = vi.fn((expected: number, actual: number) => expected === actual);
    const read = vi
      .fn()
      .mockImplementationOnce(() => {
        events.push('read-1');
        return { status: 'pending' as const };
      })
      .mockImplementationOnce(() => {
        events.push('read-2');
        return { status: 'ready' as const, evidence: 2, evidenceRefIds: ['ev_counter'] };
      });
    const execute = vi.fn(async () => {
      events.push('execute');
      return { ok: true };
    });
    const result = await runVerifiedOutcome({
      ...base(),
      verifierRegistry: verifierRegistry(predicate),
      evidenceSources: sourceRegistry(read),
      execute,
    });
    expect(events).toEqual(['execute', 'read-1', 'read-2']);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(predicate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      result: { ok: true },
      outcome: {
        availability: 'available',
        execution: 'completed',
        verification: { status: 'passed', evidenceRefIds: ['ev_counter'] },
        cleanup: 'not_needed',
        testedSeam: 'application',
      },
    });
  });

  it('does not retry failed or unknown verification', async () => {
    for (const predicate of [
      vi.fn(() => false),
      vi.fn(() => {
        throw new Error('private');
      }),
    ]) {
      const read = vi.fn(() => ({
        status: 'ready' as const,
        evidence: 3,
        evidenceRefIds: ['ev_counter'],
      }));
      const result = await runVerifiedOutcome({
        ...base(),
        verifierRegistry: verifierRegistry(predicate),
        evidenceSources: sourceRegistry(read),
      });
      expect(read).toHaveBeenCalledTimes(1);
      expect(predicate).toHaveBeenCalledTimes(1);
      expect(result.outcome.verification.status).toBe(
        predicate.mock.results[0]?.type === 'throw' ? 'unknown' : 'failed'
      );
    }
  });

  it('bounds pending polling by maxReads and timeout', async () => {
    const read = vi.fn(() => ({ status: 'pending' as const }));
    const exhausted = await runVerifiedOutcome({
      ...base(),
      evidenceSources: sourceRegistry(read),
    });
    expect(read).toHaveBeenCalledTimes(3);
    expect(exhausted.outcome.verification.status).toBe('unknown');

    let lateResolve!: (value: {
      status: 'ready';
      evidence: number;
      evidenceRefIds: readonly string[];
    }) => void;
    let readAborted = false;
    const never = vi.fn(
      (_context: undefined, signal: AbortSignal) =>
        new Promise<{
          status: 'ready';
          evidence: number;
          evidenceRefIds: readonly string[];
        }>((resolve) => {
          lateResolve = resolve;
          signal.addEventListener('abort', () => {
            readAborted = true;
          });
        })
    );
    const cleanup = vi.fn();
    const started = Date.now();
    const timedOut = await runVerifiedOutcome({
      ...base(),
      evidenceSources: new TrustedEvidenceSourceRegistry([
        defineEvidenceSource({
          descriptor: { id: 'counter.snapshot', capability: 'application.read.counter' },
          read: never,
          cleanup,
        }),
      ]),
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(never).toHaveBeenCalledTimes(1);
    expect(readAborted).toBe(true);
    expect(timedOut.outcome.verification.status).toBe('unknown');
    expect(timedOut.outcome.cleanup).toBe('complete');
    lateResolve({ status: 'ready', evidence: 2, evidenceRefIds: ['ev_late'] });
    await Promise.resolve();
    expect(timedOut.outcome.verification.status).toBe('unknown');
    expect(cleanup).toHaveBeenCalledTimes(1);

    let monotonic = 0;
    const clockedRead = vi.fn(() => {
      monotonic += 60;
      return { status: 'pending' as const };
    });
    await runVerifiedOutcome({
      ...base(),
      evidenceSources: sourceRegistry(clockedRead),
      now: () => monotonic,
    });
    expect(clockedRead).toHaveBeenCalledTimes(2);

    monotonic = 0;
    const lateReady = await runVerifiedOutcome({
      ...base(),
      evidenceSources: sourceRegistry(() => {
        monotonic = 100;
        return { status: 'ready', evidence: 2, evidenceRefIds: ['ev_late_clock'] };
      }),
      now: () => monotonic,
    });
    expect(lateReady.outcome.verification.status).toBe('unknown');
  });

  it('yields between pending reads so timer-driven evidence can settle', async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 1);
    const read = vi.fn(() =>
      ready
        ? { status: 'ready' as const, evidence: 2, evidenceRefIds: ['ev_after_settle'] }
        : { status: 'pending' as const }
    );
    const result = await runVerifiedOutcome({
      ...base(),
      evidenceSources: sourceRegistry(read),
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.outcome.verification.status).toBe('passed');
  });

  it('asserts authority around execute and every read', async () => {
    const assertions: string[] = [];
    let phase = 'before-execute';
    const assertAuthority = vi.fn(() => assertions.push(phase));
    const execute = vi.fn(() => {
      phase = 'after-execute';
      return 1;
    });
    const read = vi.fn(() => {
      phase = 'after-read';
      return { status: 'ready' as const, evidence: 2, evidenceRefIds: ['ev_counter'] };
    });
    await runVerifiedOutcome({
      ...base(),
      execute,
      evidenceSources: sourceRegistry(read),
      assertAuthority,
    });
    expect(assertions).toEqual([
      'before-execute',
      'before-execute',
      'after-execute',
      'after-execute',
      'after-read',
      'after-read',
    ]);

    const blocked = base();
    blocked.assertAuthority.mockImplementation(() => {
      throw new Error('revoked');
    });
    const result = await runVerifiedOutcome(blocked);
    expect(blocked.execute).not.toHaveBeenCalled();
    expect(result.outcome).toMatchObject({ availability: 'blocked', execution: 'not_started' });

    const afterExecute = base();
    afterExecute.assertAuthority.mockImplementation(() => {
      if (afterExecute.execute.mock.calls.length) throw new Error('PRIVATE-REVOKED');
    });
    const fenced = await runVerifiedOutcome(afterExecute);
    expect(afterExecute.execute).toHaveBeenCalledTimes(1);
    expect(fenced).not.toHaveProperty('result');
    expect(JSON.stringify(fenced)).not.toContain('PRIVATE');
    expect(fenced.outcome.execution).toBe('unknown');
  });

  it('classifies thrown and in-band execution failures without reading', async () => {
    for (const dispatched of [false, true]) {
      const read = vi.fn(() => ({
        status: 'ready' as const,
        evidence: 2,
        evidenceRefIds: ['ev_counter'],
      }));
      const thrown = await runVerifiedOutcome({
        ...base(),
        evidenceSources: sourceRegistry(read),
        execute: vi.fn(() => {
          throw new Error('execute failed');
        }),
        didDispatch: () => dispatched,
      });
      expect(thrown.outcome.execution).toBe(dispatched ? 'unknown' : 'failed');
      expect(read).not.toHaveBeenCalled();

      const inBand = await runVerifiedOutcome({
        ...base(),
        evidenceSources: sourceRegistry(read),
        execute: vi.fn(() => ({ ok: false })),
        executionFailed: (value) => !value.ok,
        didDispatch: () => dispatched,
      });
      expect(inBand).toHaveProperty('result', { ok: false });
      expect(inBand.outcome.execution).toBe(dispatched ? 'unknown' : 'failed');
      expect(read).not.toHaveBeenCalled();
    }
  });

  it('registers source and caller cleanup before work and settles every cleanup', async () => {
    const calls: string[] = [];
    const sourceCleanup = vi.fn(() => {
      calls.push('source');
      throw new Error('sync cleanup failure');
    });
    const asyncCleanup = vi.fn(async () => {
      calls.push('caller');
      throw new Error('async cleanup failure');
    });
    const result = await runVerifiedOutcome({
      ...base(),
      evidenceSources: sourceRegistry(() => ({ status: 'pending' }), sourceCleanup),
      cleanups: [asyncCleanup],
      execute: vi.fn(() => {
        throw new Error('execute failure');
      }),
    });
    expect(calls.sort()).toEqual(['caller', 'source']);
    expect(sourceCleanup).toHaveBeenCalledTimes(1);
    expect(asyncCleanup).toHaveBeenCalledTimes(1);
    expect(result.outcome.cleanup).toBe('failed');
  });

  it('reports required cleanup with no registered cleanup as unknown', async () => {
    const requiredRegistry = new TrustedVerifierRegistry([
      defineVerifier({
        descriptor: verifierDescriptor({ cleanup: 'required' }),
        parseInput: Number,
        parseEvidence: Number,
        predicate: (expected, actual) => expected === actual,
      }),
    ]);
    const result = await runVerifiedOutcome({ ...base(), verifierRegistry: requiredRegistry });
    expect(result.outcome.cleanup).toBe('unknown');
    expect(result.outcome.verification.status).toBe('passed');
  });

  it('bounds non-cooperative cleanup, signals cancellation, and releases the caller', async () => {
    let aborted = false;
    const cleanup = vi.fn(
      (_context: undefined, signal: AbortSignal) =>
        new Promise<void>(() => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
        })
    );
    const started = Date.now();
    const result = await runVerifiedOutcome({
      ...base(),
      evidenceSources: sourceRegistry(
        () => ({ status: 'ready', evidence: 2, evidenceRefIds: ['ev_counter'] }),
        cleanup
      ),
    });
    expect(Date.now() - started).toBeLessThan(250);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(aborted).toBe(true);
    expect(result.outcome.cleanup).toBe('unknown');
  });

  it('attempts cleanup even when the operation signal is already aborted', async () => {
    const outer = new AbortController();
    outer.abort();
    const cleanup = vi.fn((_context: undefined, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
    });
    const result = await runVerifiedOutcome({
      ...base(),
      signal: outer.signal,
      evidenceSources: sourceRegistry(() => ({ status: 'pending' }), cleanup),
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(result.outcome).toMatchObject({
      availability: 'blocked',
      execution: 'not_started',
      cleanup: 'complete',
    });
  });
});

describe('trusted evidence source registry', () => {
  it('snapshots descriptors, captures callbacks, rejects duplicates, and has no registration API', async () => {
    const descriptor = { id: 'counter.snapshot', capability: 'application.read.counter' };
    const definition = {
      descriptor,
      read: () => ({ status: 'pending' as const }),
    };
    const source = defineEvidenceSource(definition);
    descriptor.id = 'changed';
    definition.read = () => ({ status: 'ready', evidence: 2, evidenceRefIds: ['ev'] });
    const registry = new TrustedEvidenceSourceRegistry([source]);
    expect(registry.supports('counter.snapshot', 'application.read.counter')).toBe(true);
    expect(
      await registry.read(
        'counter.snapshot',
        'application.read.counter',
        undefined,
        new AbortController().signal
      )
    ).toEqual({ status: 'pending' });
    expect('register' in registry).toBe(false);
    expect(() => new TrustedEvidenceSourceRegistry([source, source])).toThrow('duplicate');
    expect(() =>
      defineEvidenceSource({ ...definition, descriptor: { ...descriptor, script: 'bad' } as never })
    ).toThrow('Invalid evidence source descriptor');
  });
});
