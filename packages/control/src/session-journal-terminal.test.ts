import { afterEach, expect, it, vi } from 'vitest';
import { createControllableJournalFixture } from './journal-authority.test-support.js';
import { SessionAuthority } from './session-authority.js';

const principal = { actor: 'operator' as const, tenant: 'owner' };
const operation = {
  id: 'write',
  fingerprint: 'private-input-digest',
  journal: {
    version: 1 as const,
    application: {
      adapterId: 'app',
      resourceId: 'resource',
      bindingGeneration: 'binding',
    },
  },
};
afterEach(() => vi.useRealTimers());
async function fixture() {
  const { memory, controlled, journal } = await createControllableJournalFixture();
  const authority = new SessionAuthority({ journal, now: memory.now });
  authority.register('session', 'owner', new AbortController().signal, { ttlMs: 1000 });
  const effect = vi.fn(() => 'result');
  const execute = () =>
    authority.dispatchInScope(
      'session',
      effect,
      authority.captureApplicationDispatchInScope('session', () => {})
    );
  const stored = () => memory.observe(journal.namespace.namespaceId)?.records[0];
  const replay = () =>
    authority.run('session', principal, operation, async () => {
      throw new Error('duplicate executed');
    });
  return { memory, controlled, journal, authority, effect, execute, stored, replay };
}

it('holds original output behind terminal ACK while duplicates see only acknowledged marker', async () => {
  const f = await fixture();
  const held = f.controlled.holdNext('commitTerminal', 'after_commit');
  const publish = vi.fn();
  const running = f.authority.run('session', principal, operation, f.execute, () => false, {
    timeoutMs: 100,
    publish,
  });
  await held.committed;
  expect(f.stored()).toMatchObject({ revision: 3, terminal: { status: 'completed' } });
  expect(publish).not.toHaveBeenCalled();
  expect(f.authority.get('session')?.operation('write')).toMatchObject({ status: 'completed' });
  expect(await f.replay()).toMatchObject({
    replay: true,
    operation: { status: 'in_flight', dispatched: true },
  });
  held.release();
  expect(await running).toBe('result');
  expect(publish).toHaveBeenCalledOnce();
  expect(await f.replay()).toMatchObject({
    replay: true,
    operation: { status: 'completed', dispatched: true },
  });
  expect(f.effect).toHaveBeenCalledOnce();
  expect(f.controlled.calls.commitTerminal).toBe(1);
});

it.each(['reserveIntent', 'markDispatch'] as const)(
  'bounds replay by the last ACK during %s',
  async (phase) => {
    const f = await fixture();
    const held = f.controlled.holdNext(phase, 'after_commit');
    const running = f.authority.run('session', principal, operation, f.execute);
    await held.committed;
    const publish = vi.fn();
    const lookup = () =>
      f.authority.publishOperation('session', principal, 'write', { timeoutMs: 100, publish });
    if (phase === 'reserveIntent') {
      await expect(f.replay()).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
      await expect(lookup()).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
      expect(publish).not.toHaveBeenCalled();
    } else {
      expect(await f.replay()).toMatchObject({
        replay: true,
        operation: { status: 'in_flight', dispatched: false },
      });
      expect(await lookup()).toMatchObject({ status: 'in_flight', dispatched: false });
      expect(publish).toHaveBeenCalledOnce();
    }
    expect(f.effect).not.toHaveBeenCalled();
    held.release();
    await running;
    expect(f.effect).toHaveBeenCalledOnce();
  }
);

it.each(['before_write', 'after_commit'] as const)(
  'terminal %s timeout retains ticket and never upgrades late ACK',
  async (phase) => {
    vi.useFakeTimers();
    const f = await fixture();
    const held = f.controlled.holdNext('commitTerminal', phase);
    const publish = vi.fn();
    const running = f.authority
      .run('session', principal, operation, f.execute, () => false, { timeoutMs: 100, publish })
      .catch((error) => error);
    await (phase === 'after_commit' ? held.committed : held.started);
    await vi.advanceTimersByTimeAsync(26);
    expect(await running).toMatchObject({ code: 'CONTROL_REQUIRED' });
    expect(f.authority.status('session').busy).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    expect(await f.replay()).toMatchObject({
      operation: { status: 'in_flight', dispatched: true },
    });
    held.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.authority.status('session').busy).toBe(false);
    expect(await f.replay()).toMatchObject({
      operation: { status: 'in_flight', dispatched: true },
    });
    expect(f.effect).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  }
);

it.each(['before_write', 'after_commit', 'never_settles'] as const)(
  'terminal %s failure withholds success and preserves last acknowledged fact',
  async (phase) => {
    vi.useFakeTimers();
    const f = await fixture();
    f.memory.failNext('commitTerminal', phase);
    const running = f.authority
      .run('session', principal, operation, f.execute)
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(26);
    expect(await running).toMatchObject({ code: 'CONTROL_REQUIRED' });
    expect(await f.replay()).toMatchObject({
      operation: { status: 'in_flight', dispatched: true },
    });
    expect(f.authority.status('session').busy).toBe(phase === 'never_settles');
    expect(f.stored()?.revision).toBe(phase === 'after_commit' ? 3 : 2);
    expect(f.effect).toHaveBeenCalledOnce();
  }
);

it('refuses success without dispatch and terminalizes the undispatched intent as failed', async () => {
  const f = await fixture();
  await expect(
    f.authority.run('session', principal, operation, async () => 'unsupported')
  ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
  expect(f.stored()).toMatchObject({
    revision: 2,
    dispatched: false,
    terminal: { status: 'failed' },
  });
  expect(await f.replay()).toMatchObject({ operation: { status: 'failed', dispatched: false } });
});

it('records marker-backed failure even if the final application guard prevents the physical effect', async () => {
  const f = await fixture();
  await expect(
    f.authority.run('session', principal, operation, () =>
      f.authority.dispatchInScope(
        'session',
        f.effect,
        f.authority.captureApplicationDispatchInScope('session', () => {
          throw new Error('revoked');
        })
      )
    )
  ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
  expect(f.effect).not.toHaveBeenCalled();
  expect(f.stored()).toMatchObject({
    revision: 3,
    dispatched: true,
    terminal: { status: 'failed' },
  });
  expect(f.authority.get('session')?.operation('write')).toMatchObject({
    dispatched: false,
    status: 'failed',
  });
  expect(await f.replay()).toMatchObject({ operation: { dispatched: true, status: 'failed' } });
});

it('preserves terminal facts when publication fails and permits acknowledged replay after journal close', async () => {
  const f = await fixture();
  await expect(
    f.authority.run('session', principal, operation, f.execute, () => false, {
      timeoutMs: 100,
      publish() {
        throw new Error('send failed');
      },
    })
  ).rejects.toThrow('send failed');
  await f.journal.close();
  const publish = vi.fn();
  expect(
    await f.authority.publishOperation('session', principal, 'write', { timeoutMs: 100, publish })
  ).toMatchObject({ status: 'completed', dispatched: true });
  expect(await f.replay()).toMatchObject({ operation: { status: 'completed' } });
  expect(f.effect).toHaveBeenCalledOnce();
});

it('cannot downgrade a journal duplicate to the ephemeral replay path', async () => {
  const f = await fixture();
  await f.authority.run('session', principal, operation, f.execute);
  await expect(
    f.authority.run(
      'session',
      principal,
      { id: operation.id, fingerprint: operation.fingerprint },
      f.execute
    )
  ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  expect(f.effect).toHaveBeenCalledOnce();
});

it.each(['takeover', 'replacement', 'expiry'] as const)(
  'retains old terminal facts but suppresses output after %s during terminal wait',
  async (change) => {
    const f = await fixture();
    const held = f.controlled.holdNext('commitTerminal', 'after_commit');
    const old = f.authority.get('session');
    const publish = vi.fn();
    const running = f.authority
      .run('session', principal, operation, f.execute, () => false, { timeoutMs: 100, publish })
      .catch((error) => error);
    await held.committed;
    const replacement = Promise.withResolvers<void>();
    let next: Promise<unknown> | undefined;
    if (change === 'takeover') f.authority.takeover('session');
    else if (change === 'expiry') {
      f.memory.advance(1000);
      expect(f.authority.get('session')).toBeUndefined();
    } else {
      f.authority.remove('session');
      f.authority.register('session', 'owner', new AbortController().signal);
      next = f.authority.run('session', principal, {}, () => replacement.promise);
    }
    held.release();
    expect(await running).toBeInstanceOf(Error);
    expect(publish).not.toHaveBeenCalled();
    expect(old?.publicationOperation('write')).toMatchObject({ status: 'completed' });
    if (change === 'replacement') {
      expect(f.authority.get('session')?.operation('write')).toBeUndefined();
      expect(f.authority.status('session').busy).toBe(true);
      replacement.resolve();
      await next;
    }
  }
);

it('does not treat an already-applied terminal response as a fresh success acknowledgment', async () => {
  const f = await fixture();
  f.controlled.rewriteNextDisposition('commitTerminal', 'already_applied');
  await expect(f.authority.run('session', principal, operation, f.execute)).rejects.toMatchObject({
    code: 'CONTROL_REQUIRED',
  });
  expect(f.stored()).toMatchObject({ revision: 3, terminal: { status: 'completed' } });
  expect(await f.replay()).toMatchObject({ operation: { status: 'in_flight', dispatched: true } });
  expect(f.effect).toHaveBeenCalledOnce();
});

it.each(['rejected', 'throw'] as const)(
  'persists conservative terminal classification for %s effects',
  async (kind) => {
    const f = await fixture();
    if (kind === 'throw')
      f.effect.mockImplementation(() => {
        throw new Error('effect failed');
      });
    const result = f.authority.run('session', principal, operation, f.execute, () =>
      kind === 'rejected' ? 'rejected' : false
    );
    if (kind === 'throw') await expect(result).rejects.toThrow('effect failed');
    else await result;
    expect(f.stored()).toMatchObject({
      revision: 3,
      dispatched: true,
      terminal: { status: kind === 'throw' ? 'outcome_unknown' : 'failed' },
    });
    expect(await f.replay()).toMatchObject({
      operation: { dispatched: true, status: kind === 'throw' ? 'outcome_unknown' : 'failed' },
    });
  }
);

it('refuses optimistic output when the callback abandons an unresolved physical effect', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  const effect = Promise.withResolvers<string>();
  const publish = vi.fn();
  const running = f.authority
    .run(
      'session',
      principal,
      operation,
      async () => {
        void f.authority.dispatchInScope(
          'session',
          () => {
            started.resolve();
            return effect.promise;
          },
          f.authority.captureApplicationDispatchInScope('session', () => {})
        );
        await started.promise;
        return 'optimistic-result';
      },
      () => false,
      { timeoutMs: 100, publish }
    )
    .catch((error) => error);
  await started.promise;
  await vi.advanceTimersByTimeAsync(0);
  expect(f.controlled.calls.commitTerminal).toBe(0);
  effect.resolve('effect-settled');
  expect(await running).toMatchObject({ code: 'CONTROL_REQUIRED' });
  expect(publish).not.toHaveBeenCalled();
  expect(f.stored()).toMatchObject({ terminal: { status: 'outcome_unknown' } });
});

it('does not lend a nested replay guard the original execution scope', async () => {
  const f = await fixture();
  const guard = vi.fn(() => {
    expect(() => f.authority.assert('session')).toThrow();
  });
  await f.authority.run('session', principal, operation, async () => {
    await f.execute();
    const replay = await f.authority.run(
      'session',
      principal,
      operation,
      async () => 'forbidden',
      undefined,
      undefined,
      undefined,
      guard
    );
    expect(replay).toMatchObject({ replay: true, operation: { status: 'in_flight' } });
    return 'done';
  });
  expect(guard).toHaveBeenCalledOnce();
  expect(f.effect).toHaveBeenCalledOnce();
});
