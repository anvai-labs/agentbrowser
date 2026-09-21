import { ControlError } from '@agentbrowser/core';
import { expect, it, vi } from 'vitest';
import {
  ApplicationAuthority,
  type ApplicationResult,
  type ApplicationScope,
} from './application-authority.js';
import {
  type ApplicationReadAuthorizationRequest,
  defineApplicationReadEvidenceSource,
} from './application-evidence.js';
import { type EvidencePermission, TrustedEvidenceSourceRegistry } from './outcome-runner.js';
import { SessionAuthority } from './session-authority.js';

const descriptor = { id: 'draft', capability: 'draft.predicate' };
const verifier = { id: 'draft.matches', version: '1', input: { expected: 'pinned' } };
const permission = (): EvidencePermission => ({ generation: 1, currentGeneration: () => 1 });
function setup(
  policy: (
    request: ApplicationReadAuthorizationRequest
  ) => EvidencePermission | undefined = permission
) {
  const authority = new SessionAuthority();
  const principal = { actor: 'operator' as const, tenant: 'owner' };
  authority.register('session', 'owner', new AbortController().signal);
  let allowed = true;
  const execute = vi.fn(
    async (_scope: ApplicationScope): Promise<ApplicationResult> => ({
      status: 'read',
      value: { draft: 'pinned', version: 1 },
    })
  );
  const prepare = vi.fn((_input: unknown) => execute);
  const app = new ApplicationAuthority(authority, [
    {
      id: 'application',
      authorize: () => allowed,
      operations: { state: { mode: 'read', prepare }, change: { mode: 'write', prepare } },
      receipt: async () => undefined,
    },
  ]);
  app.bind('session', principal, { adapter: 'application', resource: 'resource' });
  const authorize = vi.fn(policy);
  const evidenceRefs = vi.fn((_value: unknown): readonly string[] => ['draft-ref']);
  const config = {
    descriptor: { ...descriptor },
    request: { operation: 'state', input: { draft: 'pinned' } },
    authorize,
    evidenceRefs,
  };
  const source = defineApplicationReadEvidenceSource(app, config);
  const registry = new TrustedEvidenceSourceRegistry([source]);
  const context = { sessionId: 'session', privateMetadata: 'PRIVATE' };
  const read = () => {
    const prepared = registry.prepareRead(
      'draft',
      'draft.predicate',
      context,
      'correlation',
      verifier
    );
    if (!prepared) throw new Error('Missing reader');
    return prepared;
  };
  const run = <T>(callback: () => T | Promise<T>) =>
    authority.run('session', principal, {}, callback);
  return {
    authority,
    principal,
    app,
    execute,
    prepare,
    authorize,
    evidenceRefs,
    config,
    source,
    registry,
    context,
    read,
    run,
    revoke: () => {
      allowed = false;
    },
    restore: () => {
      allowed = true;
    },
  };
}
it('requires authorization and correlation and gives policy frozen authority identity with operation', async () => {
  const f = setup();
  expect(f.source.descriptor).toEqual({
    ...descriptor,
    authorization: 'required',
    correlation: 'required',
  });
  await f.run(async () => {
    const read = f.read();
    expect(f.prepare).not.toHaveBeenCalled();
    const policy = f.authorize.mock.calls[0]?.[0];
    expect(policy).toEqual({
      source: f.source.descriptor,
      verifier,
      correlationId: 'correlation',
      identity: {
        admission: { actor: 'operator', tenant: 'owner' },
        adapter: 'application',
        resource: 'resource',
        sessionId: 'session',
        sessionIncarnation: f.authority.sessionIncarnation('session'),
        operation: 'state',
      },
    });
    if (!policy) throw new Error('Missing policy request');
    for (const part of [
      policy,
      policy.identity,
      policy.identity.admission,
      policy.verifier,
      policy.verifier.input,
      policy.source,
    ])
      expect(Object.isFrozen(part)).toBe(true);
    expect(policy).not.toHaveProperty('context');
    expect(policy).not.toHaveProperty('request');
    expect(await read(new AbortController().signal)).toEqual({
      status: 'ready',
      evidence: { draft: 'pinned', version: 1 },
      evidenceRefIds: ['draft-ref'],
    });
    expect(f.authority.didDispatchInScope('session')).toBe(false);
  });
});
it('pins config, policy, operation input and host method before later mutation', async () => {
  const f = setup();
  f.config.request.operation = 'change';
  f.config.request.input.draft = 'forged';
  f.config.descriptor.id = 'forged';
  f.config.authorize = vi.fn(() => undefined);
  f.config.evidenceRefs = vi.fn(() => ['forged']);
  f.app.prepareReadInScope = vi.fn(() => {
    throw new Error('PRIVATE');
  });
  await f.run(async () => {
    const read = f.read();
    f.context.sessionId = 'forged';
    f.context.privateMetadata = 'changed';
    expect(await read(new AbortController().signal)).toMatchObject({
      status: 'ready',
      evidenceRefIds: ['draft-ref'],
    });
  });
  expect(f.prepare).toHaveBeenCalledWith({ draft: 'pinned' });
  expect(f.app.prepareReadInScope).not.toHaveBeenCalled();
  expect(f.config.authorize).not.toHaveBeenCalled();
});
it.each([null, false, 0, ''])(
  'treats valid JSON %s as ready data rather than pending',
  async (value) => {
    const f = setup();
    f.execute.mockResolvedValue({ status: 'read', value });
    await f.run(async () =>
      expect(await f.read()(new AbortController().signal)).toMatchObject({
        status: 'ready',
        evidence: value,
      })
    );
  }
);
it('refuses undefined rather than giving application reads receipt-pending semantics', async () => {
  const f = setup();
  f.execute.mockResolvedValue({ status: 'read', value: undefined });
  await f.run(async () =>
    expect(f.read()(new AbortController().signal)).rejects.toThrow(
      'Application read evidence unavailable'
    )
  );
  expect(f.evidenceRefs).not.toHaveBeenCalled();
});
it.each([
  { operation: 'state' },
  { operation: 'state', input: undefined },
  { operation: 'state', input: Number.NaN },
  { operation: 'state', input: {}, operationId: 'forged' },
  { operation: 'state', input: 'PRIVATE'.repeat(20000) },
])('refuses malformed or unbounded factory requests before any policy callback', (request) => {
  const f = setup();
  expect(() =>
    defineApplicationReadEvidenceSource(f.app, {
      ...f.config,
      request: request as typeof f.config.request,
    })
  ).toThrow('Invalid application read evidence source');
  expect(f.authorize).not.toHaveBeenCalled();
  expect(f.prepare).not.toHaveBeenCalled();
});
it('fails closed on missing correlation, mismatched policy, and write operations', async () => {
  const f = setup(() => undefined);
  await f.run(() => {
    expect(
      f.registry.prepareRead('draft', 'draft.predicate', f.context, undefined, verifier)
    ).toBeUndefined();
    expect(f.read).toThrow('Evidence authorization unavailable');
    const source = defineApplicationReadEvidenceSource(f.app, {
      ...f.config,
      request: { operation: 'change', input: {} },
    });
    expect(() =>
      new TrustedEvidenceSourceRegistry([source]).prepareRead(
        'draft',
        'draft.predicate',
        f.context,
        'correlation',
        verifier
      )
    ).toThrow('Evidence authorization unavailable');
  });
  expect(f.prepare).not.toHaveBeenCalled();
});
it.each(['policy', 'refs'] as const)('never forwards private %s callback errors', async (stage) => {
  const f = setup(() => {
    if (stage === 'policy') throw new ControlError('CONTROL_REVOKED', 'PRIVATE');
    return permission();
  });
  if (stage === 'refs')
    f.evidenceRefs.mockImplementation(() => {
      throw new ControlError('CONTROL_REVOKED', 'PRIVATE');
    });
  const failure = await f
    .run(async () => f.read()(new AbortController().signal))
    .catch((error) => error);
  expect(failure.message).not.toContain('PRIVATE');
  expect(failure.cause).toBeUndefined();
});
it('keeps evidence immutable across the reference callback', async () => {
  const f = setup();
  f.evidenceRefs.mockImplementation((value) => {
    (value as { draft: string }).draft = 'forged';
    return ['draft-ref'];
  });
  await f.run(async () =>
    expect(f.read()(new AbortController().signal)).rejects.toThrow(
      'Application read evidence unavailable'
    )
  );
});
it('detaches reference arrays before they can change and fences reference proxy inspection', async () => {
  const f = setup();
  const refs = ['draft-ref'];
  f.evidenceRefs.mockReturnValue(refs);
  await f.run(async () => {
    const result = await f.read()(new AbortController().signal);
    refs[0] = 'changed';
    expect(result).toMatchObject({ evidenceRefIds: ['draft-ref'] });
  });
  const g = setup();
  g.evidenceRefs.mockReturnValue(
    new Proxy(['draft-ref'], {
      ownKeys: (target) => {
        g.revoke();
        return Reflect.ownKeys(target);
      },
    })
  );
  await g.run(async () => expect(g.read()(new AbortController().signal)).rejects.toThrow());
});
it('withholds async data after permission changes and never invokes reference callbacks', async () => {
  let generation = 1;
  const f = setup(() => ({ generation, currentGeneration: () => generation }));
  f.execute.mockImplementation(async () => {
    generation++;
    return { status: 'read', value: 'PRIVATE' };
  });
  await f.run(async () => expect(f.read()(new AbortController().signal)).rejects.toThrow());
  expect(f.evidenceRefs).not.toHaveBeenCalled();
});
it('does not revive observed permission denial after regrant', async () => {
  let generation = 1;
  const f = setup(() => ({ generation, currentGeneration: () => generation }));
  await f.run(async () => {
    const read = f.read();
    generation++;
    expect(read.assertAuthorized).toThrow();
    generation--;
    expect(read.assertAuthorized).toThrow();
    expect(() => read(new AbortController().signal)).toThrow();
  });
  expect(f.execute).not.toHaveBeenCalled();
});
it('refuses cancelled and escaped reads without application execution', async () => {
  const f = setup();
  const escaped = await f.run(async () => {
    const read = f.read();
    const signal = new AbortController();
    signal.abort();
    await expect(read(signal.signal)).rejects.toThrow();
    return read;
  });
  expect(() => escaped(new AbortController().signal)).toThrow();
  expect(f.execute).not.toHaveBeenCalled();
});

it.each(['callback', 'inspection'] as const)(
  'records authority revocation even when reference %s fails',
  async (stage) => {
    const f = setup();
    f.evidenceRefs.mockImplementation(() => {
      if (stage === 'callback') {
        f.revoke();
        throw new Error('PRIVATE');
      }
      return new Proxy(['draft-ref'], {
        ownKeys: () => {
          f.revoke();
          throw new Error('PRIVATE');
        },
      });
    });
    await f.run(async () => {
      const read = f.read();
      await expect(read(new AbortController().signal)).rejects.toThrow(
        'Application read evidence unavailable'
      );
      f.restore();
      expect(read.assertAuthorized).toThrow();
    });
  }
);
it('fences a context getter that replaces the textual session before reader preparation', async () => {
  const f = setup();
  Object.defineProperty(f.context, 'sessionId', {
    get: () => {
      f.authority.remove('session');
      f.authority.register('session', 'owner', new AbortController().signal);
      f.app.bind('session', f.principal, { adapter: 'application', resource: 'resource' });
      return 'session';
    },
  });
  await expect(f.run(async () => f.read())).rejects.toThrow();
  expect(f.authorize).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
});
it('rejects a policy operation mismatch before application I/O', async () => {
  const f = setup((request) =>
    request.identity.operation === 'another' ? permission() : undefined
  );
  await f.run(async () => expect(f.read).toThrow('Evidence authorization unavailable'));
  expect(f.execute).not.toHaveBeenCalled();
});
it.each([
  () => [7],
  () => Promise.reject(new Error('PRIVATE')),
  () =>
    Object.defineProperty(['draft-ref'], '0', {
      get: () => {
        throw new Error('PRIVATE');
      },
    }),
])('sanitizes malformed references without exposing private values', async (callback) => {
  const f = setup();
  f.evidenceRefs.mockImplementation(callback as (value: unknown) => readonly string[]);
  await f.run(async () =>
    expect(f.read()(new AbortController().signal)).rejects.toThrow(
      'Application read evidence unavailable'
    )
  );
});

it.each([
  [''],
  ['private value'],
  ['x'.repeat(129)],
  Array.from({ length: 33 }, (_, i) => `ref-${i}`),
])('rejects references outside the shared protocol contract: %j', async (...refs) => {
  const f = setup();
  f.evidenceRefs.mockReturnValue(refs);
  await f.run(async () =>
    expect(f.read()(new AbortController().signal)).rejects.toThrow(
      'Application read evidence unavailable'
    )
  );
});
it('accepts the shared maximum reference count and identifier length', async () => {
  const f = setup();
  const refs = Array.from({ length: 32 }, (_, i) => `${i}`.padEnd(128, 'a'));
  f.evidenceRefs.mockReturnValue(refs);
  await f.run(async () => {
    const result = await f.read()(new AbortController().signal);
    expect(result).toMatchObject({ status: 'ready', evidenceRefIds: refs });
    if (result.status === 'ready') expect(Object.isFrozen(result.evidenceRefIds)).toBe(true);
  });
});
