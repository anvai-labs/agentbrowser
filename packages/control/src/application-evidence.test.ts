import { describe, expect, it, vi } from 'vitest';
import { ApplicationAuthority, type ApplicationScope } from './application-authority.js';
import {
  type ApplicationReceiptAuthorizationRequest,
  defineApplicationReceiptEvidenceSource,
} from './application-evidence.js';
import {
  type EvidencePermission,
  type PreparedEvidenceRead,
  TrustedEvidenceSourceRegistry,
  runVerifiedOutcome,
} from './outcome-runner.js';
import { SessionAuthority } from './session-authority.js';
import { TrustedVerifierRegistry, defineVerifier } from './verifier-registry.js';

const descriptor = { id: 'receipt', capability: 'receipt.predicate' };
const verifier = { id: 'receipt.equals', version: '1', input: { expected: 2 } };
const permission = (): EvidencePermission => ({ generation: 1, currentGeneration: () => 1 });
function setup(
  policy: (
    request: ApplicationReceiptAuthorizationRequest
  ) => EvidencePermission | undefined = permission
) {
  const authority = new SessionAuthority();
  const operator = { actor: 'operator' as const, tenant: 'owner' };
  let adapterAllowed = true;
  const receipt = vi.fn(
    async (scope: ApplicationScope, id: string): Promise<unknown> => ({
      session: scope.sessionId,
      resource: scope.resource,
      id,
      value: 2,
    })
  );
  const app = new ApplicationAuthority(authority, [
    { id: 'counter', authorize: () => adapterAllowed, operations: {}, receipt },
  ]);
  const register = (id: string, resource: string) => {
    authority.register(id, 'owner', new AbortController().signal);
    app.bind(id, operator, { adapter: 'counter', resource });
    const review = authority.get(id)!.prepareResume();
    return authority.authenticate(authority.delegate(id, review.epoch, 'qa').token)!;
  };
  const principal = register('session-a', 'resource-a');
  const authorize = vi.fn(policy);
  const refs = vi.fn(() => ['receipt-ref']);
  const config = { descriptor, authorize, evidenceRefs: refs };
  const source = defineApplicationReceiptEvidenceSource(app, config);
  const registry = new TrustedEvidenceSourceRegistry([source]);
  const context = { sessionId: 'session-a', tenantId: 'forged-tenant' };
  const prepare = () =>
    registry.prepareRead('receipt', 'receipt.predicate', context, 'business-1', verifier)!;
  const run = <T>(fn: () => Promise<T>) => authority.run('session-a', principal, {}, fn);
  return {
    authority,
    app,
    register,
    principal,
    receipt,
    authorize,
    refs,
    config,
    registry,
    source,
    context,
    prepare,
    run,
    revokeAdapter: () => {
      adapterAllowed = false;
    },
  };
}

describe('application receipt evidence source descriptor', () => {
  it('stamps authorization and correlation as required (anti-weakening)', () => {
    // The receipt source is the one place where permission gating is
    // structural: if this stamp ever loosens, reads could be admitted
    // without an explicit policy decision. Guarded here so a weakening
    // edit fails before any deployment composes it.
    const authority = new SessionAuthority();
    const app = new ApplicationAuthority(authority, []);
    const source = defineApplicationReceiptEvidenceSource(app, {
      descriptor: { id: 'receipt', capability: 'receipt.predicate' },
      authorize: () => undefined,
    });
    expect(source.descriptor.authorization).toBe('required');
    expect(source.descriptor.correlation).toBe('required');
  });
});

describe('application receipt evidence permission', () => {
  it('uses frozen admitted identity and bounded raw input without giving policy a reader or context', async () => {
    const f = setup();
    await f.run(async () => {
      const read = f.prepare();
      expect(f.receipt).not.toHaveBeenCalled();
      const request = f.authorize.mock.calls[0]![0];
      expect(request).toEqual({
        source: { ...descriptor, authorization: 'required', correlation: 'required' },
        verifier,
        correlationId: 'business-1',
        identity: {
          admission: { actor: 'agent', tenant: 'owner', mode: 'qa' },
          adapter: 'counter',
          resource: 'resource-a',
          sessionId: 'session-a',
          sessionIncarnation: f.authority.sessionIncarnation('session-a'),
        },
      });
      for (const part of [
        request,
        request.source,
        request.verifier,
        request.verifier.input,
        request.identity,
        request.identity.admission,
      ])
        expect(Object.isFrozen(part)).toBe(true);
      expect(request).not.toHaveProperty('context');
      expect(request).not.toHaveProperty('read');
      expect(read).not.toHaveProperty('access');
      // The read is bound to the admitted application identity, not later metadata.
      f.context.sessionId = 'other';
      f.context.tenantId = 'other';
      await expect(read(new AbortController().signal)).resolves.toEqual({
        status: 'ready',
        evidence: { session: 'session-a', resource: 'resource-a', id: 'business-1', value: 2 },
        evidenceRefIds: ['receipt-ref'],
      });
      expect(f.authorize).toHaveBeenCalledOnce();
    });
  });

  it.each([
    'source',
    'verifier',
    'version',
    'input',
    'actor',
    'mode',
    'tenant',
    'resource',
    'incarnation',
    'adapter',
    'session',
    'correlation',
  ] as const)('denies a policy mismatch in %s before dispatch and receipt I/O', async (field) => {
    const expected: Record<string, string> = {
      source: 'receipt',
      verifier: 'receipt.equals',
      version: '1',
      input: '{"expected":2}',
      actor: 'agent',
      mode: 'qa',
      tenant: 'owner',
      resource: 'resource-a',
      incarnation: '',
      adapter: 'counter',
      session: 'session-a',
      correlation: 'business-1',
    };
    const f = setup((request) => {
      const actual = {
        source: request.source.id,
        verifier: request.verifier.id,
        version: request.verifier.version,
        input: JSON.stringify(request.verifier.input),
        ...request.identity.admission,
        resource: request.identity.resource,
        incarnation: request.identity.sessionIncarnation,
        adapter: request.identity.adapter,
        session: request.identity.sessionId,
        correlation: request.correlationId,
      };
      return Object.entries(expected).every(
        ([key, value]) => actual[key as keyof typeof actual] === value
      )
        ? permission()
        : undefined;
    });
    expected.incarnation = f.authority.sessionIncarnation('session-a');
    await f.run(async () => {
      f.prepare();
    }); // Positive control: the complete grant matches.
    expected[field] = 'different-authorized-domain';
    const execute = vi.fn();
    await f.run(async () => {
      expect(() => {
        f.prepare();
        execute();
      }).toThrow('Evidence authorization unavailable');
    });
    expect(execute).not.toHaveBeenCalled();
    expect(f.receipt).not.toHaveBeenCalled();
  });

  it.each(['missing', 'async', 'malformed', 'throw'] as const)(
    'fails closed on %s policy',
    async (kind) => {
      const f = setup(() => {
        if (kind === 'throw') throw new Error('private');
        if (kind === 'async') return Promise.reject(new Error('private')) as never;
        if (kind === 'malformed') return { generation: 1 } as never;
        return undefined;
      });
      await f.run(async () => expect(f.prepare).toThrow('Evidence authorization unavailable'));
      expect(f.receipt).not.toHaveBeenCalled();
    }
  );

  it('refuses outside admission, cross-session access and absent correlation', async () => {
    const f = setup();
    expect(f.prepare).toThrow();
    f.register('session-b', 'resource-b');
    await f.run(async () => {
      expect(
        f.registry.prepareRead('receipt', 'receipt.predicate', f.context, undefined, verifier)
      ).toBeUndefined();
      f.context.sessionId = 'session-b';
      expect(f.prepare).toThrow();
    });
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.receipt).not.toHaveBeenCalled();
  });

  it('keeps same-correlation reads separate across overlapping sessions', async () => {
    const f = setup();
    const principalB = f.register('session-b', 'resource-b');
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let readA!: PreparedEvidenceRead;
    const first = f.run(async () => {
      readA = f.prepare();
      await ready;
      return readA(new AbortController().signal);
    });
    const second = f.authority.run('session-b', principalB, {}, async () => {
      const read = f.registry.prepareRead(
        'receipt',
        'receipt.predicate',
        { sessionId: 'session-b' },
        'business-1',
        verifier
      )!;
      release();
      return read(new AbortController().signal);
    });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ evidence: { session: 'session-a', resource: 'resource-a' } });
    expect(b).toMatchObject({ evidence: { session: 'session-b', resource: 'resource-b' } });
    expect(f.receipt).toHaveBeenCalledTimes(2);
    expect(() => readA.assertAuthorized()).toThrow();
  });

  it('treats absent receipts as pending without generating evidence references', async () => {
    const f = setup();
    f.receipt.mockResolvedValue(undefined);
    await f.run(async () =>
      expect(await f.prepare()(new AbortController().signal)).toEqual({ status: 'pending' })
    );
    expect(f.refs).not.toHaveBeenCalled();
  });

  it.each(['takeover', 'adapter', 'policy'] as const)(
    'fences %s revocation before execution and at final publication',
    async (kind) => {
      let generation = 1;
      const f = setup(() => ({ generation, currentGeneration: () => generation }));
      const running = f.run(async () => {
        const read = f.prepare();
        if (kind === 'takeover') f.authority.takeover('session-a');
        else if (kind === 'adapter') f.revokeAdapter();
        else generation++;
        expect(read.assertAuthorized).toThrow();
        expect(() => read(new AbortController().signal)).toThrow();
      });
      if (kind === 'takeover') await expect(running).rejects.toThrow('revoked');
      else await running;
      expect(f.receipt).not.toHaveBeenCalled();
    }
  );

  it('withholds a late receipt when application authorization changes during I/O', async () => {
    const f = setup();
    f.receipt.mockImplementationOnce(async () => {
      f.revokeAdapter();
      return { private: 'receipt' };
    });
    await f.run(async () => expect(f.prepare()(new AbortController().signal)).rejects.toThrow());
    expect(f.refs).not.toHaveBeenCalled();
  });

  it.each(['policy', 'generation', 'cleanup'] as const)(
    'checks application authority after %s callbacks without another read',
    async (boundary) => {
      const f = setup(() => {
        if (boundary === 'policy') f.revokeAdapter();
        return {
          generation: 1,
          currentGeneration: () => {
            if (boundary === 'generation') f.revokeAdapter();
            return 1;
          },
        };
      });
      const execute = vi.fn(async () => ({ ok: true }));
      const registry = new TrustedVerifierRegistry([
        defineVerifier({
          descriptor: {
            id: verifier.id,
            version: verifier.version,
            inputSchemaId: 'expected',
            evidenceSchemaId: 'receipt',
            requiredCapability: descriptor.capability,
            evidenceSource: descriptor.id,
            requiredLayer: 'G4',
            budget: {
              maxReads: 1,
              timeoutMs: 100,
              pollIntervalMs: 1,
              cleanupTimeoutMs: 25,
              maxEvidenceRefs: 1,
            },
            redaction: 'reference_only',
            unsupported: [],
            cleanup: 'not_needed',
          },
          parseInput: () => 2,
          parseEvidence: (value) => (value as { value: number }).value,
          predicate: (a, b) => a === b,
        }),
      ]);
      await f.run(async () => {
        const result = await runVerifiedOutcome({
          verifierRegistry: registry,
          evidenceSources: f.registry,
          verifier,
          context: f.context,
          evidenceCorrelationId: 'business-1',
          execute,
          assertAuthority: () => undefined,
          didDispatch: () => true,
          testedSeam: 'ui',
          cleanups: [
            () => {
              if (boundary === 'cleanup') f.revokeAdapter();
            },
          ],
        });
        expect(execute).toHaveBeenCalledTimes(boundary === 'cleanup' ? 1 : 0);
        expect(f.receipt).toHaveBeenCalledTimes(boundary === 'cleanup' ? 1 : 0);
        expect(result.outcome).toMatchObject({
          availability: 'blocked',
          execution: boundary === 'cleanup' ? 'unknown' : 'not_started',
        });
        expect(result).not.toHaveProperty('result');
        expect(result.outcome.verification).toMatchObject({
          status: 'unknown',
          evidenceRefIds: [],
        });
      });
    }
  );

  it('withholds revoked receipt data from downstream reference callbacks', async () => {
    let generation = 1;
    const f = setup(() => ({ generation, currentGeneration: () => generation }));
    f.receipt.mockImplementationOnce(async () => {
      generation++;
      return { private: 'late receipt' };
    });
    await f.run(async () => expect(f.prepare()(new AbortController().signal)).rejects.toThrow());
    expect(f.refs).not.toHaveBeenCalled();
  });

  it('captures application preparation before mutable host methods can be replaced', async () => {
    const f = setup();
    f.app.prepareReceiptReadInScope = vi.fn(() => {
      throw new Error('replacement');
    });
    await f.run(async () =>
      expect(await f.prepare()(new AbortController().signal)).toMatchObject({ status: 'ready' })
    );
    expect(f.app.prepareReceiptReadInScope).not.toHaveBeenCalled();
  });

  it('captures policy and reference callbacks at composition', async () => {
    const f = setup();
    f.config.authorize = vi.fn(() => undefined);
    f.config.evidenceRefs = vi.fn(() => ['substituted']);
    await f.run(async () =>
      expect(await f.prepare()(new AbortController().signal)).toMatchObject({
        evidenceRefIds: ['receipt-ref'],
      })
    );
    expect(f.config.authorize).not.toHaveBeenCalled();
    expect(f.config.evidenceRefs).not.toHaveBeenCalled();
  });
});
