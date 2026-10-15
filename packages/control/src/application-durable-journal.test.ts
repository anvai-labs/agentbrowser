/**
 * T5 J-d (C4b runtime wiring, control layer): `durable` is the only requirement that selects the
 * journal. A durable write is journaled under its own fingerprint label
 * (`application-operation:v2-durable`), an ephemeral write does no journal I/O, and `durable` is
 * refused before any effect whenever it cannot be journaled.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  type ApplicationAdapter,
  ApplicationAuthority,
  type ApplicationRequest,
} from './application-authority.js';
import { createControllableJournalFixture } from './journal-authority.test-support.js';
import { SessionAuthority, type SessionPrincipal } from './session-authority.js';

const operator: SessionPrincipal = { actor: 'operator', tenant: 'owner' };
const binding = { adapter: 'fixture-app', resource: 'fixture-resource' };
const application = Object.freeze({
  adapterId: 'fixture-adapter',
  resourceId: 'fixture-resource',
  bindingGeneration: 'fixture-binding-1',
});

async function sessionFixture() {
  const journal = await createControllableJournalFixture();
  const authority = new SessionAuthority({ now: journal.memory.now, journal: journal.journal });
  authority.register('session', 'owner', new AbortController().signal);
  const stored = () => journal.memory.observe(journal.journal.namespace.namespaceId)?.records ?? [];
  return { ...journal, authority, stored };
}

describe('the journal intent carries the durable fingerprint label', () => {
  it.each([
    ['labeled v2-durable', { durable: true }, 'application-operation:v2-durable'],
    ['labeled v1 without the flag', {}, 'application-operation:v1'],
  ])('a journal intent is %s', async (_name, flag, algorithm) => {
    const f = await sessionFixture();
    const seen: unknown[] = [];
    const real = f.journal;
    // Capture what the facade receives: the label is part of the keyed digest it computes.
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
        seen.push(intent);
        return real.reserveIntent(intent as never, signal);
      },
      markDispatch: real.markDispatch.bind(real),
      commitTerminal: real.commitTerminal.bind(real),
      lookup: real.lookup.bind(real),
      close: real.close.bind(real),
    });
    const authority = new SessionAuthority({ now: f.memory.now, journal: observed as never });
    authority.register('session', 'owner', new AbortController().signal);
    await authority
      .run(
        'session',
        operator,
        {
          id: 'labeled',
          fingerprint: 'LIVE-DIGEST',
          journal: { version: 1, application, ...flag } as never,
        },
        async () => 'done'
      )
      .catch(() => undefined);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ liveFingerprint: { algorithm, digest: 'LIVE-DIGEST' } });
  });

  it.each([false, 'true', 1, null])(
    'refuses durable: %s before begin or journal I/O',
    async (value) => {
      const f = await sessionFixture();
      const callback = vi.fn(async () => 'forbidden');
      await expect(
        f.authority.run(
          'session',
          operator,
          {
            id: 'bad-durable',
            fingerprint: 'LIVE',
            journal: { version: 1, application, durable: value } as never,
          },
          callback
        )
      ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
      expect(callback).not.toHaveBeenCalled();
      expect(f.controlled.calls.reserveIntent).toBe(0);
    }
  );
});

async function applicationFixture(
  options: { durableWrites?: boolean; journal?: boolean; health?: 'closed' } = {}
) {
  const journal = await createControllableJournalFixture();
  const authority = new SessionAuthority({
    now: journal.memory.now,
    ...(options.journal === false ? {} : { journal: journal.journal }),
  });
  authority.register('session', 'owner', new AbortController().signal);
  let effects = 0;
  const write = vi.fn(() => async () => {
    effects += 1;
    return { status: 'committed' as const, value: effects };
  });
  const read = vi.fn(() => async () => ({ status: 'read' as const, value: effects }));
  const adapter: ApplicationAdapter = {
    id: binding.adapter,
    authorize: () => true,
    operations: {
      add: { mode: 'write', prepare: write },
      get: { mode: 'read', prepare: read },
    },
    receipt: async () => undefined,
  };
  const port = new ApplicationAuthority(authority, [adapter], {
    ...(options.durableWrites !== undefined ? { durableWrites: options.durableWrites } : {}),
  });
  port.bind('session', operator, binding);
  if (options.health === 'closed') await journal.journal.close();
  return { ...journal, port, effects: () => effects, write, read };
}

const durableWrite = (id = 'durable-1'): ApplicationRequest => ({
  operation: 'add',
  input: 1,
  operationId: id,
  expectedVersion: 0,
  executionRequirement: 'durable',
});

describe('ApplicationAuthority durable writes', () => {
  it('journals a durable write: intent, dispatch marker and terminal around exactly one effect', async () => {
    const f = await applicationFixture({ durableWrites: true });
    await expect(f.port.execute('session', operator, durableWrite())).resolves.toMatchObject({
      status: 'committed',
    });
    expect(f.effects()).toBe(1);
    expect(f.controlled.calls.reserveIntent).toBe(1);
    expect(f.controlled.calls.markDispatch).toBe(1);
    expect(f.controlled.calls.commitTerminal).toBe(1);
    expect(f.memory.observe(f.journal.namespace.namespaceId)?.records[0]).toMatchObject({
      identity: { key: { operationId: 'durable-1' } },
      dispatched: true,
      terminal: { status: 'completed' },
    });
  });

  it('an ephemeral write (explicit or omitted) does no journal I/O', async () => {
    const f = await applicationFixture({ durableWrites: true });
    await f.port.execute('session', operator, {
      operation: 'add',
      input: 1,
      operationId: 'e1',
      expectedVersion: 0,
    });
    await f.port.execute('session', operator, {
      operation: 'add',
      input: 1,
      operationId: 'e2',
      expectedVersion: 1,
      executionRequirement: 'ephemeral',
    });
    expect(f.effects()).toBe(2);
    expect(f.controlled.calls.reserveIntent).toBe(0);
    expect(f.controlled.calls.markDispatch).toBe(0);
    expect(f.controlled.calls.commitTerminal).toBe(0);
  });

  it.each([
    ['durable writes are not enabled', { durableWrites: false }],
    ['durable writes are not configured at all', {}],
    ['no journal is attached', { durableWrites: true, journal: false }],
    ['the journal is closed', { durableWrites: true, health: 'closed' as const }],
  ])('refuses durable before any effect when %s', async (_name, options) => {
    const f = await applicationFixture(options);
    await expect(f.port.execute('session', operator, durableWrite())).rejects.toMatchObject({
      code: 'CONTROL_REQUIRED',
    });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.effects()).toBe(0);
  });

  it('refuses durable on a read: durability is a write-execution requirement', async () => {
    const f = await applicationFixture({ durableWrites: true });
    await expect(
      f.port.execute('session', operator, {
        operation: 'get',
        input: null,
        executionRequirement: 'durable',
      })
    ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.controlled.calls.reserveIntent).toBe(0);
  });

  it('rejects a non-boolean durableWrites option', () => {
    const authority = new SessionAuthority();
    expect(
      () => new ApplicationAuthority(authority, [], { durableWrites: 'yes' as never })
    ).toThrow();
  });
});
