/**
 * T5 B-dur-2a (control layer): a durable browser operation is ONE journal record under the
 * reserved `browser` identity, however many page dispatches it makes. The first dispatch writes the
 * marker, then runs the owner's async recheck (once), then the effect; later dispatches ride the
 * same marker. A failed recheck crosses no effect (terminal `failed`, `dispatched: true`), and an
 * operation that never dispatches keeps its normal result (`failed_before_dispatch`).
 */
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_OPERATION_FINGERPRINT, RESERVED_BROWSER_ADAPTER_ID } from './browser-journal.js';
import { createControllableJournalFixture } from './journal-authority.test-support.js';
import { SessionAuthority, type SessionPrincipal } from './session-authority.js';

const operator: SessionPrincipal = { actor: 'operator', tenant: 'owner' };
const browserSelection = (resourceId = 'plan') => ({
  version: 1 as const,
  application: {
    adapterId: RESERVED_BROWSER_ADAPTER_ID,
    resourceId,
    bindingGeneration: 'page-1',
  },
  durable: true as const,
  browser: true as const,
});

async function sessionFixture() {
  const journal = await createControllableJournalFixture();
  const real = journal.journal;
  // The facade is frozen; observe what it receives through a delegating view.
  const reserved: unknown[] = [];
  const observed = Object.freeze({
    get namespace() {
      return real.namespace;
    },
    get health() {
      return real.health;
    },
    get pending() {
      return real.pending;
    },
    reserveIntent: (intent: unknown, signal?: AbortSignal) => {
      reserved.push(intent);
      return real.reserveIntent(intent as never, signal);
    },
    markDispatch: real.markDispatch.bind(real),
    commitTerminal: real.commitTerminal.bind(real),
    lookup: real.lookup.bind(real),
    findByOperation: real.findByOperation.bind(real),
    close: real.close.bind(real),
  });
  const authority = new SessionAuthority({ now: journal.memory.now, journal: observed as never });
  authority.register('session', 'owner', new AbortController().signal);
  const stored = () => journal.memory.observe(real.namespace.namespaceId)?.records ?? [];
  return { ...journal, authority, stored, reserved };
}

const run = <T>(
  f: Awaited<ReturnType<typeof sessionFixture>>,
  id: string,
  work: () => Promise<T>,
  failed: () => false | 'rejected' = () => false,
  selection: unknown = browserSelection()
) =>
  f.authority.run(
    'session',
    operator,
    { id, fingerprint: `digest-${id}`, journal: selection as never },
    work,
    failed
  );

describe('durable browser operations in the journal (B-dur-2a)', () => {
  it('one record for many dispatches: marker once, guard once after it, effects in order', async () => {
    const f = await sessionFixture();
    const order: string[] = [];
    const result = await run(f, 'three-steps', async () => {
      f.authority.captureBrowserDispatchInScope('session', async () => {
        // The guard sees the marker already written.
        order.push(`guard:rev${f.stored()[0]?.revision}`);
      });
      for (const step of [1, 2, 3])
        await f.authority.dispatchInScope('session', () => {
          order.push(`effect${step}`);
        });
      return 'report';
    });
    expect(result).toBe('report');
    expect(order).toEqual(['guard:rev2', 'effect1', 'effect2', 'effect3']);
    expect(f.stored()).toHaveLength(1);
    expect(f.stored()[0]).toMatchObject({
      revision: 3,
      dispatched: true,
      terminal: { status: 'completed' },
      identity: { application: { adapterId: 'browser', resourceId: 'plan' } },
    });
  });

  it('labels the intent in the browser fingerprint domain', async () => {
    const f = await sessionFixture();
    await run(f, 'labeled', async () => {
      f.authority.captureBrowserDispatchInScope('session', async () => {});
      await f.authority.dispatchInScope('session', () => undefined);
    });
    expect(f.reserved[0]).toMatchObject({
      liveFingerprint: { algorithm: BROWSER_OPERATION_FINGERPRINT, digest: 'digest-labeled' },
    });
  });

  it('a failed recheck after the marker crosses no effect: failed with dispatched true, its own error', async () => {
    const f = await sessionFixture();
    const effect = vi.fn();
    const refusal = Object.assign(new Error('Target changed during the wait'), {
      code: 'STALE_TARGET',
    });
    await expect(
      run(f, 'stale', async () => {
        f.authority.captureBrowserDispatchInScope('session', async () => {
          throw refusal;
        });
        await f.authority.dispatchInScope('session', effect);
      })
    ).rejects.toBe(refusal);
    expect(effect).not.toHaveBeenCalled();
    expect(f.stored()[0]).toMatchObject({
      revision: 3,
      dispatched: true,
      terminal: { status: 'failed' },
    });
  });

  it('a guard refusal the work absorbs (into its own report) keeps that report; terminal failed', async () => {
    const f = await sessionFixture();
    const effect = vi.fn();
    const result = await run(f, 'absorbed', async () => {
      f.authority.captureBrowserDispatchInScope('session', async () => {
        throw Object.assign(new Error('Mapped stage identity changed'), { code: 'STALE_TARGET' });
      });
      // An autofill-like owner records the refusal as a field receipt and returns its report.
      const outcome = await f.authority.dispatchInScope('session', effect).then(
        () => 'written',
        (error: { code?: string }) => error.code
      );
      return { ok: false, receipts: [outcome] };
    });
    expect(result).toEqual({ ok: false, receipts: ['STALE_TARGET'] });
    expect(effect).not.toHaveBeenCalled();
    expect(f.stored()[0]).toMatchObject({
      revision: 3,
      dispatched: true,
      terminal: { status: 'failed' },
    });
  });

  it('any OTHER seal still refuses the operation (unchanged for non-guard failures)', async () => {
    const f = await sessionFixture();
    await expect(
      run(f, 'unguarded-absorbed', async () => {
        // No guard captured: the dispatch is refused (a seal that is not a guard refusal).
        const outcome = await f.authority
          .dispatchInScope('session', () => undefined)
          .then(
            () => 'written',
            () => 'refused'
          );
        return { outcome };
      })
    ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
  });

  it('an operation that never dispatches keeps its result and is failed_before_dispatch', async () => {
    const f = await sessionFixture();
    const result = await run(f, 'nothing-to-do', async () => {
      f.authority.captureBrowserDispatchInScope('session', async () => {});
      return 'no-op report';
    });
    expect(result).toBe('no-op report');
    expect(f.stored()[0]).toMatchObject({
      revision: 2,
      dispatched: false,
      terminal: { status: 'failed' },
    });
  });

  it('a known failure after dispatch is failed with its report returned, never JOURNAL_UNAVAILABLE', async () => {
    const f = await sessionFixture();
    const result = await run(
      f,
      'step-two-failed',
      async () => {
        f.authority.captureBrowserDispatchInScope('session', async () => {});
        await f.authority.dispatchInScope('session', () => undefined);
        return { ok: false, failedStep: 2 };
      },
      () => 'rejected'
    );
    expect(result).toEqual({ ok: false, failedStep: 2 });
    expect(f.stored()[0]).toMatchObject({ dispatched: true, terminal: { status: 'failed' } });
  });

  it('an in-doubt browser operation keeps its report; the record is settled unknown', async () => {
    const f = await sessionFixture();
    const result = await f.authority.run(
      'session',
      operator,
      { id: 'lost', fingerprint: 'digest-lost', journal: browserSelection() as never },
      async () => {
        f.authority.captureBrowserDispatchInScope('session', async () => {});
        await f.authority.dispatchInScope('session', () => undefined);
        return { ok: false, lost: true };
      },
      () => true
    );
    expect(result).toEqual({ ok: false, lost: true });
    expect(f.stored()[0]).toMatchObject({
      revision: 3,
      dispatched: true,
      terminal: { status: 'outcome_unknown' },
    });
  });

  it('an effect signal waits for the recheck, never fires on refusal, and is immediate elsewhere', async () => {
    const f = await sessionFixture();
    const order: string[] = [];
    await run(f, 'signal-ok', async () => {
      f.authority.captureBrowserDispatchInScope('session', async () => {
        order.push('guard');
      });
      f.authority.onBrowserEffectInScope('session', () => order.push('signal'));
      await f.authority.dispatchInScope('session', () => {
        order.push('effect');
      });
      f.authority.onBrowserEffectInScope('session', () => order.push('later-signal'));
    });
    expect(order).toEqual(['guard', 'signal', 'effect', 'later-signal']);

    const refused = vi.fn();
    await run(f, 'signal-refused', async () => {
      f.authority.captureBrowserDispatchInScope('session', async () => {
        throw Object.assign(new Error('stale'), { code: 'STALE_TARGET' });
      });
      f.authority.onBrowserEffectInScope('session', refused);
      await f.authority.dispatchInScope('session', () => undefined).catch(() => undefined);
      return 'report';
    });
    expect(refused).not.toHaveBeenCalled();

    const plain = vi.fn();
    await f.authority.run('session', operator, {}, async () => {
      f.authority.onBrowserEffectInScope('session', plain);
    });
    expect(plain).toHaveBeenCalledOnce();
  });

  it('refuses a dispatch before the guard is captured, and a second capture', async () => {
    const f = await sessionFixture();
    await expect(
      run(f, 'unguarded', async () => {
        await f.authority.dispatchInScope('session', () => undefined);
      })
    ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
    // Refused before any journal I/O past the intent: no marker was written.
    expect(f.stored()[0]).toMatchObject({ revision: 2, dispatched: false });
    await expect(
      run(f, 'twice', async () => {
        f.authority.captureBrowserDispatchInScope('session', async () => {});
        f.authority.captureBrowserDispatchInScope('session', async () => {});
      })
    ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
  });

  it('a dispatch from inside the guard is refused (not deadlocked); the operation is sealed', async () => {
    const f = await sessionFixture();
    const effect = vi.fn();
    let inner: unknown;
    await expect(
      run(f, 'reentrant', async () => {
        f.authority.captureBrowserDispatchInScope('session', async () => {
          inner = await Promise.resolve()
            .then(() => f.authority.dispatchInScope('session', effect))
            .then(
              () => 'ran',
              (error: { code?: string }) => error.code
            );
        });
        await f.authority.dispatchInScope('session', effect);
      })
    ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
    expect(inner).toBe('CONTROL_REQUIRED');
    expect(effect).not.toHaveBeenCalled();
  });

  it('other work of the operation during the guard await is not poisoned (review finding 1)', async () => {
    const f = await sessionFixture();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = await run(f, 'overlap', async () => {
      f.authority.captureBrowserDispatchInScope('session', async () => {
        order.push('guard-start');
        await gate;
        order.push('guard-end');
      });
      const first = f.authority.dispatchInScope('session', () => {
        order.push('effect-a');
      });
      // A second dispatch issued from the operation (not the guard) while the guard awaits.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const second = f.authority.dispatchInScope('session', () => {
        order.push('effect-b');
      });
      release();
      await Promise.all([first, second]);
      return 'both';
    });
    expect(result).toBe('both');
    expect(order).toEqual(['guard-start', 'guard-end', 'effect-a', 'effect-b']);
    expect(f.stored()[0]).toMatchObject({ terminal: { status: 'completed' } });
  });

  it('a guard failure seals the operation: a later dispatch is refused without re-running it', async () => {
    const f = await sessionFixture();
    const guard = vi.fn(async () => {
      throw Object.assign(new Error('stale'), { code: 'STALE_TARGET' });
    });
    const effect = vi.fn();
    let later: unknown;
    // B-dur-2b: the work absorbs both refusals and returns, so its report is kept (terminal
    // failed); the seal still refuses the later dispatch without re-running the guard.
    const result = await run(f, 'sealed', async () => {
      f.authority.captureBrowserDispatchInScope('session', guard);
      await f.authority.dispatchInScope('session', effect).catch(() => undefined);
      later = await Promise.resolve()
        .then(() => f.authority.dispatchInScope('session', effect))
        .then(
          () => 'ran',
          (error: { code?: string }) => error.code
        );
      return 'report';
    });
    expect(result).toBe('report');
    expect(f.stored()[0]).toMatchObject({ dispatched: true, terminal: { status: 'failed' } });
    expect(later).toBe('CONTROL_REQUIRED');
    expect(guard).toHaveBeenCalledOnce();
    expect(effect).not.toHaveBeenCalled();
  });

  it('an application qualification cannot be captured in a browser scope', async () => {
    const f = await sessionFixture();
    await expect(
      run(f, 'app-in-browser', async () => {
        f.authority.captureApplicationDispatchInScope('session', () => undefined);
      })
    ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
  });

  it('refuses the guard capture outside a browser journal scope', async () => {
    const f = await sessionFixture();
    await expect(
      f.authority.run('session', operator, {}, async () => {
        f.authority.captureBrowserDispatchInScope('session', async () => {});
      })
    ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
  });

  it.each([
    ['without durable', { ...browserSelection(), durable: undefined }],
    [
      'under a non-browser adapter',
      {
        ...browserSelection(),
        application: { adapterId: 'app', resourceId: 'r', bindingGeneration: 'g' },
      },
    ],
    ['with browser: false', { ...browserSelection(), browser: false }],
    // The reserved identity without the browser flag: an application write may never use it.
    ['as a durable application write', { ...browserSelection(), browser: undefined }],
    [
      'as an ephemeral application write',
      { ...browserSelection(), browser: undefined, durable: undefined },
    ],
  ])('refuses a browser selection %s before any journal I/O', async (_name, selection) => {
    const f = await sessionFixture();
    const work = vi.fn(async () => 'never');
    await expect(
      run(f, 'bad-selection', work, () => false, JSON.parse(JSON.stringify(selection)))
    ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
    expect(work).not.toHaveBeenCalled();
    expect(f.reserved).toEqual([]);
  });
});
