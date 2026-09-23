import { afterEach, expect, it, vi } from 'vitest';
import {
  SessionAuthority,
  type SessionPublication,
  type SessionPublicationContext,
} from './session-authority.js';

const operator = { actor: 'operator' as const, tenant: 'owner' };
function fixture(options: { now?: () => number; ttlMs?: number } = {}) {
  const authority = new SessionAuthority(options);
  authority.register('s', 'owner', new AbortController().signal, options);
  const control = authority.get('s')!;
  return { authority, control };
}
const operation = { id: 'write', fingerprint: 'a' };
afterEach(() => vi.useRealTimers());

it('publishes a finalized result with output-only authority while retaining its ticket', async () => {
  const { authority, control } = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let outputGuard!: () => void;
  let oldReadGuard!: () => void;
  const publish = vi.fn(async (value: string, context: SessionPublicationContext) => {
    expect(value).toBe('result');
    expect(context.status).toBe('completed');
    expect(Object.isFrozen(context)).toBe(true);
    outputGuard = context.assertCurrent;
    context.assertCurrent();
    expect(control.view()).toMatchObject({ busy: true, operation: { status: 'completed' } });
    expect(() => authority.assert('s')).toThrow();
    expect(() => authority.trackReadInScope('s', () => 1)).toThrow();
    expect(() => authority.dispatchInScope('s', () => 1)).toThrow();
    expect(oldReadGuard).toThrow();
    entered.resolve();
    await release.promise;
    context.assertCurrent();
  });
  const run = authority.run(
    's',
    operator,
    operation,
    async () => {
      oldReadGuard = authority.outputGuard('s');
      await authority.dispatchInScope('s', () => 1);
      return 'result';
    },
    undefined,
    { timeoutMs: 1000, publish }
  );
  await entered.promise;
  await expect(authority.run('s', operator, {}, async () => 0)).rejects.toThrow('busy');
  const duplicatePublish = vi.fn();
  expect(
    await authority.run('s', operator, operation, async () => 'wrong', undefined, {
      timeoutMs: 1000,
      publish: duplicatePublish,
    })
  ).toMatchObject({ replay: true, operation: { status: 'completed' } });
  expect(duplicatePublish).not.toHaveBeenCalled();
  outputGuard();
  release.resolve();
  expect(await run).toBe('result');
  expect(control.view().busy).toBe(false);
  expect(outputGuard).toThrow();
  expect(publish).toHaveBeenCalledTimes(1);
});

it('waits for existing drain before starting the publication deadline and exposes unknown execution', async () => {
  vi.useFakeTimers();
  const { authority, control } = fixture();
  const release = Promise.withResolvers<void>();
  const publish = vi.fn((_value: string, context: SessionPublicationContext) => {
    expect(context.status).toBe('outcome_unknown');
  });
  const run = authority.run(
    's',
    operator,
    operation,
    async () => {
      void authority.dispatchInScope('s', () => release.promise);
      return 'draft';
    },
    undefined,
    { timeoutMs: 20, publish }
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(control.view()).toMatchObject({ busy: true, operation: { status: 'in_flight' } });
  expect(publish).not.toHaveBeenCalled();
  release.resolve();
  expect(await run).toBe('draft');
  expect(publish).toHaveBeenCalledTimes(1);
  expect(control.operation('write')?.status).toBe('outcome_unknown');
});

it('preserves finalized execution when a publisher rejects', async () => {
  const { authority, control } = fixture();
  await expect(
    authority.run('s', operator, operation, async () => 'done', undefined, {
      timeoutMs: 1000,
      publish: () => {
        throw new Error('delivery failed');
      },
    })
  ).rejects.toThrow('delivery failed');
  expect(control.operation('write')?.status).toBe('completed');
  expect(control.view().busy).toBe(false);
});

it.each(['timeout', 'cancel'] as const)(
  'revokes %s publication before release and consumes late rejection',
  async (reason) => {
    vi.useFakeTimers();
    const { authority, control } = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const abort = new AbortController();
    let guard!: () => void;
    let signal!: AbortSignal;
    const run = authority.run('s', operator, operation, async () => 'done', undefined, {
      timeoutMs: 10,
      signal: abort.signal,
      publish: async (_value, context) => {
        guard = context.assertCurrent;
        signal = context.signal;
        entered.resolve();
        await release.promise;
        context.assertCurrent();
        throw new Error('late rejection');
      },
    });
    const rejected = expect(run).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
    await entered.promise;
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(11);
    else abort.abort();
    await rejected;
    expect(guard).toThrow();
    expect(signal.aborted).toBe(true);
    expect(control.operation('write')?.status).toBe('completed');
    expect(control.view().busy).toBe(false);
    const nextRelease = Promise.withResolvers<void>();
    const next = authority.run('s', operator, {}, () => nextRelease.promise);
    release.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(control.view().busy).toBe(true);
    nextRelease.resolve();
    await next;
  }
);

it.each(['takeover', 'replacement', 'expiry', 'deadline'] as const)(
  'withholds output after %s even if the publication timer has not fired',
  async (change) => {
    let now = 0;
    const { authority, control } = fixture({ now: () => now, ttlMs: 100 });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const sent = vi.fn();
    const run = authority.run('s', operator, operation, async () => 'private', undefined, {
      timeoutMs: 50,
      publish: async (value, context) => {
        entered.resolve();
        await release.promise;
        context.assertCurrent();
        sent(value);
      },
    });
    const rejected = expect(run).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
    await entered.promise;
    if (change === 'takeover') authority.takeover('s');
    else if (change === 'replacement') {
      authority.remove('s');
      authority.register('s', 'owner', new AbortController().signal);
    } else now = change === 'expiry' ? 100 : 50;
    release.resolve();
    await rejected;
    expect(sent).not.toHaveBeenCalled();
    expect(control.operation('write')?.status).toBe('completed');
    expect(control.view().busy).toBe(false);
  }
);

it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 60001])(
  'rejects publication timeout %s before reserving identity or running work',
  async (timeoutMs) => {
    const { authority, control } = fixture();
    const work = vi.fn(async () => 'done');
    await expect(
      authority.run('s', operator, operation, work, undefined, { timeoutMs, publish: () => {} })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(work).not.toHaveBeenCalled();
    expect(control.operation('write')).toBeUndefined();
    expect(control.view().busy).toBe(false);
  }
);

it('validates and snapshots publisher options before business callbacks can mutate them', async () => {
  const { authority, control } = fixture();
  const work = vi.fn(async () => 'done');
  await expect(
    authority.run('s', operator, operation, work, undefined, {
      timeoutMs: 10,
      publish: null,
    } as unknown as SessionPublication<string>)
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(work).not.toHaveBeenCalled();
  const publish = vi.fn();
  const options = { timeoutMs: 1000, publish };
  expect(
    await authority.run(
      's',
      operator,
      operation,
      async () => {
        options.timeoutMs = 0;
        options.publish = vi.fn(() => {
          throw new Error('mutated');
        });
        return 'done';
      },
      undefined,
      options
    )
  ).toBe('done');
  expect(publish).toHaveBeenCalledTimes(1);
  expect(control.operation('write')?.status).toBe('completed');
});

it.each(['before-work', 'scheduling-gap'] as const)(
  'cancels only publication (%s), preserving the completed work',
  async (when) => {
    const { authority, control } = fixture();
    const abort = new AbortController();
    const publish = vi.fn();
    const work = vi.fn(async () => 'done');
    if (when === 'before-work') abort.abort();
    const run = authority.run(
      's',
      operator,
      operation,
      work,
      () => {
        if (when === 'scheduling-gap') queueMicrotask(() => abort.abort());
        return false;
      },
      { timeoutMs: 1000, signal: abort.signal, publish }
    );
    await expect(run).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
    expect(work).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    expect(control.operation('write')?.status).toBe('completed');
  }
);

it('preserves a thrown undefined work error and drains before releasing without publication', async () => {
  const { authority, control } = fixture();
  const release = Promise.withResolvers<void>();
  const publish = vi.fn();
  const run = authority.run(
    's',
    operator,
    operation,
    async () => {
      void authority.dispatchInScope('s', () => release.promise);
      throw undefined;
    },
    undefined,
    { timeoutMs: 1000, publish }
  );
  const rejected = expect(run).rejects.toBeUndefined();
  await new Promise((resolve) => setImmediate(resolve));
  expect(control.view().busy).toBe(true);
  expect(publish).not.toHaveBeenCalled();
  release.resolve();
  await rejected;
  expect(control.operation('write')?.status).toBe('outcome_unknown');
  expect(control.view().busy).toBe(false);
});

it('retains anonymous read admission through publication without inventing an operation record', async () => {
  const { authority, control } = fixture();
  let guard!: () => void;
  expect(
    await authority.run('s', operator, {}, async () => 42, undefined, {
      timeoutMs: 1000,
      publish: (_value, context) => {
        guard = context.assertCurrent;
        context.assertCurrent();
        expect(context.status).toBe('completed');
        expect(control.view()).toMatchObject({ busy: true });
        expect(control.view().operation).toBeUndefined();
      },
    })
  ).toBe(42);
  expect(control.view().busy).toBe(false);
  expect(guard).toThrow();
});

it('does not let publication cancellation release an abandoned effect that is still draining', async () => {
  const { authority, control } = fixture();
  const release = Promise.withResolvers<void>();
  const abort = new AbortController();
  const publish = vi.fn();
  const run = authority.run(
    's',
    operator,
    operation,
    async () => {
      void authority.dispatchInScope('s', () => release.promise);
      return 'draft';
    },
    undefined,
    { timeoutMs: 1000, signal: abort.signal, publish }
  );
  const rejected = expect(run).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  await new Promise((resolve) => setImmediate(resolve));
  expect(control.view()).toMatchObject({ busy: true, operation: { status: 'in_flight' } });
  expect(publish).not.toHaveBeenCalled();
  release.resolve();
  await rejected;
  expect(control.operation('write')?.status).toBe('outcome_unknown');
  expect(control.view().busy).toBe(false);
});

it('checks owner again after a publisher returns without calling its guard', async () => {
  const { authority, control } = fixture();
  await expect(
    authority.run('s', operator, operation, async () => 'done', undefined, {
      timeoutMs: 1000,
      publish: () => {
        authority.takeover('s');
      },
    })
  ).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
  expect(control.operation('write')?.status).toBe('completed');
  expect(control.view()).toMatchObject({ state: 'HUMAN_ACTIVE', busy: false });
});

it('refuses a malformed cancellation signal before invoking work', async () => {
  const { authority, control } = fixture();
  const work = vi.fn(async () => 42);
  await expect(
    authority.run('s', operator, operation, work, undefined, {
      timeoutMs: 1000,
      publish: () => {},
      signal: {} as AbortSignal,
    })
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(work).not.toHaveBeenCalled();
  expect(control.operation('write')).toBeUndefined();
});
