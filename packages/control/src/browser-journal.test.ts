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

  it('refuses a dispatch before the guard is captured, and a second capture', async () => {
    const f = await sessionFixture();
    await expect(
      run(f, 'unguarded', async () => {
        await f.authority.dispatchInScope('session', () => undefined);
      })
    ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
    await expect(
      run(f, 'twice', async () => {
        f.authority.captureBrowserDispatchInScope('session', async () => {});
        f.authority.captureBrowserDispatchInScope('session', async () => {});
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
