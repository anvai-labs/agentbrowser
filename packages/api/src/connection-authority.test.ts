import { Socket } from 'node:net';
import { EngineError, type RequestPolicy } from '@agentbrowser/engine';
import { NetworkPolicy } from '@agentbrowser/policy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionAuthority, ConnectionBudget } from './connection-authority.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const destination = {
  kind: 'request' as const,
  url: 'http://download.invalid/file',
  hostname: 'download.invalid',
  port: 80,
};
const answer = { address: '127.0.0.1', family: 4 };
const strict = () =>
  new NetworkPolicy({ blockLoopback: true, blockPrivateIPs: true, blockMetadata: true });
const deadline = () => performance.now() + 30_000;

function harness(
  options: {
    policy?: RequestPolicy;
    budget?: ConnectionBudget;
    maxConnections?: number;
    setupTimeoutMs?: number;
    resolve?: () => Promise<Array<{ address: string; family: number }>>;
    peer?: string;
    port?: number;
    connect?: (socket: Socket) => void;
    created?: (socket: Socket) => void;
  } = {}
) {
  const sockets: Socket[] = [];
  const dial = vi.fn();
  const resolve = vi.fn(options.resolve ?? (async () => [answer]));
  const budget = options.budget ?? new ConnectionBudget();
  const authority = new ConnectionAuthority(
    {
      policy: options.policy ?? new NetworkPolicy(),
      admission: budget.createSessionScope(options.maxConnections ?? 8),
      ...options,
    },
    {
      resolve,
      createSocket: () => {
        const socket = new Socket();
        Object.defineProperties(socket, {
          remoteAddress: { value: options.peer ?? '::ffff:127.0.0.1' },
          remotePort: { value: options.port ?? 80 },
        });
        vi.spyOn(socket, 'connect').mockImplementation((...args: unknown[]) => {
          dial(...args);
          if (options.connect) options.connect(socket);
          else queueMicrotask(() => socket.emit('connect'));
          return socket;
        });
        sockets.push(socket);
        options.created?.(socket);
        return socket;
      },
    }
  );
  return { authority, budget, resolve, sockets, dial };
}

afterEach(() => vi.useRealTimers());

describe('connection authority admission and lifecycle', () => {
  it('enforces default per-authority and shared-runtime caps without a queue', async () => {
    const budget = new ConnectionBudget();
    const groups = Array.from({ length: 5 }, () => harness({ budget }));
    try {
      for (const group of groups.slice(0, 4)) {
        await Promise.all(
          Array.from({ length: 8 }, () =>
            group.authority.connect(destination, { deadline: deadline() })
          )
        );
        await expect(
          group.authority.connect(destination, { deadline: deadline() })
        ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
        expect(group.resolve).toHaveBeenCalledTimes(8);
      }
      expect(budget.inUse).toBe(32);
      await expect(
        groups[4].authority.connect(destination, { deadline: deadline() })
      ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
      expect(groups[4].resolve).not.toHaveBeenCalled();
    } finally {
      for (const group of groups) group.authority.revoke();
      await Promise.all(groups.map((group) => group.authority.closed));
    }
    expect(budget.inUse).toBe(0);
  });

  it.each(['policy', 'address', 'create', 'connect', 'verified'])(
    'cannot deliver or revive work after reentrant revocation in %s',
    async (phase) => {
      const revoke = () => h.authority.revoke(new EngineError('POLICY_DENIED', 'Owner revoked'));
      const policy = new NetworkPolicy();
      if (phase === 'policy') policy.checkRequest = async () => revoke();
      if (phase === 'address') policy.checkResolvedAddresses = async () => revoke();
      const h = harness({
        policy,
        created: phase === 'create' ? revoke : undefined,
        connect:
          phase === 'connect' || phase === 'verified'
            ? (socket) => {
                if (phase === 'verified') socket.emit('connect');
                revoke();
              }
            : undefined,
      });
      await expect(
        h.authority.connect(destination, { deadline: deadline() })
      ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await h.authority.closed;
      expect(h.dial).toHaveBeenCalledTimes(phase === 'connect' || phase === 'verified' ? 1 : 0);
      expect(h.sockets.every((socket) => socket.destroyed)).toBe(true);
      expect(h.budget.inUse).toBe(0);
    }
  );

  it('snapshots destination, deadline and cancellation identity before awaiting policy', async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const policy = new NetworkPolicy();
    policy.checkRequest = async () => {
      entered.resolve();
      await gate.promise;
    };
    const h = harness({ policy });
    const original = new AbortController();
    const replacement = new AbortController();
    const caller = { deadline: deadline(), signal: original.signal };
    const input = { ...destination };
    const pending = h.authority.connect(input, caller);
    await entered.promise;
    input.url = 'http://other.invalid:81/secret';
    input.hostname = 'other.invalid';
    input.port = 81;
    caller.deadline = 0;
    caller.signal = replacement.signal;
    gate.resolve();
    const lease = await pending;
    expect(lease.destination).toEqual(destination);
    replacement.abort();
    expect(lease.socket.destroyed).toBe(false);
    original.abort();
    await lease.closed;
    expect(lease.socket.destroyed).toBe(true);
    expect(h.budget.inUse).toBe(0);
    h.authority.revoke();
  });

  it('copies resolver-owned records before awaiting address policy', async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const records = [{ ...answer }];
    const policy = new NetworkPolicy();
    policy.checkResolvedAddresses = async () => {
      entered.resolve();
      await gate.promise;
    };
    const h = harness({ policy, resolve: async () => records });
    const pending = h.authority.connect(destination, { deadline: deadline() });
    await entered.promise;
    records[0].address = '93.184.216.34';
    records[0].family = 6;
    gate.resolve();
    const lease = await pending;
    expect(lease.endpoint).toEqual({ ...answer, port: 80 });
    lease.close();
    await lease.closed;
    h.authority.revoke();
  });

  it('requires the strict address gate before any callback', () => {
    const checkRequest = vi.fn(async () => {});
    expect(() => harness({ policy: { checkRequest } })).toThrowError(
      expect.objectContaining({ code: 'ENGINE_UNSUPPORTED' })
    );
    expect(checkRequest).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid resource limit %s',
    (limit) => {
      expect(() => new ConnectionBudget(limit)).toThrowError(
        expect.objectContaining({ code: 'INVALID_REQUEST' })
      );
      expect(() => harness({ maxConnections: limit })).toThrowError(
        expect.objectContaining({ code: 'INVALID_REQUEST' })
      );
    }
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    'rejects invalid setup timeout %s',
    (setupTimeoutMs) => {
      expect(() => harness({ setupTimeoutMs })).toThrowError(
        expect.objectContaining({ code: 'INVALID_REQUEST' })
      );
    }
  );

  it('owns independent same-URL leases until actual socket close', async () => {
    const h = harness({ maxConnections: 2 });
    const leases = await Promise.all([
      h.authority.connect(destination, { deadline: deadline() }),
      h.authority.connect(destination, { deadline: deadline() }),
    ]);
    expect(leases[0].id).not.toBe(leases[1].id);
    expect(h.resolve).toHaveBeenCalledTimes(2);
    expect(h.budget.inUse).toBe(2);
    await expect(h.authority.connect(destination, { deadline: deadline() })).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    expect(h.resolve).toHaveBeenCalledTimes(2);
    leases[0].close();
    leases[0].close();
    expect(h.budget.inUse).toBe(2);
    await leases[0].closed;
    expect(h.budget.inUse).toBe(1);
    h.authority.revoke();
    await h.authority.closed;
    expect(h.budget.inUse).toBe(0);
    expect(leases[1].socket.destroyed).toBe(true);
  });

  it.each(['policy', 'dns', 'address'] as const)(
    'retains shared admission after cancellation during %s across replacement authorities',
    async (phase) => {
      const gate = deferred<void>();
      const entered = deferred<void>();
      const wait = async () => {
        entered.resolve();
        await gate.promise;
      };
      const policy = new NetworkPolicy();
      if (phase === 'policy') policy.checkRequest = wait;
      if (phase === 'address') policy.checkResolvedAddresses = wait;
      const budget = new ConnectionBudget(1);
      const h = harness({
        budget,
        policy,
        resolve:
          phase === 'dns'
            ? async () => {
                await wait();
                return [answer];
              }
            : undefined,
      });
      const result = h.authority.connect(destination, { deadline: deadline() });
      const refused = expect(result).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await entered.promise;
      h.authority.revoke(new EngineError('POLICY_DENIED', 'Session revoked'));
      await refused;
      let drained = false;
      void h.authority.closed.then(() => {
        drained = true;
      });
      const next = harness({ budget });
      await expect(
        next.authority.connect(destination, { deadline: deadline() })
      ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
      expect(next.resolve).not.toHaveBeenCalled();
      expect(budget.inUse).toBe(1);
      expect(drained).toBe(false);
      gate.resolve();
      await h.authority.closed;
      expect(h.dial).not.toHaveBeenCalled();
      const lease = await next.authority.connect(destination, { deadline: deadline() });
      lease.close();
      await lease.closed;
      expect(budget.inUse).toBe(0);
      next.authority.revoke();
      await next.authority.closed;
    }
  );

  it('keeps a cancelled DNS reservation until a late rejection settles safely', async () => {
    const gate = deferred<Array<{ address: string; family: number }>>();
    const entered = deferred<void>();
    const h = harness({
      resolve: () => {
        entered.resolve();
        return gate.promise;
      },
    });
    const controller = new AbortController();
    const result = h.authority.connect(destination, {
      deadline: deadline(),
      signal: controller.signal,
    });
    const rejected = expect(result).rejects.toMatchObject({
      code: 'INTERNAL',
      details: { reason: 'callerCancelled' },
    });
    await entered.promise;
    controller.abort(new Error('secret cancellation text'));
    await rejected;
    expect(h.budget.inUse).toBe(1);
    h.authority.revoke();
    gate.reject(new Error('late DNS secret'));
    await h.authority.closed;
    expect(h.dial).not.toHaveBeenCalled();
    expect(h.budget.inUse).toBe(0);
  });

  it('rejects pre-aborted, expired and revoked requests before policy/DNS', async () => {
    const h = harness();
    await expect(
      h.authority.connect(destination, { deadline: deadline(), signal: AbortSignal.abort() })
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(
      h.authority.connect(destination, { deadline: performance.now() - 1 })
    ).rejects.toMatchObject({ code: 'ACTION_TIMEOUT' });
    h.authority.revoke(new EngineError('ENGINE_CRASHED', 'Owner closed'));
    await expect(h.authority.connect(destination, { deadline: deadline() })).rejects.toMatchObject({
      code: 'ENGINE_CRASHED',
    });
    await h.authority.closed;
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.budget.inUse).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE])(
    'rejects invalid absolute deadline %s before admission',
    async (value) => {
      const h = harness();
      await expect(h.authority.connect(destination, { deadline: value })).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
      expect(h.resolve).not.toHaveBeenCalled();
      expect(h.budget.inUse).toBe(0);
      h.authority.revoke();
      await h.authority.closed;
    }
  );

  it('destroys an in-progress connection and never delivers a late connect event', async () => {
    const entered = deferred<void>();
    const h = harness({ connect: () => entered.resolve() });
    const controller = new AbortController();
    const pending = h.authority.connect(destination, {
      deadline: deadline(),
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'INTERNAL' });
    await entered.promise;
    controller.abort();
    h.sockets[0].emit('connect');
    await rejected;
    h.authority.revoke();
    await h.authority.closed;
    expect(h.sockets[0].destroyed).toBe(true);
    expect(h.sockets[0].listenerCount('connect')).toBe(0);
    expect(h.sockets[0].listenerCount('error')).toBe(0);
    expect(h.budget.inUse).toBe(0);
  });

  it('retains typed policy refusal without raw callback messages or details', async () => {
    const policy = new NetworkPolicy();
    policy.checkRequest = async () => {
      throw new EngineError('POLICY_DENIED', 'secret credential', true, { token: 'secret' });
    };
    const h = harness({ policy });
    await expect(h.authority.connect(destination, { deadline: deadline() })).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      retryable: false,
      message: 'Connection failed',
      details: { stage: 'policy', reason: 'callbackFailure' },
    });
    expect(h.resolve).not.toHaveBeenCalled();
    h.authority.revoke();
    await h.authority.closed;
    expect(h.budget.inUse).toBe(0);
  });

  it('clears setup deadline after delivery but retains overall deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const h = harness({ setupTimeoutMs: 10 });
    const lease = await h.authority.connect(destination, { deadline: performance.now() + 100 });
    await vi.advanceTimersByTimeAsync(11);
    expect(lease.socket.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(90);
    expect(lease.signal.reason).toMatchObject({ code: 'ACTION_TIMEOUT' });
    await lease.closed;
    expect(h.budget.inUse).toBe(0);
    h.authority.revoke();
  });

  it('retains timed-out pending work and forbids late dial', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const gate = deferred<Array<{ address: string; family: number }>>();
    const h = harness({ setupTimeoutMs: 10, resolve: () => gate.promise });
    const result = h.authority.connect(destination, { deadline: performance.now() + 100 });
    const rejected = expect(result).rejects.toMatchObject({ code: 'ACTION_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(11);
    await rejected;
    expect(h.budget.inUse).toBe(1);
    h.authority.revoke();
    gate.resolve([answer]);
    await h.authority.closed;
    expect(h.dial).not.toHaveBeenCalled();
  });
});

describe('connection authority destination, DNS and peer', () => {
  it.each([
    { ...destination, url: 'ftp://download.invalid/file' },
    { ...destination, url: 'http://secret:password@download.invalid/file' },
    { ...destination, hostname: 'other.invalid' },
    { ...destination, port: 81 },
    { ...destination, port: 0 },
    { ...destination, url: 'http://[fe80::1%en0]/' },
    { url: 'http://[::1]/', hostname: '[::1', port: 80 },
    { url: 'http://[::1]/', hostname: '::1]', port: 80 },
    { url: 'http://127.0.0.1/', hostname: '[127.0.0.1]', port: 80 },
  ])('denies invalid destination before DNS: $url $hostname $port', async (input) => {
    const h = harness();
    await expect(
      h.authority.connect({ ...input, kind: 'request' }, { deadline: deadline() })
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.dial).not.toHaveBeenCalled();
    h.authority.revoke();
    await h.authority.closed;
  });

  it.each([
    [],
    [{ address: 'not-an-ip', family: 4 }],
    [answer, { address: '::1', family: 4 }],
    [answer, { address: 'fe80::1%en0', family: 6 }],
    [answer, { address: '[::1]', family: 6 }],
    Array.from({ length: 17 }, () => answer),
  ])('rejects malformed/excessive complete DNS set %# without dialing', async (addresses) => {
    const h = harness({ resolve: async () => addresses });
    await expect(h.authority.connect(destination, { deadline: deadline() })).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    h.authority.revoke();
    await h.authority.closed;
    expect(h.dial).not.toHaveBeenCalled();
  });

  it('rechecks changed DNS answers and rejects a mixed set before any dial', async () => {
    const h = harness({ policy: strict(), peer: '93.184.216.34' });
    h.resolve.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const lease = await h.authority.connect(destination, { deadline: deadline() });
    lease.close();
    await lease.closed;
    h.resolve.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '::ffff:127.0.0.1', family: 6 },
    ]);
    await expect(h.authority.connect(destination, { deadline: deadline() })).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    expect(h.dial).toHaveBeenCalledTimes(1);
    h.authority.revoke();
    await h.authority.closed;
  });

  it('skips DNS for literals, verifies equivalent mapped peers and dials once without fallback', async () => {
    const h = harness();
    const lease = await h.authority.connect(
      { kind: 'request', url: 'http://127.0.0.1/', hostname: '127.0.0.1', port: 80 },
      { deadline: deadline() }
    );
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.dial).toHaveBeenCalledTimes(1);
    expect(h.dial).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 80,
      family: 4,
      autoSelectFamily: false,
    });
    expect(Object.isFrozen(lease.destination)).toBe(true);
    expect(Object.isFrozen(lease.endpoint)).toBe(true);
    lease.close();
    await lease.closed;
    h.authority.revoke();
  });

  it.each([{ peer: '127.0.0.2' }, { port: 81 }, { peer: 'not-an-ip' }])(
    'destroys mismatched peer %# before lease delivery',
    async (options) => {
      const h = harness(options);
      await expect(
        h.authority.connect(destination, { deadline: deadline() })
      ).rejects.toMatchObject({ code: 'POLICY_DENIED', details: { reason: 'peerMismatch' } });
      h.authority.revoke();
      await h.authority.closed;
      expect(h.sockets[0].destroyed).toBe(true);
      expect(h.budget.inUse).toBe(0);
    }
  );

  it('handles synchronous socket errors with listeners already owned, without retry or leaking raw text', async () => {
    const h = harness({
      connect: (socket) => socket.emit('error', new Error('connection closed secret token')),
    });
    await expect(h.authority.connect(destination, { deadline: deadline() })).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'Connection failed',
      details: { stage: 'tcp', reason: 'transportFailure' },
    });
    h.authority.revoke();
    await h.authority.closed;
    expect(h.dial).toHaveBeenCalledTimes(1);
  });
});
