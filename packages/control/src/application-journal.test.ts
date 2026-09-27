import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ApplicationAdapter,
  ApplicationAuthority,
  type ApplicationConsentPolicy,
  type ApplicationOperation,
  type ApplicationRequest,
} from './application-authority.js';
import { createControllableJournalFixture } from './journal-authority.test-support.js';
import { SessionAuthority, type SessionPrincipal } from './session-authority.js';

const operator: SessionPrincipal = { actor: 'operator', tenant: 'owner' };
const binding = { adapter: 'fixture-app', resource: 'fixture-resource' };
const protectedRequest = (): ApplicationRequest => ({
  operation: 'submit',
  operationId: 'protected-write',
  expectedVersion: 0,
  input: { answer: 'original' },
  approvalToken: 'approval-token',
});
const ordinaryRequest = (): ApplicationRequest => ({
  operation: 'ordinary',
  operationId: 'ordinary-write',
  expectedVersion: 0,
  input: { answer: 'original' },
});

async function fixture(
  options: { journalWrites?: boolean; omitJournal?: boolean } = { journalWrites: true }
) {
  const journal = await createControllableJournalFixture();
  const authority = new SessionAuthority({
    now: journal.memory.now,
    ...(options.omitJournal ? {} : { journal: journal.journal }),
  });
  const lifetime = new AbortController();
  authority.register('session', 'owner', lifetime.signal);
  let authorized = true;
  let consentCurrent = true;
  const order: string[] = [];
  const authorize = vi.fn(() => {
    order.push('authorize');
    return authorized;
  });
  const prepare = vi.fn((input: unknown) => {
    order.push('prepare');
    const captured = structuredClone(input);
    return async (scope: unknown) => {
      order.push('effect');
      return { status: 'committed' as const, value: { input: captured, scope } };
    };
  });
  const protectedOperation: ApplicationOperation = {
    mode: 'write',
    review: 'operator-submit',
    prepare,
  };
  const ordinaryOperation: ApplicationOperation = { mode: 'write', prepare };
  const adapter: ApplicationAdapter = {
    id: binding.adapter,
    authorize,
    operations: { submit: protectedOperation, ordinary: ordinaryOperation },
    receipt: async () => undefined,
  };
  const consume = vi.fn(async () => {
    order.push('consume');
    return true;
  });
  const assertCurrent = vi.fn(() => {
    order.push('consent-guard');
    if (!consentCurrent) throw new Error('PRIVATE revoked consent');
  });
  const policy = vi.fn(() => {
    order.push('policy');
    return { consume, assertCurrent };
  }) as ApplicationConsentPolicy;
  const port = new ApplicationAuthority(authority, [adapter], {
    consentPolicy: policy,
    ...(options.journalWrites !== undefined ? { journalWrites: options.journalWrites } : {}),
  });
  port.bind('session', operator, binding);
  authorize.mockClear();
  order.length = 0;
  return {
    ...journal,
    authority,
    lifetime,
    port,
    authorize,
    prepare,
    consume,
    assertCurrent,
    policy,
    order,
    setAuthorized(value: boolean) {
      authorized = value;
    },
    setConsentCurrent(value: boolean) {
      consentCurrent = value;
    },
    replaceBinding() {
      const bindings = (port as unknown as { bindings: WeakMap<object, object> }).bindings;
      const control = authority.get('session');
      if (!control) throw new Error('missing application control fixture');
      const current = bindings.get(control);
      if (!current) throw new Error('missing application binding fixture');
      bindings.set(control, { ...current });
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('journal-qualified application intent', () => {
  it('waits for intent acknowledgment before preparation, policy, consent, or effect', async () => {
    const f = await fixture();
    const held = f.controlled.holdNext('reserveIntent', 'before_write');
    const running = f.port.execute('session', operator, protectedRequest());

    await held.started;
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.policy).not.toHaveBeenCalled();
    expect(f.consume).not.toHaveBeenCalled();
    expect(f.order).toEqual([]);

    held.release();
    await expect(running).resolves.toMatchObject({ status: 'committed' });
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.consume).toHaveBeenCalledOnce();
    expect(f.controlled.calls.reserveIntent).toBe(1);
    expect(f.controlled.calls.markDispatch).toBe(1);
  });

  it('derives stored application identity from the captured binding', async () => {
    const f = await fixture();
    await f.port.execute('session', operator, protectedRequest());
    const stored = f.memory.observe(f.journal.namespace.namespaceId)?.records[0];
    expect(stored?.identity.application).toMatchObject({
      adapterId: binding.adapter,
      resourceId: binding.resource,
      bindingGeneration: expect.any(String),
    });
    expect(JSON.stringify(stored)).not.toContain('approval-token');
    expect(JSON.stringify(stored)).not.toContain('original');
  });
});

describe('post-marker application guards', () => {
  it.each(['consent', 'authorization', 'replacement', 'takeover', 'binding'] as const)(
    'refuses protected effect after %s changes during marker wait',
    async (change) => {
      const f = await fixture();
      const originalControl = f.authority.get('session');
      if (!originalControl) throw new Error('missing original control fixture');
      const held = f.controlled.holdNext('markDispatch', 'before_write');
      const running = f.port
        .execute('session', operator, protectedRequest())
        .catch((error) => error);
      await held.started;
      expect(f.consume).toHaveBeenCalledOnce();
      expect(f.order).not.toContain('effect');

      if (change === 'consent') f.setConsentCurrent(false);
      else if (change === 'authorization') f.setAuthorized(false);
      else if (change === 'replacement') {
        f.authority.remove('session');
        f.authority.register('session', 'owner', new AbortController().signal);
      } else if (change === 'takeover') f.authority.takeover('session');
      else f.replaceBinding();

      held.release();
      expect(await running).toBeInstanceOf(Error);
      expect(f.order).not.toContain('effect');
      expect(f.consume).toHaveBeenCalledOnce();
      expect(originalControl.operation('protected-write')).toMatchObject({
        status: 'failed',
        dispatched: false,
      });
      expect(f.memory.observe(f.journal.namespace.namespaceId)?.records[0]).toMatchObject({
        revision: 3,
        dispatched: true,
        terminal: { status: 'failed' },
      });
    }
  );

  it('uses detached input and preserves callback order across the marker wait', async () => {
    const f = await fixture();
    const held = f.controlled.holdNext('markDispatch', 'before_write');
    const request = protectedRequest();
    const running = f.port.execute('session', operator, request);
    await held.started;
    request.input = { answer: 'mutated' };
    expect(f.order).toContain('consume');
    expect(f.order).not.toContain('effect');

    held.release();
    await expect(running).resolves.toMatchObject({
      status: 'committed',
      value: { input: { answer: 'original' } },
    });
    expect(f.consume).toHaveBeenCalledOnce();
    expect(f.order.indexOf('prepare')).toBeLessThan(f.order.indexOf('policy'));
    expect(f.order.indexOf('policy')).toBeLessThan(f.order.indexOf('consume'));
    expect(f.order.lastIndexOf('authorize')).toBeGreaterThan(f.order.indexOf('consume'));
    expect(f.order.lastIndexOf('authorize')).toBeLessThan(f.order.lastIndexOf('consent-guard'));
    expect(f.order.lastIndexOf('consent-guard')).toBeLessThan(f.order.indexOf('effect'));
  });

  it.each(['authorization', 'binding'] as const)(
    'rechecks ordinary write %s after marker acknowledgment',
    async (change) => {
      const f = await fixture();
      const held = f.controlled.holdNext('markDispatch', 'before_write');
      const running = f.port
        .execute('session', operator, ordinaryRequest())
        .catch((error) => error);
      await held.started;
      expect(f.policy).not.toHaveBeenCalled();
      expect(f.consume).not.toHaveBeenCalled();
      expect(f.order).not.toContain('effect');
      if (change === 'authorization') f.setAuthorized(false);
      else f.replaceBinding();
      held.release();
      expect(await running).toBeInstanceOf(Error);
      expect(f.order).not.toContain('effect');
    }
  );

  it('blocks nested unqualified browser dispatch without blocking the qualified application effect', async () => {
    const f = await fixture();
    const nested = vi.fn();
    f.prepare.mockImplementation((input) => {
      const captured = structuredClone(input);
      return async (scope) => {
        expect(() => f.authority.dispatchInScope('session', nested)).toThrow();
        f.order.push('effect');
        return { status: 'committed' as const, value: { input: captured, scope } };
      };
    });
    await expect(f.port.execute('session', operator, protectedRequest())).resolves.toMatchObject({
      status: 'committed',
    });
    expect(nested).not.toHaveBeenCalled();
    expect(f.order).toContain('effect');
  });

  it('replays an acknowledged protected result without preparing or consuming again', async () => {
    const f = await fixture();
    await expect(f.port.execute('session', operator, protectedRequest())).resolves.toMatchObject({
      status: 'committed',
    });
    f.prepare.mockClear();
    f.policy.mockClear();
    f.consume.mockClear();

    await expect(f.port.execute('session', operator, protectedRequest())).resolves.toMatchObject({
      replay: true,
      operation: { status: 'completed', dispatched: true },
    });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.policy).not.toHaveBeenCalled();
    expect(f.consume).not.toHaveBeenCalled();
    expect(f.controlled.calls.reserveIntent).toBe(1);
    expect(f.controlled.calls.markDispatch).toBe(1);
  });
});

it('leaves application writes ephemeral when trusted journal selection is disabled', async () => {
  const f = await fixture({ journalWrites: false });
  await expect(f.port.execute('session', operator, ordinaryRequest())).resolves.toMatchObject({
    status: 'committed',
  });
  expect(f.controlled.calls.reserveIntent).toBe(0);
  expect(f.controlled.calls.markDispatch).toBe(0);
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.order).toContain('effect');
});

it('refuses trusted application journal selection when no journal is configured', async () => {
  const f = await fixture({ journalWrites: true, omitJournal: true });
  await expect(f.port.execute('session', operator, ordinaryRequest())).rejects.toMatchObject({
    code: 'CONTROL_REQUIRED',
  });
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.order).not.toContain('effect');
});

it('reauthorizes direct application replay without preparing or consuming again', async () => {
  const f = await fixture();
  await f.port.execute('session', operator, protectedRequest());
  f.setAuthorized(false);
  await expect(f.port.execute('session', operator, protectedRequest())).rejects.toMatchObject({
    code: 'CONTROL_REQUIRED',
  });
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.consume).toHaveBeenCalledOnce();
  expect(f.order.filter((entry) => entry === 'effect')).toHaveLength(1);
});
