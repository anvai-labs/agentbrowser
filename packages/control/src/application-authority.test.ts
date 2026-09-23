import { createHash } from 'node:crypto';
import { VersionedCounter } from '@agentbrowser/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ApplicationAdapter,
  ApplicationAuthority,
  type ApplicationOperation,
  type ApplicationScope,
  ApplicationSessions,
  defineApplicationOperation,
} from './application-authority.js';
import { SessionAuthority, type SessionPrincipal } from './session-authority.js';

const operator: SessionPrincipal = { actor: 'operator', tenant: 'owner' };
const binding = { adapter: 'counter', resource: 'account-a' };
const command = { operation: 'add', input: 3, operationId: 'write-1', expectedVersion: 0 };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(
  authorize = ({ tenant, resource }: { tenant: string; resource: string }) =>
    tenant === 'owner' && resource === 'account-a'
) {
  const authority = new SessionAuthority();
  const abort = new AbortController();
  authority.register('session', 'owner', abort.signal);
  const oracle = new VersionedCounter();
  const effect = vi.fn(
    async (amount: number, context: { operationId?: string; expectedVersion?: number }) => {
      try {
        return {
          status: 'committed' as const,
          value: oracle.execute({
            operationId: context.operationId!,
            expectedVersion: context.expectedVersion!,
            amount,
          }),
        };
      } catch (error) {
        if (error instanceof Error && error.message === 'VERSION_CONFLICT')
          return { status: 'rejected' as const, reason: 'VERSION_CONFLICT' };
        throw error;
      }
    }
  );
  const parse = vi.fn((input: unknown) => {
    if (!Number.isInteger(input) || Number(input) < 1 || Number(input) > 100)
      throw new Error('Invalid amount');
    return Number(input);
  });
  const receipt = vi.fn(async (_scope, id: string) => oracle.receipt(id));
  const port = new ApplicationAuthority(authority, [
    {
      id: 'counter',
      authorize,
      operations: {
        add: defineApplicationOperation({ mode: 'write', parse, execute: effect }),
        state: defineApplicationOperation({
          mode: 'read',
          parse: () => undefined,
          execute: async () => ({ status: 'read', value: oracle.snapshot() }),
        }),
      },
      receipt,
    },
  ]);
  const grant = () => {
    const review = authority.get('session')!.prepareResume();
    return authority.authenticate(authority.delegate('session', review.epoch).token)!;
  };
  return { authority, abort, oracle, effect, parse, receipt, port, grant };
}

afterEach(() => vi.useRealTimers());

describe('trusted application configuration contracts', () => {
  const malformed: [string, () => unknown][] = [
    ['false', () => false],
    ['string', () => 'true'],
    ['object', () => ({ allowed: true })],
    ['resolved promise', () => Promise.resolve(false)],
    ['rejected promise', () => Promise.reject(new Error('PRIVATE-AUTHORIZATION'))],
    [
      'thenable',
      () => ({
        // biome-ignore lint/suspicious/noThenProperty: deliberately malformed policy
        then: (_resolve: unknown, reject: (error: Error) => void) =>
          reject(new Error('PRIVATE-AUTHORIZATION')),
      }),
    ],
    [
      'throw',
      () => {
        throw new Error('PRIVATE-AUTHORIZATION');
      },
    ],
    [
      'throwing then getter',
      () =>
        Object.defineProperty({}, 'then', {
          get() {
            throw new Error('PRIVATE-AUTHORIZATION');
          },
        }),
    ],
  ];
  for (const boundary of ['bind', 'discover', 'execute', 'receipt'] as const) {
    it.each(malformed)(
      `denies ${boundary} on %s without exposing private errors or effects`,
      async (_name, invalid) => {
        let check: () => unknown = () => true;
        const s = setup(() => check() as boolean);
        if (boundary !== 'bind') s.port.bind('session', operator, binding);
        check = invalid;
        const attempt = async () => {
          if (boundary === 'bind') return s.port.bind('session', operator, binding);
          if (boundary === 'discover') return s.port.discover('session', operator);
          if (boundary === 'execute') return s.port.execute('session', operator, command);
          return s.port.lookupReceipt('session', operator, 'receipt-1');
        };
        const failure = await attempt().then(
          () => undefined,
          (error: unknown) => error
        );
        expect(failure).toMatchObject({ code: 'CONTROL_REQUIRED' });
        expect(String(failure)).not.toContain('PRIVATE-AUTHORIZATION');
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(s.parse).not.toHaveBeenCalled();
        expect(s.effect).not.toHaveBeenCalled();
        expect(s.receipt).not.toHaveBeenCalled();
        expect(s.oracle.snapshot()).toEqual({ version: 0, total: 0 });
        check = () => true;
        if (boundary === 'bind') expect(await s.port.discover('session', operator)).toBeNull();
        if (boundary === 'execute') {
          expect(s.authority.get('session')!.operation(command.operationId)).toMatchObject({
            status: 'failed',
            dispatched: false,
          });
          expect(await s.port.execute('session', operator, command)).toMatchObject({
            replay: true,
          });
          expect(s.effect).not.toHaveBeenCalled();
        }
      }
    );
  }

  it('rechecks policy after preparation before dispatch and preserves a failed replay', async () => {
    let allowed = true;
    const s = setup(() => allowed);
    s.port.bind('session', operator, binding);
    s.parse.mockImplementation(() => {
      allowed = false;
      return 3;
    });
    await expect(s.port.execute('session', operator, command)).rejects.toMatchObject({
      code: 'CONTROL_REQUIRED',
    });
    expect(s.parse).toHaveBeenCalledOnce();
    expect(s.effect).not.toHaveBeenCalled();
    expect(s.oracle.snapshot()).toEqual({ version: 0, total: 0 });
    allowed = true;
    expect(await s.port.execute('session', operator, command)).toMatchObject({
      replay: true,
      operation: { status: 'failed', dispatched: false },
    });
  });

  it.each([
    ['resolved promise', () => Promise.resolve(() => undefined)],
    ['rejected promise', () => Promise.reject(new Error('PRIVATE-PREPARATION'))],
    ['nonfunction', () => ({ execute: true })],
  ] as const)('refuses %s preparation before recording dispatch', async (_name, prepare) => {
    const s = setup();
    const port = new ApplicationAuthority(s.authority, [
      {
        id: 'counter',
        authorize: () => true,
        receipt: s.receipt,
        operations: {
          add: { mode: 'write', prepare: prepare as unknown as ApplicationOperation['prepare'] },
        },
      },
    ]);
    port.bind('session', operator, binding);
    await expect(port.execute('session', operator, command)).rejects.toThrow();
    expect(s.authority.get('session')!.operation(command.operationId)).toMatchObject({
      status: 'failed',
      dispatched: false,
    });
    expect(s.effect).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it.each(['replacement', 'takeover', 'rebind', 'busy'] as const)(
    'does not install an outer binding after authorization changes %s',
    async (change) => {
      const s = setup();
      let armed = true;
      let pending: Promise<unknown> | undefined;
      const release = deferred();
      const port = new ApplicationAuthority(s.authority, [
        {
          id: 'counter',
          authorize: () => {
            if (armed) {
              armed = false;
              if (change === 'replacement') {
                s.authority.remove('session');
                s.authority.register('session', 'replacement-owner', new AbortController().signal);
              } else if (change === 'takeover') s.authority.takeover('session');
              else if (change === 'rebind')
                port.bind('session', operator, { ...binding, resource: 'inner' });
              else pending = s.authority.run('session', operator, {}, () => release.promise);
            }
            return true;
          },
          operations: {},
          receipt: async () => undefined,
        },
      ]);
      if (change === 'takeover') s.authority.get('session')!.prepareResume();
      try {
        expect(() => port.bind('session', operator, binding)).toThrow();
      } finally {
        if (change === 'busy') {
          expect(s.authority.status('session')).toMatchObject({
            state: 'PAUSE_REQUESTED',
            busy: true,
          });
          const refused = expect(pending).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
          release.resolve();
          await refused;
          expect(s.authority.status('session')).toMatchObject({
            state: 'HUMAN_ACTIVE',
            busy: false,
          });
        } else {
          release.resolve();
          await pending;
        }
      }
      const owner: SessionPrincipal =
        change === 'replacement' ? { actor: 'operator', tenant: 'replacement-owner' } : operator;
      const discovered = await port.discover('session', owner);
      if (change === 'rebind') expect(discovered).toMatchObject({ resource: 'inner' });
      else expect(discovered).toBeNull();
    }
  );

  it('binds the checked scalar request and tenant despite caller object mutation', async () => {
    const s = setup();
    const owner: SessionPrincipal = { actor: 'operator', tenant: 'owner' };
    const requested = { ...binding };
    const port = new ApplicationAuthority(s.authority, [
      {
        id: 'counter',
        authorize: (scope) => {
          requested.resource = 'unchecked-resource';
          owner.tenant = 'unchecked-tenant';
          return scope.tenant === 'owner' && scope.resource === 'account-a';
        },
        operations: {},
        receipt: async () => undefined,
      },
    ]);
    port.bind('session', owner, requested);
    expect(await port.discover('session', operator)).toMatchObject(binding);
  });

  it('rechecks admission after policy and before operation preparation', async () => {
    let check = () => true;
    const s = setup(() => check());
    s.port.bind('session', operator, binding);
    check = () => {
      s.authority.takeover('session');
      return true;
    };
    await expect(s.port.execute('session', operator, command)).rejects.toMatchObject({
      code: 'CONTROL_REVOKED',
    });
    expect(s.parse).not.toHaveBeenCalled();
    expect(s.effect).not.toHaveBeenCalled();
  });

  const registration = (operations: ApplicationAdapter['operations']) => {
    const s = setup();
    return {
      ...s,
      port: new ApplicationAuthority(s.authority, [
        {
          id: 'counter',
          authorize: () => true,
          operations,
          receipt: async () => undefined,
        },
      ]),
    };
  };
  const readOperation = (): ApplicationOperation => ({
    mode: 'read',
    prepare: () => async () => ({ status: 'read', value: 1 }),
  });
  it.each(['bad name', '', 'x'.repeat(129)])(
    'rejects an unreachable operation name: %s',
    (name) => {
      expect(() => registration({ [name]: readOperation() })).toThrow();
    }
  );
  it.each([undefined, null, 'READ', 'delete', 1])('rejects malformed operation mode %s', (mode) => {
    expect(() =>
      registration({ state: { ...readOperation(), mode } as ApplicationOperation })
    ).toThrow();
  });
  it('rejects missing preparation and oversized catalogs before registration', () => {
    expect(() => registration({ state: { mode: 'read' } as ApplicationOperation })).toThrow();
    expect(() =>
      registration(
        Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`op${i}`, readOperation()]))
      )
    ).toThrow();
    expect(() =>
      registration(
        Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`op${i}`, readOperation()]))
      )
    ).not.toThrow();
  });
  it('captures write mode and preparation while preserving the custom method receiver', async () => {
    const original = vi.fn(async () => ({ status: 'committed' as const, value: 7 }));
    const replacement = vi.fn(async () => ({ status: 'read' as const, value: 99 }));
    class Operation {
      mode: 'read' | 'write' = 'write';
      marker = 7;
      prepare() {
        expect(this.marker).toBe(7);
        return original;
      }
    }
    const op = new Operation();
    const operations = Object.assign(Object.create(null), { add: op });
    const s = registration(operations);
    s.port.bind('session', operator, binding);
    op.mode = 'read';
    Object.assign(op, { prepare: () => replacement });
    operations.add = readOperation();
    expect(await s.port.discover('session', operator)).toMatchObject({
      operations: [{ name: 'add', mode: 'write' }],
    });
    await expect(
      s.port.execute('session', operator, { operation: 'add', input: null })
    ).rejects.toThrow('Writes require');
    expect(await s.port.execute('session', operator, command)).toEqual({
      status: 'committed',
      value: 7,
    });
    expect(original).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
  });
  it('captures typed builder parser/executor references without freezing caller state', async () => {
    const definition = {
      mode: 'read' as const,
      marker: 7,
      parse(input: unknown) {
        expect(this.marker).toBe(7);
        return input;
      },
      async execute(input: unknown) {
        expect(this.marker).toBe(7);
        return { status: 'read' as const, value: input };
      },
    };
    const s = registration({ state: defineApplicationOperation(definition) });
    s.port.bind('session', operator, binding);
    definition.parse = () => {
      throw new Error('Replaced parser');
    };
    definition.execute = async () => {
      throw new Error('Replaced executor');
    };
    expect(await s.port.execute('session', operator, { operation: 'state', input: 4 })).toEqual({
      status: 'read',
      value: 4,
    });
    expect(Object.isFrozen(definition)).toBe(false);
  });
});

describe('application authority without a browser', () => {
  it.each(['resolve', 'reject'] as const)(
    'retains admission until an abandoned receipt settles: %s',
    async (settlement) => {
      const s = setup();
      s.port.bind('session', operator, binding);
      const release = deferred();
      s.receipt.mockImplementationOnce(async () => {
        await release.promise;
        if (settlement === 'reject') throw new Error('private adapter failure');
        return { private: 'late receipt' } as never;
      });
      let read!: Promise<unknown>;
      let staleGuard!: () => void;
      await s.authority.run('session', operator, { id: 'outer', fingerprint: 'same' }, async () => {
        const reader = s.port.prepareReceiptReadInScope('session');
        staleGuard = s.authority.outputGuard('session');
        read = reader.read('business-1');
        void read.catch(() => undefined);
        // A deadline race can finish composition while the adapter ignores cancellation.
        return { verification: 'unknown' };
      });
      try {
        expect(s.authority.status('session')).toMatchObject({
          busy: true,
          operation: { operationId: 'outer', status: 'in_flight' },
        });
        expect(staleGuard).toThrow();
        await expect(
          s.authority.run('session', operator, {}, async () => undefined)
        ).rejects.toMatchObject({
          code: 'SESSION_BUSY',
        });
        expect(() => s.port.unbind('session', operator)).toThrow('busy');
        expect(() => s.authority.get('session')?.prepareResume()).toThrow('busy');
        expect(s.authority.takeover('session').state).toBe('PAUSE_REQUESTED');
      } finally {
        release.resolve();
        await expect(read).rejects.toThrow();
      }
      await vi.waitFor(() => expect(s.authority.status('session').busy).toBe(false));
      expect(s.authority.status('session').state).toBe('HUMAN_ACTIVE');
      expect(s.authority.get('session')?.operation('outer')).toMatchObject({ status: 'failed' });
      await expect(
        s.port.lookupReceipt('session', operator, 'business-2')
      ).resolves.toBeUndefined();
      expect(s.receipt).toHaveBeenCalledTimes(2);
    }
  );

  it('prepares a receipt reader with frozen admitted identity before any effect or read', async () => {
    const s = setup();
    s.port.bind('session', operator, binding);
    const principal = s.grant();
    let captured: ReturnType<ApplicationAuthority['prepareReceiptReadInScope']> | undefined;
    await s.authority.run('session', principal, {}, async () => {
      const reader = s.port.prepareReceiptReadInScope('session');
      captured = reader;
      expect(reader.identity).toEqual({
        admission: { actor: 'agent', tenant: 'owner', mode: 'qa' },
        adapter: 'counter',
        resource: 'account-a',
        sessionId: 'session',
        sessionIncarnation: s.authority.sessionIncarnation('session'),
      });
      expect(Object.isFrozen(reader)).toBe(true);
      expect(Object.isFrozen(reader.identity)).toBe(true);
      expect(Object.isFrozen(reader.identity.admission)).toBe(true);
      expect(s.receipt).not.toHaveBeenCalled();
      expect(s.effect).not.toHaveBeenCalled();
      expect(s.authority.didDispatchInScope('session')).toBe(false);
      Object.assign(principal, { mode: 'application' });
      expect(reader.identity.admission).toMatchObject({ mode: 'qa' });
      reader.assertAuthority();
      await reader.read('business-1');
      await reader.read('business-2');
      expect(s.receipt.mock.calls.map((call) => call[1])).toEqual(['business-1', 'business-2']);
    });
    expect(() => captured?.assertAuthority()).toThrow();
    await expect(captured?.read('business-3')).rejects.toThrow();
    await s.authority.run('session', { ...principal, mode: 'qa' }, {}, async () => {
      await expect(captured?.read('business-3')).rejects.toThrow();
    });
    expect(s.receipt).toHaveBeenCalledTimes(2);
  });

  it.each(['outside', 'cross-session', 'unbound', 'unauthorized'] as const)(
    'refuses receipt preparation before dispatch: %s',
    async (mode) => {
      let allowed = true;
      const s = setup(() => allowed);
      if (mode !== 'unbound') s.port.bind('session', operator, binding);
      s.authority.register('other', 'owner', new AbortController().signal);
      const execute = vi.fn();
      const prepareThenExecute = () => {
        s.port.prepareReceiptReadInScope(mode === 'cross-session' ? 'other' : 'session');
        execute();
      };
      if (mode === 'unauthorized') allowed = false;
      if (mode === 'outside') expect(prepareThenExecute).toThrow();
      else
        await s.authority.run('session', operator, {}, async () => {
          expect(prepareThenExecute).toThrow();
          expect(s.authority.didDispatchInScope('session')).toBe(false);
        });
      expect(execute).not.toHaveBeenCalled();
      expect(s.receipt).not.toHaveBeenCalled();
    }
  );

  it('does not revive a prepared reader after observed permission loss and regrant', async () => {
    let allowed = true;
    const s = setup(() => allowed);
    s.port.bind('session', operator, binding);
    await s.authority.run('session', operator, {}, async () => {
      const reader = s.port.prepareReceiptReadInScope('session');
      expect(reader.identity.admission).toEqual({ actor: 'operator', tenant: 'owner' });
      allowed = false;
      expect(() => reader.assertAuthority()).toThrow();
      allowed = true;
      expect(() => reader.assertAuthority()).toThrow();
      await expect(reader.read('business-1')).rejects.toThrow();
    });
    expect(s.receipt).not.toHaveBeenCalled();
  });

  it('rejects a prepared reader used outside its admission while the original is still pending', async () => {
    const s = setup();
    s.port.bind('session', operator, binding);
    const release = deferred();
    let reader: ReturnType<ApplicationAuthority['prepareReceiptReadInScope']> | undefined;
    const pending = s.authority.run('session', operator, {}, async () => {
      reader = s.port.prepareReceiptReadInScope('session');
      await release.promise;
    });
    try {
      expect(reader).toBeDefined();
      await expect(reader?.read('business-1')).rejects.toThrow();
    } finally {
      release.resolve();
      await pending;
    }
    expect(s.receipt).not.toHaveBeenCalled();
  });

  it('uses a fresh per-read deadline and rejects malformed IDs before adapter I/O', async () => {
    const s = setup();
    s.port.bind('session', operator, binding);
    const first = new AbortController();
    const second = new AbortController();
    const signals: AbortSignal[] = [];
    s.receipt.mockImplementation(async (scope: ApplicationScope) => {
      signals.push(scope.signal);
      return undefined;
    });
    await s.authority.run('session', operator, {}, async () => {
      const reader = s.port.prepareReceiptReadInScope('session');
      for (const id of ['', '../private', 'x'.repeat(129), 42]) {
        await expect(reader.read(id as string)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      }
      expect(s.receipt).not.toHaveBeenCalled();
      await reader.read('first', first.signal);
      first.abort();
      expect(signals[0]?.aborted).toBe(true);
      await reader.read('second', second.signal);
      expect(signals[1]?.aborted).toBe(false);
      expect(signals[0]).not.toBe(signals[1]);
      expect(s.authority.didDispatchInScope('session')).toBe(false);
    });
    expect(s.receipt).toHaveBeenCalledTimes(2);
  });

  it('withholds an in-flight prepared receipt after observed revoke/regrant and drains its admission', async () => {
    let allowed = true;
    const s = setup(() => allowed);
    s.port.bind('session', operator, binding);
    const release = deferred();
    s.receipt.mockImplementationOnce(async () => {
      await release.promise;
      return { private: 'receipt' } as never;
    });
    await s.authority.run('session', operator, {}, async () => {
      const reader = s.port.prepareReceiptReadInScope('session');
      const read = reader.read('business-1');
      const refused = expect(read).rejects.toThrow();
      allowed = false;
      expect(() => reader.assertAuthority()).toThrow();
      allowed = true;
      await expect(s.port.lookupReceipt('session', operator, 'business-2')).rejects.toThrow('busy');
      release.resolve();
      await refused;
      await expect(reader.read('business-2')).rejects.toThrow();
    });
    expect(s.receipt).toHaveBeenCalledOnce();
  });

  it('reads a business receipt in the existing admission without another ticket or write', async () => {
    const s = setup();
    s.port.bind('session', operator, binding);
    await s.port.execute('session', operator, command);
    const incarnation = s.authority.sessionIncarnation('session');
    const result = await s.authority.run(
      'session',
      operator,
      { id: 'outcome-run-1', fingerprint: 'fixture' },
      async () => {
        await expect(
          s.port.lookupReceipt('session', operator, command.operationId)
        ).rejects.toThrow('busy');
        return s.port.readReceiptInScope('session', command.operationId);
      }
    );
    expect(result).toMatchObject({ total: 3 });
    expect(s.receipt).toHaveBeenCalledOnce();
    expect(s.receipt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session',
        sessionIncarnation: incarnation,
        tenant: 'owner',
        resource: 'account-a',
      }),
      command.operationId
    );
    const scope = s.receipt.mock.calls[0]?.[0] as ApplicationScope;
    expect(scope).not.toHaveProperty('operationId');
    expect(scope).not.toHaveProperty('bindingGeneration');
    expect(s.authority.get('session')?.operation('outcome-run-1')).toMatchObject({
      status: 'completed',
      dispatched: false,
    });
    expect(s.effect).toHaveBeenCalledOnce();
  });

  it('refuses receipt reads outside or across admission, with invalid IDs, or after cancellation', async () => {
    const s = setup();
    s.port.bind('session', operator, binding);
    await expect(s.port.readReceiptInScope('session', 'receipt-1')).rejects.toThrow();
    s.authority.register('other-session', 'owner', new AbortController().signal);
    s.port.bind('other-session', operator, binding);
    const cancelled = new AbortController();
    cancelled.abort();
    await s.authority.run('session', operator, {}, async () => {
      await expect(s.port.readReceiptInScope('other-session', 'receipt-1')).rejects.toThrow();
      await expect(s.port.readReceiptInScope('session', '../private')).rejects.toThrow();
      await expect(
        s.port.readReceiptInScope('session', 'receipt-1', cancelled.signal)
      ).rejects.toThrow();
    });
    expect(s.receipt).not.toHaveBeenCalled();
  });

  it.each(['takeover', 'replacement', 'deadline', 'session-abort', 'authorization'] as const)(
    'withholds receipt output after %s changes during a pending read',
    async (revocation) => {
      let authorized = true;
      const s = setup(() => authorized);
      s.port.bind('session', operator, binding);
      const agent = s.grant();
      const pending = deferred();
      const readAbort = new AbortController();
      let readSignal: AbortSignal | undefined;
      s.receipt.mockImplementationOnce(async (scope: ApplicationScope) => {
        readSignal = scope.signal;
        await pending.promise;
        return { private: 'receipt' } as never;
      });
      const read = s.authority.run('session', agent, {}, () =>
        s.port.readReceiptInScope('session', 'receipt-1', readAbort.signal)
      );
      const refused = expect(read).rejects.toThrow();
      expect(s.receipt).toHaveBeenCalledOnce();
      if (revocation === 'takeover') s.authority.takeover('session');
      if (revocation === 'replacement') {
        s.authority.remove('session');
        s.authority.register('session', 'owner', new AbortController().signal);
      }
      if (revocation === 'deadline') {
        readAbort.abort();
        expect(readSignal?.aborted).toBe(true);
        await expect(s.port.lookupReceipt('session', agent, 'another')).rejects.toThrow('busy');
      }
      if (revocation === 'session-abort') {
        s.abort.abort();
        expect(readSignal?.aborted).toBe(true);
      }
      if (revocation === 'authorization') authorized = false;
      pending.resolve();
      await refused;
      expect(s.effect).not.toHaveBeenCalled();
    }
  );

  it.each(['before', 'after'] as const)(
    'fences synchronous authorization takeover %s receipt I/O',
    async (stage) => {
      let revoke: () => void = () => {};
      const s = setup(() => {
        revoke();
        return true;
      });
      s.port.bind('session', operator, binding);
      const agent = s.grant();
      const takeover = () => s.authority.takeover('session');
      if (stage === 'before') revoke = takeover;
      else
        s.receipt.mockImplementationOnce(async () => {
          revoke = takeover;
          return undefined;
        });
      await expect(
        s.authority.run('session', agent, {}, () =>
          s.port.readReceiptInScope('session', 'receipt-1')
        )
      ).rejects.toThrow();
      expect(s.receipt).toHaveBeenCalledTimes(stage === 'before' ? 0 : 1);
    }
  );

  it('rechecks adapter authorization after standalone receipt lookup', async () => {
    let authorized = true;
    const s = setup(() => authorized);
    s.port.bind('session', operator, binding);
    s.receipt.mockImplementationOnce(async () => {
      authorized = false;
      return { private: 'receipt' } as never;
    });
    await expect(s.port.lookupReceipt('session', operator, 'receipt-1')).rejects.toThrow();
  });

  it('preserves class-based trusted adapters and their method receivers', async () => {
    const s = setup();
    class Adapter {
      id = 'class-app';
      resource = 'account-a';
      operations = {
        state: defineApplicationOperation({
          mode: 'read' as const,
          parse: () => null,
          execute: async () => ({ status: 'read' as const, value: 7 }),
        }),
      };
      authorize(scope: { resource: string }) {
        return scope.resource === this.resource;
      }
      async receipt() {
        return this.resource;
      }
    }
    const port = new ApplicationAuthority(s.authority, [new Adapter()]);
    port.bind('session', operator, { adapter: 'class-app', resource: 'account-a' });
    expect(await port.execute('session', operator, { operation: 'state', input: null })).toEqual({
      status: 'read',
      value: 7,
    });
    expect(await port.lookupReceipt('session', operator, 'receipt-1')).toBe('account-a');
  });

  it('defaults to no application and supports explicit removal with fresh review', async () => {
    const s = setup();
    const empty = new ApplicationAuthority(s.authority);
    expect(await empty.discover('session', operator)).toBeNull();
    expect(() => empty.bind('session', operator, binding)).toThrow();
    s.port.bind('session', operator, binding);
    const review = s.authority.get('session')!.prepareResume();
    s.port.unbind('session', operator);
    expect(await s.port.discover('session', operator)).toBeNull();
    expect(() => s.authority.delegate('session', review.epoch)).toThrow();
    await expect(s.port.execute('session', operator, command)).rejects.toThrow();
    expect(s.effect).not.toHaveBeenCalled();
  });

  it('bounds input before adapter validation and rejects inherited operation names', async () => {
    const s = setup();
    s.port.bind('session', operator, binding);
    for (const input of ['x'.repeat(65537), Array(4097).fill(0), { fn: () => 0 }, Number.NaN])
      await expect(s.port.execute('session', operator, { ...command, input })).rejects.toThrow();
    await expect(
      s.port.execute('session', operator, { ...command, operation: 'toString' })
    ).rejects.toThrow();
    expect(s.parse).not.toHaveBeenCalled();
    expect(s.effect).not.toHaveBeenCalled();
  });

  it('stops traversing an oversized command before reading later values', async () => {
    const s = setup();
    s.port.bind('session', operator, binding);
    const later = vi.fn(() => 'must not be read');
    const input = Object.defineProperty({ a: '\u0000'.repeat(12000) }, 'z', {
      enumerable: true,
      get: later,
    });
    await expect(s.port.execute('session', operator, { ...command, input })).rejects.toThrow();
    expect(later).not.toHaveBeenCalled();
    expect(s.parse).not.toHaveBeenCalled();
    expect(s.effect).not.toHaveBeenCalled();
    expect(s.authority.get('session')!.operation(command.operationId)).toBeUndefined();
  });

  it('accepts maximum-depth input without charging fingerprint metadata to its budget', async () => {
    const s = setup();
    let input: unknown = 1;
    for (let i = 0; i < 16; i++) input = [input];
    const execute = vi.fn(async (value: unknown) => ({ status: 'committed' as const, value }));
    const port = new ApplicationAuthority(s.authority, [
      {
        id: 'echo',
        authorize: () => true,
        operations: {
          echo: defineApplicationOperation({ mode: 'write', parse: (v) => v, execute }),
        },
        receipt: async () => null,
      },
    ]);
    port.bind('session', operator, { adapter: 'echo', resource: 'account-a' });
    const request = { ...command, operation: 'echo', input };
    expect(await port.execute('session', operator, request)).toEqual({
      status: 'committed',
      value: input,
    });
    expect(await port.execute('session', operator, request)).toMatchObject({ replay: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a write identity after rebinding the same resource', async () => {
    const s = setup();
    s.port.bind('session', operator, binding);
    await s.port.execute('session', operator, command);
    s.port.bind('session', operator, binding);
    await expect(s.port.execute('session', operator, command)).rejects.toThrow();
    expect(s.effect).toHaveBeenCalledTimes(1);
  });

  it('scopes application write identities and receipts to the owning session', async () => {
    const authority = new SessionAuthority();
    authority.register('session-a', 'owner', new AbortController().signal);
    authority.register('session-b', 'owner', new AbortController().signal);
    const oracle = new VersionedCounter();
    const applicationId = (scope: ApplicationScope, operationId = scope.operationId) => {
      if (!operationId) throw new Error('MISSING_IDENTITY');
      return createHash('sha256')
        .update(
          JSON.stringify([scope.tenant, scope.resource, scope.sessionIncarnation, operationId])
        )
        .digest('hex');
    };
    const port = new ApplicationAuthority(authority, [
      {
        id: 'counter',
        authorize: ({ tenant, resource }) => tenant === 'owner' && resource === 'account-a',
        operations: {
          add: defineApplicationOperation({
            mode: 'write',
            parse: (input) => Number(input),
            execute: async (amount, scope) => ({
              status: 'committed',
              value: oracle.execute({
                operationId: applicationId(scope),
                expectedVersion: scope.expectedVersion ?? -1,
                amount,
              }),
            }),
          }),
        },
        receipt: async (scope, operationId) => oracle.receipt(applicationId(scope, operationId)),
      },
    ]);
    port.bind('session-a', operator, binding);
    port.bind('session-b', operator, binding);

    await expect(
      port.execute('session-a', operator, {
        ...command,
        input: 3,
        expectedVersion: 0,
      })
    ).resolves.toMatchObject({ status: 'committed', value: { version: 1, total: 3 } });
    await expect(
      port.execute('session-b', operator, {
        ...command,
        input: 4,
        expectedVersion: 1,
      })
    ).resolves.toMatchObject({ status: 'committed', value: { version: 2, total: 7 } });
    expect(await port.lookupReceipt('session-a', operator, command.operationId)).toMatchObject({
      expectedVersion: 0,
      amount: 3,
      total: 3,
    });
    expect(await port.lookupReceipt('session-b', operator, command.operationId)).toMatchObject({
      expectedVersion: 1,
      amount: 4,
      total: 7,
    });

    port.unbind('session-a', operator);
    port.bind('session-a', operator, binding);
    expect(await port.lookupReceipt('session-a', operator, command.operationId)).toMatchObject({
      expectedVersion: 0,
      amount: 3,
      total: 3,
    });

    authority.remove('session-a');
    authority.register('session-a', 'owner', new AbortController().signal);
    port.bind('session-a', operator, binding);
    expect(await port.lookupReceipt('session-a', operator, command.operationId)).toBeUndefined();
    await expect(
      port.execute('session-a', operator, {
        ...command,
        input: 5,
        expectedVersion: 2,
      })
    ).resolves.toMatchObject({ status: 'committed', value: { version: 3, total: 12 } });
    expect(await port.lookupReceipt('session-a', operator, command.operationId)).toMatchObject({
      expectedVersion: 2,
      amount: 5,
      total: 12,
    });
  });

  it('keeps write identities stable across key order and isolates adapter input mutations', async () => {
    const s = setup();
    const execute = vi.fn(async (value: Record<string, unknown>) => {
      value.a = 'adapter-owned mutation';
      return { status: 'committed' as const, value: 1 };
    });
    const port = new ApplicationAuthority(s.authority, [
      {
        id: 'echo',
        authorize: () => true,
        operations: {
          echo: defineApplicationOperation({
            mode: 'write',
            parse: (input) => input as Record<string, unknown>,
            execute,
          }),
        },
        receipt: async () => null,
      },
    ]);
    port.bind('session', operator, { adapter: 'echo', resource: 'account-a' });
    const input = Object.freeze({ a: 'é', z: [1, 2] });
    const request = { ...command, operation: 'echo', input };
    await port.execute('session', operator, request);
    expect(input.a).toBe('é');
    expect(
      await port.execute('session', operator, { ...request, input: { z: [1, 2], a: 'é' } })
    ).toMatchObject({ replay: true });
    await expect(
      port.execute('session', operator, { ...request, input: { z: [2, 1], a: 'é' } })
    ).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('revokes admitted output and signals cancellation when the owning session expires', async () => {
    const s = setup();
    s.port.bind('session', operator, binding);
    const pending = deferred();
    s.effect.mockImplementationOnce(async () => {
      await pending.promise;
      return { status: 'rejected', reason: 'cancelled' };
    });
    const work = s.port.execute('session', operator, command);
    const rejected = expect(work).rejects.toThrow();
    const signal = s.authority.signal('session');
    s.abort.abort();
    expect(signal.aborted).toBe(true);
    pending.resolve();
    await rejected;
    expect(s.authority.get('session')).toBeUndefined();
  });

  it('refuses missing bindings, wrong tenants and unauthorized resources before execution', async () => {
    const s = setup();
    await expect(s.port.execute('session', operator, command)).rejects.toThrow();
    expect(() => s.port.bind('session', { actor: 'operator', tenant: 'other' }, binding)).toThrow();
    expect(() => s.port.bind('session', operator, { ...binding, resource: 'account-b' })).toThrow();
    expect(s.effect).not.toHaveBeenCalled();
    s.port.bind('session', operator, binding);
    await expect(
      s.port.execute('session', { actor: 'operator', tenant: 'other' }, command)
    ).rejects.toThrow();
    expect(s.parse).not.toHaveBeenCalled();
  });

  it('invalidates prepared review when binding changes and forbids agent configuration', () => {
    const s = setup();
    const old = s.authority.get('session')!.prepareResume();
    s.port.bind('session', operator, binding);
    expect(() => s.authority.delegate('session', old.epoch)).toThrow();
    const agent = s.grant();
    expect(() => s.port.bind('session', agent, binding)).toThrow();
    expect(() => s.port.bind('session', operator, binding)).toThrow();
  });

  it('returns only bound operation names and rejects unknown operations and malformed writes', async () => {
    const s = setup();
    s.port.bind('session', operator, binding);
    expect(await s.port.discover('session', operator)).toMatchObject({
      ...binding,
      operations: [
        { name: 'add', mode: 'write' },
        { name: 'state', mode: 'read' },
      ],
    });
    for (const request of [
      { ...command, operation: 'arbitrary-url' },
      { ...command, input: 'bad' },
      { ...command, operationId: '' },
      { ...command, expectedVersion: -1 },
    ])
      await expect(s.port.execute('session', operator, request)).rejects.toThrow();
    expect(s.effect).not.toHaveBeenCalled();
  });

  it('suppresses duplicate IDs, rejects changed arguments and records business conflicts as failed', async () => {
    const s = setup();
    s.port.bind('session', operator, binding);
    const agent = s.grant();
    expect(await s.port.execute('session', agent, command)).toMatchObject({ status: 'committed' });
    expect(await s.port.execute('session', agent, command)).toMatchObject({ replay: true });
    await expect(s.port.execute('session', agent, { ...command, input: 4 })).rejects.toThrow();
    expect(s.effect).toHaveBeenCalledTimes(1);
    expect(
      await s.port.execute('session', agent, { ...command, operationId: 'stale' })
    ).toMatchObject({ status: 'rejected', reason: 'VERSION_CONFLICT' });
    expect(s.authority.get('session')!.operation('stale')).toMatchObject({
      status: 'failed',
      dispatched: true,
    });
    expect(s.oracle.snapshot()).toEqual({ version: 1, total: 3 });
  });

  it('shares admission with browser work, including reads and receipt lookups', async () => {
    const s = setup();
    s.port.bind('session', operator, binding);
    const waiting = deferred();
    const browser = s.authority.run('session', operator, {}, () => waiting.promise);
    await expect(
      s.port.execute('session', operator, { operation: 'state', input: null })
    ).rejects.toThrow('busy');
    await expect(s.port.lookupReceipt('session', operator, 'write-1')).rejects.toThrow('busy');
    expect(() => s.port.bind('session', operator, binding)).toThrow('busy');
    waiting.resolve();
    await browser;
    expect(s.receipt).not.toHaveBeenCalled();
  });

  it('revokes before dispatch even if a trusted validator triggers takeover', async () => {
    const s = setup();
    s.port.bind('session', operator, binding);
    const agent = s.grant();
    s.parse.mockImplementationOnce(() => {
      s.authority.takeover('session');
      return 3;
    });
    await expect(s.port.execute('session', agent, command)).rejects.toThrow();
    expect(s.effect).not.toHaveBeenCalled();
    expect(s.oracle.snapshot().total).toBe(0);
  });

  it('withholds output after dispatch and takeover, then reconciles without replay', async () => {
    const s = setup();
    s.port.bind('session', operator, binding);
    const agent = s.grant();
    const waiting = deferred();
    const effect = s.effect.getMockImplementation()!;
    s.effect.mockImplementationOnce(async (input, context) => {
      const result = await effect(input, context);
      await waiting.promise;
      return result;
    });
    const pending = s.port.execute('session', agent, command);
    const rejected = expect(pending).rejects.toThrow();
    expect(s.oracle.snapshot().total).toBe(3);
    expect(s.authority.takeover('session').state).toBe('PAUSE_REQUESTED');
    waiting.resolve();
    await rejected;
    expect(s.authority.get('session')!.operation('write-1')).toMatchObject({
      status: 'outcome_unknown',
    });
    await expect(s.port.lookupReceipt('session', agent, 'write-1')).rejects.toThrow();
    expect(await s.port.lookupReceipt('session', operator, 'write-1')).toMatchObject({ total: 3 });
    expect(s.effect).toHaveBeenCalledTimes(1);
  });

  it('keeps a lost write uncertain and never dispatches the same ID again', async () => {
    const s = setup();
    s.port.bind('session', operator, binding);
    const effect = s.effect.getMockImplementation()!;
    s.effect.mockImplementationOnce(async (input, context) => {
      await effect(input, context);
      throw new Error('Response lost');
    });
    await expect(s.port.execute('session', operator, command)).rejects.toThrow('Response lost');
    expect(await s.port.execute('session', operator, command)).toMatchObject({
      replay: true,
      operation: { status: 'outcome_unknown' },
    });
    expect(await s.port.lookupReceipt('session', operator, 'write-1')).toMatchObject({ total: 3 });
    expect(s.effect).toHaveBeenCalledTimes(1);
  });

  it('forgets bindings on session removal and does not revive old grants', async () => {
    const s = setup();
    s.port.bind('session', operator, binding);
    const agent = s.grant();
    s.abort.abort();
    s.authority.register('session', 'owner', new AbortController().signal);
    await expect(s.port.execute('session', agent, command)).rejects.toThrow();
    expect(await s.port.discover('session', operator)).toBeNull();
  });

  it('owns application-only sessions with bounded TTL and tenant checks, without an engine', () => {
    vi.useFakeTimers();
    const sessions = new ApplicationSessions({ maxSessions: 1 });
    const created = sessions.create(operator, { ttlMs: 1000 });
    expect(sessions.authority.get(created.sessionId)?.view().state).toBe('HUMAN_ACTIVE');
    expect(() => sessions.create(operator)).toThrow();
    expect(() =>
      sessions.close(created.sessionId, { actor: 'operator', tenant: 'other' })
    ).toThrow();
    vi.advanceTimersByTime(1000);
    expect(sessions.authority.get(created.sessionId)).toBeUndefined();
    const next = sessions.create(operator);
    sessions.close(next.sessionId, operator);
    expect(sessions.authority.get(next.sessionId)).toBeUndefined();
  });
});
