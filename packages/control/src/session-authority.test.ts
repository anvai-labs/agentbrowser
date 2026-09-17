import type { EnginePage } from '@agentbrowser/engine';
import { afterEach, expect, it, vi } from 'vitest';
import { ApplicationSessions } from './application-authority.js';
import { SessionAuthority, type SessionPrincipal } from './session-authority.js';

const operator: SessionPrincipal = { actor: 'operator', tenant: 'owner' };
afterEach(() => vi.useRealTimers());

function grant(authority: SessionAuthority, id: string) {
  const review = authority.get(id)!.prepareResume();
  const { token } = authority.delegate(id, review.epoch);
  return { token, principal: authority.authenticate(token)! };
}

it('binds a trusted mode to the bearer grant and defaults old callers to qa', () => {
  const authority = new SessionAuthority();
  authority.register('session', 'owner', new AbortController().signal);
  const firstReview = authority.get('session')!.prepareResume();
  const legacy = authority.delegate('session', firstReview.epoch);
  expect(legacy.mode).toBe('qa');
  expect(authority.authenticate(legacy.token)).toMatchObject({ mode: 'qa' });

  authority.takeover('session');
  const nextReview = authority.get('session')!.prepareResume();
  const forms = authority.delegate('session', nextReview.epoch, 'forms');
  expect(forms.mode).toBe('forms');
  expect(authority.authenticate(forms.token)).toMatchObject({ mode: 'forms' });
  expect(authority.authenticate(legacy.token)).toBeUndefined();
});

it('issues non-secret run cursors that isolate service, binding and mode memory', () => {
  const authority = new SessionAuthority();
  authority.register('session', 'owner', new AbortController().signal);
  const firstReview = authority.get('session')!.prepareResume();
  const first = authority.delegate('session', firstReview.epoch, 'qa');
  expect(first.cursor).toMatchObject({
    version: 1,
    sessionId: 'session',
    controlEpoch: first.epoch,
    mode: 'qa',
    profileRevision: 1,
  });
  expect(JSON.stringify(first.cursor)).not.toContain(first.token);
  expect(JSON.stringify(first.cursor)).not.toContain('owner');

  authority.takeover('session');
  const nextReview = authority.get('session')!.prepareResume();
  const next = authority.delegate('session', nextReview.epoch, 'audit');
  expect(next.cursor.serviceGeneration).toBe(first.cursor.serviceGeneration);
  expect(next.cursor.bindingGeneration).not.toBe(first.cursor.bindingGeneration);
  expect(next.cursor.mode).toBe('audit');
  expect(next.cursor.controlEpoch).not.toBe(first.cursor.controlEpoch);

  authority.register('other-session', 'other-account', new AbortController().signal);
  const otherReview = authority.get('other-session')!.prepareResume();
  const other = authority.delegate('other-session', otherReview.epoch, 'audit');
  expect(other.cursor).toMatchObject({ sessionId: 'other-session', mode: 'audit' });
  expect(other.cursor.bindingGeneration).not.toBe(next.cursor.bindingGeneration);
  expect(JSON.stringify(other.cursor)).not.toContain('other-account');

  const replacement = new SessionAuthority();
  replacement.register('session', 'owner', new AbortController().signal);
  const replacementReview = replacement.get('session')!.prepareResume();
  const replaced = replacement.delegate('session', replacementReview.epoch);
  expect(replaced.cursor.serviceGeneration).not.toBe(first.cursor.serviceGeneration);
});

it('keeps the binding cursor stable while existing operation status changes', async () => {
  const authority = new SessionAuthority();
  authority.register('session', 'owner', new AbortController().signal);
  const agent = grant(authority, 'session');
  const cursor = authority.status('session').cursor;
  let release!: () => void;
  const pending = authority.run(
    'session',
    agent.principal,
    { id: 'write-1', fingerprint: 'digest' },
    () =>
      new Promise<void>((resolve) => {
        authority.assert('session', true);
        release = resolve;
      })
  );
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect(authority.status('session')).toMatchObject({
    cursor,
    operation: { operationId: 'write-1', status: 'in_flight', dispatched: true },
  });
  release();
  await pending;
  expect(authority.status('session').cursor).toEqual(cursor);
  expect(authority.status('session')).not.toHaveProperty('operation');
});

it('exposes dispatch state only inside the admitted operation scope', async () => {
  const authority = new SessionAuthority();
  authority.register('session', 'owner', new AbortController().signal);
  expect(() => authority.didDispatchInScope('session')).toThrow();
  await authority.run('session', operator, {}, async () => {
    expect(authority.didDispatchInScope('session')).toBe(false);
    authority.assert('session', true);
    expect(authority.didDispatchInScope('session')).toBe(true);
  });
  expect(() => authority.didDispatchInScope('session')).toThrow();
});

it('rejects duplicate registration without changing an active grant or operation', async () => {
  const authority = new SessionAuthority();
  const owner = new AbortController();
  authority.register('session', 'owner', owner.signal);
  const initial = grant(authority, 'session');
  let release!: () => void;
  const pending = authority.run(
    'session',
    initial.principal,
    {},
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  try {
    const control = authority.get('session');
    expect(() => authority.register('session', 'other', new AbortController().signal)).toThrow();
    expect(authority.get('session')).toBe(control);
    expect(control!.view().busy).toBe(true);
    expect(authority.authenticate(initial.token)).toEqual(initial.principal);
  } finally {
    release();
    await pending;
    owner.abort();
  }
});

it('detaches abort listeners and ignores late callbacks from removed owners', () => {
  const authority = new SessionAuthority();
  const old = new AbortController();
  const add = vi.spyOn(old.signal, 'addEventListener');
  const remove = vi.spyOn(old.signal, 'removeEventListener');
  authority.register('session', 'owner', old.signal);
  const callback = add.mock.calls[0]![1];
  const first = grant(authority, 'session');
  authority.remove('session');
  expect(remove).toHaveBeenCalledWith('abort', callback);
  const next = new AbortController();
  authority.register('session', 'owner', next.signal);
  const second = grant(authority, 'session');
  old.abort();
  if (typeof callback === 'function') callback.call(old.signal, new Event('abort'));
  expect(authority.authenticate(first.token)).toBeUndefined();
  expect(authority.authenticate(second.token)).toEqual(second.principal);
  next.abort();
  expect(authority.get('session')).toBeUndefined();
});

it('keeps a registration incarnation stable and fences a reused session ID', () => {
  const authority = new SessionAuthority();
  authority.register('session', 'owner', new AbortController().signal);
  const first = authority.sessionIncarnation('session');
  expect(authority.sessionIncarnation('session')).toBe(first);
  authority.remove('session');
  expect(() => authority.sessionIncarnation('session')).toThrow();
  authority.register('session', 'owner', new AbortController().signal);
  expect(authority.sessionIncarnation('session')).not.toBe(first);
});

it('cannot use a captured page after removal or under a replacement session', async () => {
  const authority = new SessionAuthority();
  authority.register('session', 'owner', new AbortController().signal);
  const act = vi.fn(async () => ({}));
  const page = authority.guardPage('session', { act } as unknown as EnginePage);
  authority.remove('session');
  expect(() => page.act({ action: 'press', key: 'Tab' })).toThrow();
  authority.register('session', 'owner', new AbortController().signal);
  await expect(
    authority.run('session', operator, {}, () => page.act({ action: 'press', key: 'Tab' }))
  ).rejects.toThrow();
  expect(act).not.toHaveBeenCalled();
  authority.remove('session');
});

it('never converts missing or expired authority into an uncontrolled page', () => {
  let now = 0;
  const authority = new SessionAuthority({ now: () => now });
  authority.register('session', 'owner', new AbortController().signal, { ttlMs: 10 });
  const act = vi.fn();
  const raw = { act } as unknown as EnginePage;
  now = 10;
  // Repeat after the first expiry check removes the entry: absence is not permission.
  for (const id of ['session', 'session', 'unknown']) {
    expect(() => authority.assert(id, true)).toThrow();
    expect(() => authority.guardPage(id, raw)).toThrow();
  }
  expect(act).not.toHaveBeenCalled();
});

it('expires grants and releases capacity at the deadline even before timers run', async () => {
  vi.useFakeTimers();
  let now = 0;
  const sessions = new ApplicationSessions({ maxSessions: 1, now: () => now });
  try {
    const { sessionId } = sessions.create(operator, { ttlMs: 100 });
    const signal = sessions.authority.signal(sessionId);
    const agent = grant(sessions.authority, sessionId);
    now = 99;
    expect(sessions.authority.authenticate(agent.token)).toBeDefined();
    now = 100;
    expect(sessions.authority.authenticate(agent.token)).toBeUndefined();
    expect(signal.aborted).toBe(true);
    const effect = vi.fn(async () => 1);
    await expect(sessions.authority.run(sessionId, operator, {}, effect)).rejects.toThrow();
    expect(effect).not.toHaveBeenCalled();
    expect(() => sessions.create(operator)).not.toThrow();
  } finally {
    sessions.dispose();
  }
});

it('reclaims expired capacity without a prior lookup or timer callback', () => {
  vi.useFakeTimers();
  let now = 0;
  const sessions = new ApplicationSessions({ maxSessions: 1, now: () => now });
  try {
    const old = sessions.create(operator, { ttlMs: 100 });
    const signal = sessions.authority.signal(old.sessionId);
    now = 100;
    expect(() => sessions.create(operator)).not.toThrow();
    expect(signal.aborted).toBe(true);
    expect(sessions.authority.get(old.sessionId)).toBeUndefined();
  } finally {
    sessions.dispose();
  }
});

it('checks deadlines again before dispatch and withholds late output', async () => {
  vi.useFakeTimers();
  let now = 0;
  const sessions = new ApplicationSessions({ now: () => now });
  try {
    const first = sessions.create(operator, { ttlMs: 100 }).sessionId;
    const effect = vi.fn();
    await expect(
      sessions.authority.run(first, operator, { id: 'before', fingerprint: 'a' }, async () => {
        now = 100;
        sessions.authority.assert(first, true);
        effect();
      })
    ).rejects.toThrow();
    expect(effect).not.toHaveBeenCalled();
    const second = sessions.create(operator, { ttlMs: 100 }).sessionId;
    const control = sessions.authority.get(second)!;
    await expect(
      sessions.authority.run(second, operator, { id: 'after', fingerprint: 'b' }, async () => {
        sessions.authority.assert(second, true);
        effect();
        now = 200;
        return 'withheld';
      })
    ).rejects.toThrow();
    expect(effect).toHaveBeenCalledTimes(1);
    expect(control.operation('after')).toMatchObject({
      status: 'outcome_unknown',
      dispatched: true,
    });
  } finally {
    sessions.dispose();
  }
});

it('checks a retained output guard against expiry, not only its original admission', async () => {
  vi.useFakeTimers();
  let now = 0;
  const sessions = new ApplicationSessions({ now: () => now });
  try {
    const id = sessions.create(operator, { ttlMs: 100 }).sessionId;
    let guardError: unknown;
    await expect(
      sessions.authority.run(id, operator, {}, async () => {
        const guard = sessions.authority.outputGuard(id);
        guard();
        now = 100;
        try {
          guard();
        } catch (error) {
          guardError = error;
        }
      })
    ).rejects.toThrow();
    expect(guardError).toMatchObject({ code: 'CONTROL_REVOKED' });
  } finally {
    sessions.dispose();
  }
});
