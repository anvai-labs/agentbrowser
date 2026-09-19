import { describe, expect, it, vi } from 'vitest';
import {
  type EvidenceAuthorizationRequest,
  type EvidencePermission,
  TrustedEvidenceSourceRegistry,
  defineEvidenceSource,
  runVerifiedOutcome,
} from './outcome-runner.js';
import { TrustedVerifierRegistry, defineVerifier } from './verifier-registry.js';

const descriptor = {
  id: 'receipt.equals',
  version: '1.0.0',
  inputSchemaId: 'expected',
  evidenceSchemaId: 'receipt',
  requiredCapability: 'receipt.predicate',
  evidenceSource: 'receipt',
  requiredLayer: 'G4' as const,
  budget: {
    maxReads: 2,
    timeoutMs: 100,
    pollIntervalMs: 1,
    cleanupTimeoutMs: 25,
    maxEvidenceRefs: 1,
  },
  redaction: 'reference_only' as const,
  unsupported: [],
  cleanup: 'not_needed' as const,
};
const source = {
  id: 'receipt',
  capability: 'receipt.predicate',
  authorization: 'required' as const,
  correlation: 'required' as const,
};
const context = Object.freeze({ actor: 'agent', mode: 'qa', tenant: 'owner', resource: 'profile' });
function fixture(
  authorize?: (
    request: EvidenceAuthorizationRequest<typeof context>
  ) => EvidencePermission | undefined
) {
  const read = vi.fn(async () => ({
    status: 'ready' as const,
    evidence: 2,
    evidenceRefIds: ['receipt-ref'],
  }));
  const cleanup = vi.fn();
  const execute = vi.fn(async () => ({ ok: true }));
  const sources = new TrustedEvidenceSourceRegistry([
    { descriptor: source, read, cleanup, ...(authorize ? { authorize } : {}) },
  ]);
  const options = {
    verifierRegistry: new TrustedVerifierRegistry([
      defineVerifier({
        descriptor,
        parseInput: Number,
        parseEvidence: Number,
        predicate: (a, b) => a === b,
      }),
    ]),
    evidenceSources: sources,
    verifier: { id: descriptor.id, version: descriptor.version, input: 2 },
    context,
    evidenceCorrelationId: 'business-1',
    execute,
    assertAuthority: vi.fn(),
    didDispatch: () => true,
    testedSeam: 'ui' as const,
  };
  return { options, sources, read, cleanup, execute };
}

describe('evidence permission preflight', () => {
  it('preserves execution and result provenance when policy replaces composition options', async () => {
    let generation = 1;
    const substitutedExecute = vi.fn(async () => ({ ok: true }));
    const extraCleanup = vi.fn();
    const f = fixture(() => {
      options.execute = substitutedExecute;
      options.didDispatch = () => false;
      options.context = Object.freeze({ ...context, resource: 'other' });
      options.testedSeam = 'application' as never;
      options.cleanups.length = 0;
      return { generation, currentGeneration: () => generation };
    });
    const options = { ...f.options, cleanups: [extraCleanup] };
    f.read.mockImplementation(async () => {
      generation++;
      return { status: 'ready', evidence: 2, evidenceRefIds: ['private'] };
    });
    const result = await runVerifiedOutcome(options);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(substitutedExecute).not.toHaveBeenCalled();
    expect(extraCleanup).toHaveBeenCalledOnce();
    expect(f.read).toHaveBeenCalledWith(context, expect.any(AbortSignal), 'business-1');
    expect(result.outcome).toMatchObject({
      availability: 'blocked',
      execution: 'unknown',
      testedSeam: 'ui',
    });
    expect(result).not.toHaveProperty('result');
  });

  it.each(['authority', 'signal'] as const)(
    'retains the host %s fence if policy replaces caller options',
    async (mode) => {
      let valid = true;
      const controller = new AbortController();
      const f = fixture(() => {
        valid = false;
        controller.abort();
        if (mode === 'authority') options.assertAuthority = vi.fn();
        else options.signal = new AbortController().signal;
        return { generation: 1, currentGeneration: () => 1 };
      });
      const options = { ...f.options, signal: controller.signal };
      if (mode === 'authority') {
        options.signal = new AbortController().signal;
        options.assertAuthority = vi.fn(() => {
          if (!valid) throw new Error('PRIVATE');
        });
      }
      const result = await runVerifiedOutcome(options);
      expect(result.outcome).toMatchObject({ availability: 'blocked', execution: 'not_started' });
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.read).not.toHaveBeenCalled();
    }
  );

  it('authorizes the exact source, predicate, input domain and trusted context once before dispatch', async () => {
    const order: string[] = [];
    const authorize = vi.fn((request: EvidenceAuthorizationRequest<typeof context>) => {
      order.push('authorize');
      expect(request).toEqual({
        source,
        verifier: { id: 'receipt.equals', version: '1.0.0', input: 2 },
        context,
        correlationId: 'business-1',
      });
      expect(Object.isFrozen(request)).toBe(true);
      expect(Object.isFrozen(request.verifier)).toBe(true);
      return { generation: 1, currentGeneration: () => 1 };
    });
    const f = fixture(authorize);
    f.execute.mockImplementation(async () => {
      order.push('execute');
      return { ok: true };
    });
    const result = await runVerifiedOutcome(f.options);
    expect(order).toEqual(['authorize', 'execute']);
    expect(authorize).toHaveBeenCalledOnce();
    expect(f.read).toHaveBeenCalledOnce();
    expect(result.outcome.verification.status).toBe('passed');
    expect(JSON.stringify(result)).not.toContain('business-1');
  });

  it.each([
    'missing',
    'denied',
    'throw',
    'async',
    'resolved-policy',
    'thenable-policy',
    'async-generation',
    'bad-generation',
    'missing-guard',
    'accessor-generation',
  ] as const)('blocks %s policy before dispatch and still settles cleanup', async (mode) => {
    const authorize = vi.fn(() => {
      if (mode === 'denied') return undefined;
      if (mode === 'throw') throw new Error('PRIVATE-POLICY');
      if (mode === 'async') return Promise.reject(new Error('PRIVATE-ASYNC')) as never;
      if (mode === 'resolved-policy')
        return Promise.resolve({ generation: 1, currentGeneration: () => 1 }) as never;
      if (mode === 'thenable-policy')
        return {
          // biome-ignore lint/suspicious/noThenProperty: exercise a misconfigured policy thenable
          then: (_resolve: unknown, reject: (error: Error) => void) =>
            reject(new Error('PRIVATE-THENABLE')),
        } as never;
      if (mode === 'accessor-generation')
        return Object.defineProperty({ currentGeneration: () => 1 }, 'generation', {
          get: () => {
            throw new Error('PRIVATE-GETTER');
          },
        }) as never;
      if (mode === 'missing-guard') return { generation: 1 } as never;
      return {
        generation: mode === 'bad-generation' ? Number.NaN : 1,
        currentGeneration: () =>
          mode === 'async-generation'
            ? (Promise.reject(new Error('PRIVATE-GENERATION')) as never)
            : 1,
      };
    });
    const f = fixture(mode === 'missing' ? undefined : authorize);
    const result = await runVerifiedOutcome(f.options);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.cleanup).toHaveBeenCalledOnce();
    expect(result.outcome).toMatchObject({
      availability: 'blocked',
      execution: 'not_started',
      cleanup: 'complete',
      verification: { status: 'unknown', evidenceRefIds: [] },
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it.each(['source', 'capability', 'correlation'] as const)(
    'does not authorize an unsupported %s',
    async (mode) => {
      const authorize = vi.fn(() => ({ generation: 1, currentGeneration: () => 1 }));
      const f = fixture(authorize);
      if (mode === 'correlation') f.options.evidenceCorrelationId = undefined as never;
      else
        f.options.verifierRegistry = new TrustedVerifierRegistry([
          defineVerifier({
            descriptor: {
              ...descriptor,
              ...(mode === 'source'
                ? { evidenceSource: 'other' }
                : { requiredCapability: 'other' }),
            },
            parseInput: Number,
            parseEvidence: Number,
            predicate: () => true,
          }),
        ]);
      const result = await runVerifiedOutcome(f.options);
      expect(result.outcome).toMatchObject({
        availability: 'unsupported',
        execution: 'not_started',
      });
      expect(authorize).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.read).not.toHaveBeenCalled();
    }
  );

  it.each(['execute', 'read', 'predicate', 'cleanup'] as const)(
    'withholds all output when permission changes during %s',
    async (boundary) => {
      let generation = 1;
      const f = fixture(() => ({ generation, currentGeneration: () => generation }));
      if (boundary === 'execute')
        f.execute.mockImplementation(async () => {
          generation++;
          return { ok: true };
        });
      if (boundary === 'read')
        f.read.mockImplementation(async () => {
          generation++;
          return { status: 'ready', evidence: 2, evidenceRefIds: ['PRIVATE-REF'] };
        });
      if (boundary === 'cleanup')
        f.cleanup.mockImplementation(() => {
          generation++;
        });
      if (boundary === 'predicate')
        f.options.verifierRegistry = new TrustedVerifierRegistry([
          defineVerifier({
            descriptor,
            parseInput: Number,
            parseEvidence: Number,
            predicate: () => {
              generation++;
              return true;
            },
          }),
        ]);
      const result = await runVerifiedOutcome(f.options);
      expect(result).not.toHaveProperty('result');
      expect(result.outcome).toMatchObject({
        availability: 'blocked',
        execution: 'unknown',
        cleanup: 'complete',
        verification: { status: 'unknown', evidenceRefIds: [] },
      });
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.cleanup).toHaveBeenCalledOnce();
      expect(f.read).toHaveBeenCalledTimes(boundary === 'execute' ? 0 : 1);
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    }
  );

  it('captures correlation before trusted input parsing and authorizes the original raw input', async () => {
    const input = { expected: 2 };
    const authorize = vi.fn((request: EvidenceAuthorizationRequest<typeof context>) => {
      expect(request.correlationId).toBe('business-1');
      expect(request.verifier.input).toEqual({ expected: 2 });
      expect(() => Object.assign(request.verifier.input as object, { expected: 99 })).toThrow();
      return { generation: 1, currentGeneration: () => 1 };
    });
    const f = fixture(authorize);
    const options = { ...f.options, verifier: { ...f.options.verifier, input } };
    options.verifierRegistry = new TrustedVerifierRegistry([
      defineVerifier({
        descriptor,
        parseInput: (value) => {
          options.evidenceCorrelationId = undefined as never;
          input.expected = 99;
          return value as typeof input;
        },
        parseEvidence: Number,
        predicate: (expected, evidence) => expected.expected === evidence,
      }),
    ]);
    const result = await runVerifiedOutcome(options);
    expect(result.outcome.verification.status).toBe('passed');
    expect(authorize).toHaveBeenCalledOnce();
    expect(f.read).toHaveBeenCalledWith(context, expect.any(AbortSignal), 'business-1');
  });

  it.each(['factory', 'guard'] as const)(
    'rechecks host authority after %s callbacks before dispatch',
    async (boundary) => {
      let valid = true;
      const f = fixture(() => {
        if (boundary === 'factory') valid = false;
        return {
          generation: 1,
          currentGeneration: () => {
            if (boundary === 'guard') valid = false;
            return 1;
          },
        };
      });
      f.options.assertAuthority.mockImplementation(() => {
        if (!valid) throw new Error('PRIVATE');
      });
      const result = await runVerifiedOutcome(f.options);
      expect(result.outcome).toMatchObject({ availability: 'blocked', execution: 'not_started' });
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.read).not.toHaveBeenCalled();
      expect(f.cleanup).toHaveBeenCalledOnce();
    }
  );

  it('withholds late prepared-read output even outside the outcome poll loop', async () => {
    let generation = 1;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const permission = { generation, currentGeneration: () => generation };
    const f = fixture(() => permission);
    f.read.mockImplementation(async () => {
      await pending;
      return { status: 'ready', evidence: 2, evidenceRefIds: ['PRIVATE'] };
    });
    const read = f.sources.prepareRead(
      source.id,
      source.capability,
      context,
      'business-1',
      f.options.verifier
    );
    // Replacing the returned callback cannot replace the captured policy check.
    permission.currentGeneration = () => 1;
    const output = read?.(new AbortController().signal);
    const rejected = expect(output).rejects.toThrow(/^Evidence authorization unavailable$/);
    generation++;
    release();
    await rejected;
    generation = 1;
    expect(() => read?.assertAuthorized()).toThrow();
  });

  it.each(['generation', 'throw'] as const)(
    'cannot revive a prepared reader after observed %s failure',
    async (mode) => {
      let generation = 1;
      let denied = false;
      const f = fixture(() => ({
        generation,
        currentGeneration: () => {
          if (denied) throw new Error('PRIVATE');
          return generation;
        },
      }));
      const reader = f.sources.prepareRead(
        source.id,
        source.capability,
        context,
        'business-1',
        f.options.verifier
      );
      expect(reader).toBeDefined();
      expect(Object.isFrozen(reader)).toBe(true);
      if (mode === 'generation') generation = 2;
      else denied = true;
      expect(() => reader?.assertAuthorized()).toThrow();
      generation = 1;
      denied = false;
      expect(() => reader?.assertAuthorized()).toThrow();
      expect(() => reader?.(new AbortController().signal)).toThrow();
      expect(f.read).not.toHaveBeenCalled();
    }
  );

  it('does not expose a protected direct read without a verifier request', () => {
    const authorize = vi.fn(() => ({ generation: 1, currentGeneration: () => 1 }));
    const f = fixture(authorize);
    expect(() =>
      f.sources.read(
        source.id,
        source.capability,
        context,
        new AbortController().signal,
        'business-1'
      )
    ).toThrow();
    expect(authorize).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });

  it('captures constructor-owned policy callbacks and rejects undeclared policy configuration', async () => {
    const authorize = vi.fn(() => ({ generation: 1, currentGeneration: () => 1 }));
    const definition = {
      descriptor: { ...source },
      authorize,
      read: () => ({ status: 'pending' as const }),
    };
    const registry = new TrustedEvidenceSourceRegistry([definition]);
    definition.authorize = vi.fn(() => {
      throw new Error('replaced');
    });
    const reader = registry.prepareRead(source.id, source.capability, context, 'business-1', {
      id: descriptor.id,
      version: descriptor.version,
      input: 2,
    });
    expect(await reader?.(new AbortController().signal)).toEqual({ status: 'pending' });
    expect(authorize).toHaveBeenCalledOnce();
    expect(definition.authorize).not.toHaveBeenCalled();
    expect(() =>
      defineEvidenceSource({
        descriptor: { id: 'unguarded', capability: 'read' },
        read: definition.read,
        authorize,
      })
    ).toThrow();
  });
});
