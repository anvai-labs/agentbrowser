import { afterEach, expect, it, vi } from 'vitest';
import {
  ApplicationAuthority,
  type ApplicationConsentPolicy,
  defineApplicationOperation,
} from './application-authority.js';
import {
  SessionAuthority,
  type SessionPublication,
  type SessionPublicationContext,
} from './session-authority.js';

const operator = { actor: 'operator' as const, tenant: 'owner' };
const command = { operation: 'write', input: null, operationId: 'write-1', expectedVersion: 0 };
const owners: SessionAuthority[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.remove('s');
});
function fixture(consentPolicy?: ApplicationConsentPolicy) {
  const authority = new SessionAuthority();
  owners.push(authority);
  authority.register('s', 'owner', new AbortController().signal);
  const authorize = vi.fn(() => true);
  const effect = vi.fn(async () => ({ status: 'committed' as const, value: 42 }));
  const receipt = vi.fn(async () => ({ value: 42 }));
  const app = new ApplicationAuthority(
    authority,
    [
      {
        id: 'app',
        authorize,
        receipt,
        operations: {
          write: defineApplicationOperation({ mode: 'write', parse: () => null, execute: effect }),
          submit: defineApplicationOperation({
            mode: 'write',
            review: 'operator-submit',
            parse: () => null,
            execute: effect,
          }),
        },
      },
    ],
    consentPolicy ? { consentPolicy } : {}
  );
  const bind = () => app.bind('s', operator, { adapter: 'app', resource: 'account' });
  bind();
  const invoke = (
    kind: 'discover' | 'execute' | 'receipt',
    publication: SessionPublication<unknown>
  ) => {
    if (kind === 'discover') return app.discover('s', operator, publication);
    if (kind === 'receipt') return app.lookupReceipt('s', operator, 'receipt-1', publication);
    return app.execute('s', operator, command, publication);
  };
  return { authority, app, authorize, effect, receipt, bind, invoke };
}

for (const kind of ['discover', 'execute', 'receipt'] as const) {
  it(`${kind} publishes under application authority after execution closes`, async () => {
    const f = fixture();
    let retained!: () => void;
    const publish = vi.fn((_value, context: SessionPublicationContext) => {
      retained = context.assertCurrent;
      expect(Object.isFrozen(context)).toBe(true);
      expect(context.status).toBe('completed');
      expect(f.authority.get('s')?.view().busy).toBe(true);
      context.assertCurrent();
      expect(() => f.authority.assert('s')).toThrow();
      expect(() => f.app.prepareReceiptReadInScope('s')).toThrow();
    });
    await f.invoke(kind, { timeoutMs: 1000, publish });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(retained).toThrow();
    expect(f.authority.get('s')?.view().busy).toBe(false);
  });

  it(`${kind} suppresses delayed output on permission revocation and latches denial`, async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const sent = vi.fn();
    const outcome = f
      .invoke(kind, {
        timeoutMs: 1000,
        publish: async (_value, context) => {
          entered.resolve();
          await release.promise;
          expect(context.assertCurrent).toThrow();
          f.authorize.mockReturnValue(true);
          context.assertCurrent();
          sent();
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    // Baseline without publication resolves early; fail cleanly without a hanging test.
    await Promise.race([entered.promise, outcome]);
    f.authorize.mockReturnValue(false);
    release.resolve();
    expect(await outcome).toMatchObject({ code: 'CONTROL_REVOKED' });
    expect(sent).not.toHaveBeenCalled();
    if (kind === 'execute') {
      expect(f.effect).toHaveBeenCalledTimes(1);
      expect(f.authority.get('s')?.operation('write-1')?.status).toBe('completed');
    }
  });

  it(`${kind} rechecks application permission even if the publisher omits its final guard`, async () => {
    const f = fixture();
    await expect(
      f.invoke(kind, {
        timeoutMs: 1000,
        publish: () => {
          f.authorize.mockReturnValue(false);
        },
      })
    ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
    expect(f.authority.get('s')?.view().busy).toBe(false);
  });

  it(`${kind} validates original publisher options before any application effect`, async () => {
    const f = fixture();
    const calls = f.authorize.mock.calls.length;
    await expect(
      f.invoke(kind, { timeoutMs: 1000, publish: null } as unknown as SessionPublication<unknown>)
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(f.authorize).toHaveBeenCalledTimes(calls);
    expect(f.effect).not.toHaveBeenCalled();
    expect(f.receipt).not.toHaveBeenCalled();
    expect(f.authority.get('s')?.operation('write-1')).toBeUndefined();
  });
}

it('pins the original publisher callback before execution can mutate its options', async () => {
  const f = fixture();
  const original = vi.fn();
  const replacement = vi.fn();
  const publication = { timeoutMs: 1000, publish: original };
  f.effect.mockImplementation(async () => {
    publication.publish = replacement;
    publication.timeoutMs = 0;
    return { status: 'committed', value: 42 };
  });
  await f.app.execute('s', operator, command, publication);
  expect(original).toHaveBeenCalledTimes(1);
  expect(replacement).not.toHaveBeenCalled();
});

it('publishes unbound discovery as null without an adapter or fabricated application scope', async () => {
  const f = fixture();
  f.app.unbind('s', operator);
  f.authorize.mockClear();
  const publish = vi.fn((value, context: SessionPublicationContext) => {
    expect(value).toBeNull();
    context.assertCurrent();
  });
  expect(await f.app.discover('s', operator, { timeoutMs: 1000, publish })).toBeNull();
  expect(publish).toHaveBeenCalledTimes(1);
  expect(f.authorize).not.toHaveBeenCalled();
});

it('suppresses stale null discovery when its session is replaced with a bound one', async () => {
  const f = fixture();
  f.app.unbind('s', operator);
  const sent = vi.fn();
  await expect(
    f.app.discover('s', operator, {
      timeoutMs: 1000,
      publish: (_value, context) => {
        f.authority.remove('s');
        f.authority.register('s', 'owner', new AbortController().signal);
        f.bind();
        context.assertCurrent();
        sent();
      },
    })
  ).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
  expect(sent).not.toHaveBeenCalled();
});

it('rechecks pins after an authorization callback replaces the owner and preserves its new ticket', async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const nextRelease = Promise.withResolvers<void>();
  let next: Promise<unknown> | undefined;
  let replace = false;
  f.authorize.mockImplementation(() => {
    if (replace) {
      replace = false;
      f.authority.remove('s');
      f.authority.register('s', 'owner', new AbortController().signal);
      f.bind();
      next = f.authority.run('s', operator, {}, () => nextRelease.promise);
    }
    return true;
  });
  const sent = vi.fn();
  const outcome = f.app
    .execute('s', operator, command, {
      timeoutMs: 1000,
      publish: async (_value, context) => {
        entered.resolve();
        await release.promise;
        context.assertCurrent();
        sent();
      },
    })
    .then(
      () => undefined,
      (error: unknown) => error
    );
  await Promise.race([entered.promise, outcome]);
  replace = true;
  release.resolve();
  try {
    expect(await outcome).toMatchObject({ code: 'CONTROL_REVOKED' });
    expect(sent).not.toHaveBeenCalled();
    expect(f.authority.get('s')?.view().busy).toBe(true);
  } finally {
    nextRelease.resolve();
    await next;
  }
});

it('never re-consumes submission consent during publication or replay', async () => {
  const consume = vi.fn(async () => true);
  const consentCurrent = vi.fn();
  const policy = vi.fn(() => ({ consume, assertCurrent: consentCurrent }));
  const f = fixture(policy);
  const request = { ...command, operation: 'submit', approvalToken: 'approved' };
  let currentAtPublication = 0;
  const publish = vi.fn((_value, context: SessionPublicationContext) => {
    currentAtPublication = consentCurrent.mock.calls.length;
    context.assertCurrent();
    context.assertCurrent();
  });
  const publication = { timeoutMs: 1000, publish };
  await f.app.execute('s', operator, request, publication);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(consentCurrent).toHaveBeenCalledTimes(currentAtPublication);
  expect(consume).toHaveBeenCalledTimes(1);
  expect(await f.app.execute('s', operator, request, publication)).toMatchObject({ replay: true });
  expect(consume).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(f.effect).toHaveBeenCalledTimes(1);
});

it('does not hand a result to the publisher when access was revoked during execution', async () => {
  const f = fixture();
  f.effect.mockImplementation(async () => {
    f.authorize.mockReturnValue(false);
    return { status: 'committed', value: 42 };
  });
  const publish = vi.fn();
  await expect(
    f.app.execute('s', operator, command, { timeoutMs: 1000, publish })
  ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
  expect(publish).not.toHaveBeenCalled();
  expect(f.authority.get('s')?.operation('write-1')?.status).toBe('completed');
});

it('contains private authorization errors at publication', async () => {
  const f = fixture();
  const publish = vi.fn(() => {
    f.authorize.mockImplementation(() => {
      throw new Error('PRIVATE_POLICY_DETAILS');
    });
  });
  const error = await f.app.execute('s', operator, command, { timeoutMs: 1000, publish }).then(
    () => undefined,
    (failure: unknown) => failure
  );
  expect(publish).toHaveBeenCalledTimes(1);
  expect(error).toMatchObject({ code: 'CONTROL_REQUIRED' });
  expect(String(error)).not.toContain('PRIVATE_POLICY_DETAILS');
});

it('keeps a receipt reader captured during work closed during publication', async () => {
  const f = fixture();
  let reader: ReturnType<ApplicationAuthority['prepareReceiptReadInScope']> | undefined;
  f.effect.mockImplementation(async () => {
    reader = f.app.prepareReceiptReadInScope('s');
    return { status: 'committed', value: 42 };
  });
  const publish = vi.fn(async (_value, context: SessionPublicationContext) => {
    context.assertCurrent();
    expect(reader).toBeDefined();
    expect(() => reader?.assertAuthority()).toThrow();
    await expect(reader?.read('receipt-1')).rejects.toThrow();
    context.assertCurrent();
  });
  await f.app.execute('s', operator, command, { timeoutMs: 1000, publish });
  expect(publish).toHaveBeenCalledTimes(1);
  expect(f.receipt).not.toHaveBeenCalled();
});

for (const cause of ['timeout', 'cancel'] as const) {
  it(`invalidates application output after ${cause} without rewriting execution`, async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const late = Promise.withResolvers<void>();
    const cancelled = new AbortController();
    const sent = vi.fn();
    let retained: SessionPublicationContext | undefined;
    const outcome = f.app
      .execute('s', operator, command, {
        timeoutMs: cause === 'timeout' ? 20 : 1000,
        signal: cancelled.signal,
        publish: async (_value, context) => {
          retained = context;
          entered.resolve();
          await late.promise;
          context.assertCurrent();
          sent();
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    await entered.promise;
    if (cause === 'cancel') cancelled.abort();
    try {
      expect(await outcome).toMatchObject({ code: 'CONTROL_REVOKED' });
      expect(retained?.signal.aborted).toBe(true);
      expect(() => retained?.assertCurrent()).toThrow();
      expect(f.authority.get('s')?.view().busy).toBe(false);
      expect(f.authority.get('s')?.operation('write-1')?.status).toBe('completed');
    } finally {
      late.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(sent).not.toHaveBeenCalled();
  });
}

it('preserves explicit rejection when delivery succeeds', async () => {
  const authority = new SessionAuthority();
  owners.push(authority);
  authority.register('s', 'owner', new AbortController().signal);
  const app = new ApplicationAuthority(authority, [
    {
      id: 'app',
      authorize: () => true,
      receipt: async () => null,
      operations: {
        write: defineApplicationOperation({
          mode: 'write',
          parse: () => null,
          execute: async () => ({ status: 'rejected', reason: 'VERSION_CONFLICT' }),
        }),
      },
    },
  ]);
  app.bind('s', operator, { adapter: 'app', resource: 'account' });
  const publish = vi.fn((value, context: SessionPublicationContext) => {
    expect(value).toEqual({ status: 'rejected', reason: 'VERSION_CONFLICT' });
    expect(context.status).toBe('failed');
    context.assertCurrent();
  });
  await app.execute('s', operator, command, { timeoutMs: 1000, publish });
  expect(publish).toHaveBeenCalledTimes(1);
  expect(authority.get('s')?.operation('write-1')?.status).toBe('failed');
});

it('rechecks lifetime when the final absent-binding lookup itself expires the owner', async () => {
  let now = 0;
  const authority = new SessionAuthority({ now: () => now });
  owners.push(authority);
  authority.register('s', 'owner', new AbortController().signal, { ttlMs: 1000 });
  const app = new ApplicationAuthority(authority);
  const sent = vi.fn();
  const get = authority.get.bind(authority);
  const result = app.discover('s', operator, {
    timeoutMs: 10000,
    publish: (_value, context) => {
      let lookups = 0;
      const lookup = vi.spyOn(authority, 'get').mockImplementation((id) => {
        if (++lookups === 2) now = 1000;
        return get(id);
      });
      try {
        context.assertCurrent();
        sent();
      } finally {
        lookup.mockRestore();
      }
    },
  });
  await expect(result).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
  expect(sent).not.toHaveBeenCalled();
});
