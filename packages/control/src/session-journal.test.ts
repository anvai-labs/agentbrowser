import type { EnginePage } from '@agentbrowser/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControllableJournalFixture, namespace } from './journal-authority.test-support.js';
import type { OperationJournal } from './journal-types.js';
import { SessionAuthority, type SessionPrincipal } from './session-authority.js';

const operator: SessionPrincipal = { actor: 'operator', tenant: 'owner' };
const application = Object.freeze({
  adapterId: 'fixture-adapter',
  resourceId: 'fixture-resource',
  bindingGeneration: 'fixture-binding-1',
});
const privateFingerprint = 'PRIVATE-LIVE-APPLICATION-FINGERPRINT';
const journalOperation = (id = 'application-write') => ({
  id,
  fingerprint: privateFingerprint,
  journal: { version: 1 as const, application },
});

async function fixture(options: { authorityTtlMs?: number } = {}) {
  const { memory, controlled, journal } = await createControllableJournalFixture();
  const authority = new SessionAuthority({ now: memory.now, journal });
  const lifetime = new AbortController();
  authority.register(
    'session',
    'owner',
    lifetime.signal,
    options.authorityTtlMs === undefined ? {} : { ttlMs: options.authorityTtlMs }
  );
  return { memory, controlled, journal, authority, lifetime };
}

function record(
  journal: OperationJournal,
  observed: Awaited<ReturnType<typeof fixture>>['memory']
) {
  return observed.observe(journal.namespace.namespaceId)?.records[0];
}

function changeAuthorityDuringWait(
  f: Awaited<ReturnType<typeof fixture>>,
  change: 'takeover' | 'expiry' | 'replacement'
) {
  if (change === 'takeover') f.authority.takeover('session');
  else if (change === 'expiry') {
    f.memory.advance(1);
    expect(f.authority.get('session')).toBeUndefined();
  } else {
    f.authority.remove('session');
    f.authority.register('session', 'owner', new AbortController().signal);
  }
}

afterEach(() => vi.useRealTimers());

describe('journal intent admission', () => {
  it('holds the sole live ticket and business callback behind the applied intent ACK', async () => {
    const f = await fixture();
    const held = f.controlled.holdNext('reserveIntent', 'before_write');
    const callback = vi.fn(async () => 'done');
    const running = f.authority.run('session', operator, journalOperation(), callback);

    await held.started;
    expect(callback).not.toHaveBeenCalled();
    expect(f.authority.status('session')).toMatchObject({
      busy: true,
      operation: { status: 'in_flight', dispatched: false },
    });
    expect(record(f.journal, f.memory)).toBeUndefined();

    held.release();
    await expect(running).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(record(f.journal, f.memory)).toMatchObject({
      revision: 2,
      dispatched: false,
      terminal: { status: 'failed' },
    });
  });

  it.each(['late-ack', 'ack-lost'] as const)(
    'keeps an ignored %s intent result on the original drain after bounded timeout',
    async (result) => {
      vi.useFakeTimers();
      const f = await fixture();
      if (result === 'ack-lost') f.memory.failNext('reserveIntent', 'after_commit');
      const held = f.controlled.holdNext('reserveIntent', 'after_commit');
      const callback = vi.fn(async () => 'forbidden');
      const oldControl = f.authority.get('session');
      if (!oldControl) throw new Error('missing original control fixture');
      const running = f.authority
        .run('session', operator, journalOperation('late-intent'), callback)
        .catch((error) => error);

      await held.committed;
      expect(record(f.journal, f.memory)).toMatchObject({ revision: 1, dispatched: false });
      await vi.advanceTimersByTimeAsync(26);
      expect(await running).toBeInstanceOf(Error);
      expect(callback).not.toHaveBeenCalled();
      expect(f.journal.health).toBe('quarantined');
      expect(f.authority.status('session')).toMatchObject({
        busy: true,
        operation: { status: 'failed', dispatched: false },
      });

      f.authority.remove('session');
      const replacementLifetime = new AbortController();
      f.authority.register('session', 'owner', replacementLifetime.signal);
      const replacementRelease = Promise.withResolvers<void>();
      const replacement = f.authority.run(
        'session',
        operator,
        {},
        () => replacementRelease.promise
      );
      expect(f.authority.status('session').busy).toBe(true);
      held.release();
      await vi.waitFor(() => expect(oldControl.view().busy).toBe(false));
      expect(f.authority.status('session').busy).toBe(true);
      expect(oldControl.operation('late-intent')).toMatchObject({
        status: 'failed',
        dispatched: false,
      });
      expect(callback).not.toHaveBeenCalled();
      replacementRelease.resolve();
      await replacement;
    }
  );

  it('deduplicates against the existing live ticket without a second reserve or callback', async () => {
    const f = await fixture();
    const held = f.controlled.holdNext('reserveIntent', 'before_write');
    const first = vi.fn(async () => 'first');
    const duplicate = vi.fn(async () => 'duplicate');
    const running = f.authority.run('session', operator, journalOperation('same-id'), first);
    await held.started;

    await expect(
      f.authority.run('session', operator, journalOperation('same-id'), duplicate)
    ).rejects.toBeInstanceOf(Error);
    expect(f.controlled.calls.reserveIntent).toBe(1);
    expect(duplicate).not.toHaveBeenCalled();

    held.release();
    await expect(running).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
    expect(first).toHaveBeenCalledTimes(1);
    await expect(
      f.authority.run('session', operator, journalOperation('same-id'), duplicate)
    ).resolves.toMatchObject({ replay: true, operation: { status: 'failed', dispatched: false } });
    expect(f.controlled.calls.reserveIntent).toBe(1);
    expect(duplicate).not.toHaveBeenCalled();
  });

  it('refuses a facade-valid existing intent ACK without rerunning or retrying', async () => {
    const f = await fixture();
    f.controlled.rewriteNextDisposition('reserveIntent', 'existing');
    const callback = vi.fn(async () => 'forbidden');
    const result = await f.authority
      .run('session', operator, journalOperation('existing-intent'), callback)
      .catch((error) => error);
    expect(result).toBeInstanceOf(Error);
    expect(callback).not.toHaveBeenCalled();
    expect(f.controlled.calls.reserveIntent).toBe(1);
    expect(record(f.journal, f.memory)).toMatchObject({ revision: 1, dispatched: false });
    expect(f.authority.get('session')?.operation('existing-intent')).toMatchObject({
      status: 'failed',
      dispatched: false,
    });
  });

  it('stores bound application identity but never the private live fingerprint', async () => {
    const f = await fixture();
    await expect(
      f.authority.run('session', operator, journalOperation('private-input'), async () => 1)
    ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
    const stored = record(f.journal, f.memory);
    expect(stored?.identity.application).toEqual(application);
    expect(stored?.identity.key).toMatchObject({
      tenantId: 'owner',
      operationId: 'private-input',
    });
    expect(stored?.identity.fingerprint).toMatchObject({
      version: 1,
      keyId: 'test-key-1',
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(stored)).not.toContain(privateFingerprint);
  });

  it('detaches mutable journal selection metadata before storage starts', async () => {
    const f = await fixture();
    const held = f.controlled.holdNext('reserveIntent', 'before_write');
    const mutable = {
      adapterId: 'original-adapter',
      resourceId: 'original-resource',
      bindingGeneration: 'original-binding',
    };
    const operation = {
      id: 'detached-selection',
      fingerprint: 'original-private-fingerprint',
      journal: { version: 1 as const, application: mutable },
    };
    const running = f.authority.run('session', operator, operation, async () => 1);
    mutable.adapterId = 'mutated-adapter';
    mutable.resourceId = 'mutated-resource';
    mutable.bindingGeneration = 'mutated-binding';
    operation.fingerprint = 'mutated-private-fingerprint';

    await held.started;
    held.release();
    await expect(running).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
    expect(record(f.journal, f.memory)?.identity.application).toEqual({
      adapterId: 'original-adapter',
      resourceId: 'original-resource',
      bindingGeneration: 'original-binding',
    });
    expect(JSON.stringify(record(f.journal, f.memory))).not.toMatch(/mutated|original-private/);
  });

  it.each(['takeover', 'expiry', 'replacement'] as const)(
    'does not invoke the callback when %s changes authority during the intent wait',
    async (change) => {
      const f = await fixture(change === 'expiry' ? { authorityTtlMs: 1 } : {});
      const held = f.controlled.holdNext('reserveIntent', 'before_write');
      const callback = vi.fn(async () => 'forbidden');
      const running = f.authority
        .run('session', operator, journalOperation(`intent-${change}`), callback)
        .catch((error) => error);
      await held.started;
      changeAuthorityDuringWait(f, change);
      held.release();
      expect(await running).toBeInstanceOf(Error);
      expect(callback).not.toHaveBeenCalled();
      expect(record(f.journal, f.memory)).toMatchObject({
        revision: 2,
        dispatched: false,
        terminal: { status: 'failed' },
      });
    }
  );

  it.each(['publication', 'replay-publication'] as const)(
    'withholds %s when no qualified effect was dispatched',
    async (kind) => {
      const f = await fixture();
      const callback = vi.fn(async () => 'private-result');
      const publish = vi.fn();
      const publication = { timeoutMs: 100, publish };
      await expect(
        f.authority.run(
          'session',
          operator,
          journalOperation(`published-${kind}`),
          callback,
          undefined,
          kind === 'publication' ? publication : undefined,
          kind === 'replay-publication' ? publication : undefined
        )
      ).rejects.toBeInstanceOf(Error);
      expect(f.controlled.calls.reserveIntent).toBe(1);
      expect(callback).toHaveBeenCalledOnce();
      expect(publish).not.toHaveBeenCalled();
    }
  );
});

describe('journal dispatch marker and exact application qualification', () => {
  it('refuses to mint application qualification in an ephemeral scope', async () => {
    const authority = new SessionAuthority();
    authority.register('session', 'owner', new AbortController().signal);
    await authority.run('session', operator, {}, async () => {
      expect(() =>
        authority.captureApplicationDispatchInScope('session', () => undefined)
      ).toThrow();
    });
  });

  it('keeps local dispatch false until the marker ACK and invokes with no retry', async () => {
    const f = await fixture();
    const held = f.controlled.holdNext('markDispatch', 'before_write');
    const effect = vi.fn(() => 'effect');
    const running = f.authority.run(
      'session',
      operator,
      journalOperation('marker-wait'),
      async () => {
        const qualification = f.authority.captureApplicationDispatchInScope(
          'session',
          () => undefined
        );
        return f.authority.dispatchInScope('session', effect, qualification);
      }
    );

    await held.started;
    expect(effect).not.toHaveBeenCalled();
    expect(f.authority.get('session')?.operation('marker-wait')).toMatchObject({
      status: 'in_flight',
      dispatched: false,
    });
    expect(record(f.journal, f.memory)).toMatchObject({ revision: 1, dispatched: false });

    held.release();
    expect(await running).toBe('effect');
    expect(effect).toHaveBeenCalledTimes(1);
    expect(f.controlled.calls.markDispatch).toBe(1);
    expect(record(f.journal, f.memory)).toMatchObject({
      revision: 3,
      dispatched: true,
      terminal: { status: 'completed' },
    });
  });

  it('refuses a facade-valid already-applied marker ACK with zero effects', async () => {
    const f = await fixture();
    f.controlled.rewriteNextDisposition('markDispatch', 'already_applied');
    const effect = vi.fn();
    const result = await f.authority
      .run('session', operator, journalOperation('existing-marker'), async () => {
        const qualification = f.authority.captureApplicationDispatchInScope(
          'session',
          () => undefined
        );
        await f.authority.dispatchInScope('session', effect, qualification);
      })
      .catch((error) => error);
    expect(result).toBeInstanceOf(Error);
    expect(effect).not.toHaveBeenCalled();
    expect(f.controlled.calls.markDispatch).toBe(1);
    expect(record(f.journal, f.memory)).toMatchObject({ revision: 2, dispatched: true });
    expect(f.authority.get('session')?.operation('existing-marker')).toMatchObject({
      status: 'failed',
      dispatched: false,
    });
  });

  it('shares one marker across sibling and nested effects but reruns the final guard', async () => {
    const f = await fixture();
    const held = f.controlled.holdNext('markDispatch', 'before_write');
    const guard = vi.fn();
    const effects: string[] = [];
    const running = f.authority.run(
      'session',
      operator,
      journalOperation('shared-marker'),
      async () => {
        const qualification = f.authority.captureApplicationDispatchInScope('session', guard);
        const first = f.authority.dispatchInScope(
          'session',
          async () => {
            effects.push('first');
            await f.authority.dispatchInScope(
              'session',
              () => effects.push('nested'),
              qualification
            );
          },
          qualification
        );
        const sibling = f.authority.dispatchInScope(
          'session',
          () => effects.push('sibling'),
          qualification
        );
        await Promise.all([first, sibling]);
      }
    );

    await held.started;
    expect(f.controlled.calls.markDispatch).toBe(1);
    expect(guard).not.toHaveBeenCalled();
    expect(effects).toEqual([]);
    held.release();
    await running;
    expect(f.controlled.calls.markDispatch).toBe(1);
    expect(guard).toHaveBeenCalledTimes(3);
    expect(effects).toEqual(expect.arrayContaining(['first', 'nested', 'sibling']));
  });

  it.each(['late-ack', 'ack-lost'] as const)(
    'retains a timed-out marker %s without turning it into an effect',
    async (result) => {
      vi.useFakeTimers();
      const f = await fixture();
      if (result === 'ack-lost') f.memory.failNext('markDispatch', 'after_commit');
      const held = f.controlled.holdNext('markDispatch', 'after_commit');
      const effect = vi.fn();
      const running = f.authority
        .run('session', operator, journalOperation('late-marker'), async () => {
          const qualification = f.authority.captureApplicationDispatchInScope(
            'session',
            () => undefined
          );
          await expect(
            f.authority.dispatchInScope('session', effect, qualification)
          ).rejects.toBeInstanceOf(Error);
        })
        .catch((error) => error);

      await held.committed;
      expect(record(f.journal, f.memory)).toMatchObject({ revision: 2, dispatched: true });
      await vi.advanceTimersByTimeAsync(26);
      expect(await running).toBeInstanceOf(Error);
      expect(effect).not.toHaveBeenCalled();
      expect(f.authority.status('session')).toMatchObject({
        busy: true,
        operation: { status: 'failed', dispatched: false },
      });

      held.release();
      await vi.waitFor(() => expect(f.authority.status('session').busy).toBe(false));
      expect(f.authority.get('session')?.operation('late-marker')).toMatchObject({
        status: 'failed',
        dispatched: false,
      });
      expect(effect).not.toHaveBeenCalled();
    }
  );

  it('seals an abandoned marker wait and drains its late ACK without invoking the effect', async () => {
    const f = await fixture();
    const held = f.controlled.holdNext('markDispatch', 'before_write');
    const effect = vi.fn();
    const control = f.authority.get('session');
    if (!control) throw new Error('missing control fixture');
    const running = f.authority.run(
      'session',
      operator,
      journalOperation('abandoned-marker'),
      async () => {
        const qualification = f.authority.captureApplicationDispatchInScope(
          'session',
          () => undefined
        );
        void f.authority.dispatchInScope('session', effect, qualification);
        return 'bounded-response';
      }
    );

    const outcome = running.catch((error) => error);
    await held.started;
    expect(effect).not.toHaveBeenCalled();
    expect(control.view()).toMatchObject({
      busy: true,
      operation: { status: 'in_flight', dispatched: false },
    });
    expect(record(f.journal, f.memory)).toMatchObject({ revision: 1, dispatched: false });

    held.release();
    expect(await outcome).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(control.view().busy).toBe(false));
    expect(effect).not.toHaveBeenCalled();
    expect(control.operation('abandoned-marker')).toMatchObject({
      status: 'failed',
      dispatched: false,
    });
    expect(record(f.journal, f.memory)).toMatchObject({
      revision: 3,
      dispatched: true,
      terminal: { status: 'failed' },
    });
  });

  it.each(['takeover', 'expiry', 'replacement'] as const)(
    'does not invoke an effect when %s changes authority during the marker wait',
    async (change) => {
      const f = await fixture(change === 'expiry' ? { authorityTtlMs: 1 } : {});
      const held = f.controlled.holdNext('markDispatch', 'before_write');
      const effect = vi.fn();
      const running = f.authority
        .run('session', operator, journalOperation(`marker-${change}`), async () => {
          const qualification = f.authority.captureApplicationDispatchInScope(
            'session',
            () => undefined
          );
          await f.authority.dispatchInScope('session', effect, qualification);
        })
        .catch((error) => error);
      await held.started;
      changeAuthorityDuringWait(f, change);
      held.release();
      expect(await running).toBeInstanceOf(Error);
      expect(effect).not.toHaveBeenCalled();
      expect(record(f.journal, f.memory)).toMatchObject({
        revision: 3,
        dispatched: true,
        terminal: { status: 'failed' },
      });
    }
  );

  it.each(['throw', 'thenable', 'takeover', 'replacement', 'journal-close'] as const)(
    'refuses the effect when its final guard performs %s',
    async (kind) => {
      const f = await fixture();
      const effect = vi.fn();
      const replacementLifetime = new AbortController();
      await f.authority
        .run('session', operator, journalOperation(`guard-${kind}`), async () => {
          const guard = (() => {
            if (kind === 'throw') throw new Error('guard refused');
            if (kind === 'thenable') return Promise.resolve();
            if (kind === 'takeover') f.authority.takeover('session');
            if (kind === 'replacement') {
              f.authority.remove('session');
              f.authority.register('session', 'owner', replacementLifetime.signal);
            }
            if (kind === 'journal-close') void f.journal.close();
          }) as () => void;
          const qualification = f.authority.captureApplicationDispatchInScope('session', guard);
          await expect(
            f.authority.dispatchInScope('session', effect, qualification)
          ).rejects.toBeInstanceOf(Error);
        })
        .catch(() => undefined);
      expect(f.controlled.calls.markDispatch).toBe(1);
      expect(effect).not.toHaveBeenCalled();
    }
  );

  it('latches a caught reentrant dispatch attempt inside the final guard', async () => {
    const f = await fixture();
    const outerEffect = vi.fn();
    const reentrantEffect = vi.fn();
    await f.authority
      .run('session', operator, journalOperation('guard-reentry'), async () => {
        type Qualification = ReturnType<SessionAuthority['captureApplicationDispatchInScope']>;
        const captured: { qualification?: Qualification } = {};
        const qualification = f.authority.captureApplicationDispatchInScope('session', () => {
          try {
            void f.authority.dispatchInScope('session', reentrantEffect, captured.qualification);
          } catch {
            // Catching the immediate refusal must not make the outer guard valid again.
          }
        });
        captured.qualification = qualification;
        await expect(
          f.authority.dispatchInScope('session', outerEffect, qualification)
        ).rejects.toBeInstanceOf(Error);
      })
      .catch(() => undefined);
    expect(f.controlled.calls.markDispatch).toBe(1);
    expect(reentrantEffect).not.toHaveBeenCalled();
    expect(outerEffect).not.toHaveBeenCalled();
  });

  it('binds qualification to its exact scope and refuses forged capability objects', async () => {
    const f = await fixture();
    let escaped!: ReturnType<SessionAuthority['captureApplicationDispatchInScope']>;
    await expect(
      f.authority.run('session', operator, journalOperation('capture-scope'), async () => {
        escaped = f.authority.captureApplicationDispatchInScope('session', () => undefined);
      })
    ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
    const effect = vi.fn();
    await f.authority
      .run('session', operator, journalOperation('different-scope'), async () => {
        await expect(
          f.authority.dispatchInScope('session', effect, escaped)
        ).rejects.toBeInstanceOf(Error);
        await expect(
          f.authority.dispatchInScope(
            'session',
            effect,
            {} as ReturnType<SessionAuthority['captureApplicationDispatchInScope']>
          )
        ).rejects.toBeInstanceOf(Error);
      })
      .catch(() => undefined);
    expect(f.controlled.calls.markDispatch).toBe(0);
    expect(effect).not.toHaveBeenCalled();
  });

  it.each(['ordinary-dispatch', 'guard-page', 'legacy-assert'] as const)(
    'does not let journal work tunnel through excluded %s',
    async (kind) => {
      const f = await fixture();
      const effect = vi.fn(async () => undefined);
      await expect(
        f.authority.run('session', operator, journalOperation(`excluded-${kind}`), async () => {
          if (kind === 'ordinary-dispatch') {
            expect(() => f.authority.dispatchInScope('session', effect)).toThrow();
          } else if (kind === 'guard-page') {
            const page = f.authority.guardPage('session', {
              act: effect,
            } as unknown as EnginePage);
            expect(() => page.act({ action: 'press', key: 'Tab' })).toThrow();
          } else expect(() => f.authority.assert('session', true)).toThrow();
        })
      ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
      expect(effect).not.toHaveBeenCalled();
      expect(f.controlled.calls.markDispatch).toBe(0);
      expect(record(f.journal, f.memory)).toMatchObject({
        revision: 2,
        dispatched: false,
        terminal: { status: 'failed' },
      });
    }
  );
});

it('converts an unexpected synchronous journal-port throw to a static control refusal', async () => {
  const privateText = 'PRIVATE adapter credential and filesystem path';
  const injected = {
    namespace: namespace(),
    health: 'open',
    pending: 0,
    reserveIntent: vi.fn(() => {
      throw new Error(privateText);
    }),
    markDispatch: vi.fn(() => {
      throw new Error('unused');
    }),
    commitTerminal: vi.fn(() => {
      throw new Error('unused');
    }),
    lookup: vi.fn(() => {
      throw new Error('unused');
    }),
    close: vi.fn(async () => ({ kind: 'closed' as const })),
  } as unknown as OperationJournal;
  const authority = new SessionAuthority({ journal: injected });
  authority.register('session', 'owner', new AbortController().signal);
  const callback = vi.fn(async () => 'forbidden');
  const result = await authority
    .run('session', operator, journalOperation('port-throws'), callback)
    .catch((error) => error);
  expect(result).toMatchObject({ code: 'CONTROL_REQUIRED' });
  expect(String(result)).not.toContain(privateText);
  expect(callback).not.toHaveBeenCalled();
  expect(injected.reserveIntent).toHaveBeenCalledTimes(1);
});

describe('journal descriptor refusal before admission', () => {
  const invalid = [
    {
      name: 'missing operation ID',
      operation: {
        fingerprint: privateFingerprint,
        journal: { version: 1, application },
      },
    },
    {
      name: 'missing live fingerprint',
      operation: {
        id: 'missing-fingerprint',
        journal: { version: 1, application },
      },
    },
    {
      name: 'wrong descriptor version',
      operation: {
        id: 'wrong-version',
        fingerprint: privateFingerprint,
        journal: { version: 2, application },
      },
    },
    {
      name: 'caller-supplied digest',
      operation: {
        id: 'supplied-digest',
        fingerprint: privateFingerprint,
        journal: { version: 1, application, digest: 'attacker-selected-digest' },
      },
    },
    {
      name: 'malformed application identity',
      operation: {
        id: 'malformed-application',
        fingerprint: privateFingerprint,
        journal: { version: 1, application: { ...application, adapterId: '' } },
      },
    },
  ] as const;

  it.each(invalid)('refuses $name before begin or journal I/O', async ({ operation }) => {
    const f = await fixture();
    const callback = vi.fn(async () => 'forbidden');
    const result = await f.authority
      .run('session', operator, operation as never, callback)
      .catch((error) => error);
    expect(result).toMatchObject({ code: 'CONTROL_REQUIRED' });
    expect(callback).not.toHaveBeenCalled();
    expect(f.controlled.calls.reserveIntent).toBe(0);
    expect(f.authority.status('session').busy).toBe(false);
    expect(f.authority.status('session').operation).toBeUndefined();
    if ('id' in operation)
      expect(f.authority.get('session')?.operation(operation.id)).toBeUndefined();
  });

  it('refuses a valid descriptor when no journal was configured', async () => {
    const authority = new SessionAuthority();
    authority.register('session', 'owner', new AbortController().signal);
    const callback = vi.fn(async () => 'forbidden');
    const result = await authority
      .run('session', operator, journalOperation('journal-not-configured'), callback)
      .catch((error) => error);
    expect(result).toMatchObject({ code: 'CONTROL_REQUIRED' });
    expect(callback).not.toHaveBeenCalled();
    expect(authority.status('session').busy).toBe(false);
    expect(authority.status('session').operation).toBeUndefined();
    expect(authority.get('session')?.operation('journal-not-configured')).toBeUndefined();
  });
});

it.each(['journal-close', 'replacement', 'thenable'] as const)(
  'does not complete when failed() performs %s before any effect',
  async (change) => {
    const f = await fixture();
    const oldControl = f.authority.get('session');
    if (!oldControl) throw new Error('missing control fixture');
    const classifier = vi.fn(() => {
      if (change === 'journal-close') void f.journal.close();
      else if (change === 'replacement') {
        f.authority.remove('session');
        f.authority.register('session', 'owner', new AbortController().signal);
      } else return Promise.resolve(false) as unknown as boolean;
      return false;
    });
    await f.authority
      .run(
        'session',
        operator,
        journalOperation(`classifier-no-effect-${change}`),
        async () => 'bounded-result',
        classifier
      )
      .catch(() => undefined);
    expect(classifier).toHaveBeenCalledTimes(1);
    expect(oldControl.operation(`classifier-no-effect-${change}`)).toMatchObject({
      status: 'failed',
      dispatched: false,
    });
  }
);

it.each(['journal-close', 'replacement', 'thenable'] as const)(
  'retains outcome unknown when failed() performs %s after an effect',
  async (change) => {
    const f = await fixture();
    const oldControl = f.authority.get('session');
    if (!oldControl) throw new Error('missing control fixture');
    const effect = vi.fn(() => 'effect-result');
    const classifier = vi.fn(() => {
      if (change === 'journal-close') void f.journal.close();
      else if (change === 'replacement') {
        f.authority.remove('session');
        f.authority.register('session', 'owner', new AbortController().signal);
      } else return Promise.resolve(false) as unknown as boolean;
      return false;
    });
    await f.authority
      .run(
        'session',
        operator,
        journalOperation(`classifier-effect-${change}`),
        async () => {
          const qualification = f.authority.captureApplicationDispatchInScope(
            'session',
            () => undefined
          );
          await f.authority.dispatchInScope('session', effect, qualification);
        },
        classifier
      )
      .catch(() => undefined);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(classifier).toHaveBeenCalledTimes(1);
    expect(oldControl.operation(`classifier-effect-${change}`)).toMatchObject({
      status: 'outcome_unknown',
      dispatched: true,
    });
  }
);

it('preserves synchronous ordinary ephemeral dispatch and legacy guards', async () => {
  const authority = new SessionAuthority();
  authority.register('session', 'owner', new AbortController().signal);
  const order: string[] = [];
  await authority.run('session', operator, { id: 'ephemeral', fingerprint: 'same' }, async () => {
    const dispatched = authority.dispatchInScope('session', () => {
      order.push('effect');
      return 42;
    });
    expect(order).toEqual(['effect']);
    expect(await dispatched).toBe(42);
    authority.assert('session', true);
  });
  expect(authority.get('session')?.operation('ephemeral')).toMatchObject({
    status: 'completed',
    dispatched: true,
  });
});
