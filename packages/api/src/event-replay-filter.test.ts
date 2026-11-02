import { JsonLedger, SecretManager, SessionCoordinator } from '@agentbrowser/core';
import type { EngineEvent } from '@agentbrowser/engine';
import { EVENT_REPLAY_MAX_RESPONSE_BYTES, type EventReplaySelector } from '@agentbrowser/protocol';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentBrowserService } from './service.js';

const services: AgentBrowserService[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
});

async function fixture(options: { controlled?: boolean; secrets?: SecretManager } = {}) {
  const secrets = options.secrets ?? new SecretManager();
  const coordinator = new SessionCoordinator();
  const service = new AgentBrowserService({
    engine: new FakeEngine(),
    secretManager: secrets,
    coordinator,
  });
  services.push(service);
  const { sessionId } = await service.createSession({
    tenantId: 'owner',
    scope: { allowedHosts: ['app.test'] },
    ...(options.controlled ? { controlMode: 'delegated' as const } : {}),
  });
  const record = (type: EngineEvent['type'], data: Record<string, unknown> = {}) => {
    const event: EngineEvent = { type, sessionId, timestamp: '2026-11-02T00:00:00.000Z', data };
    return (
      service as unknown as { recordEvent(id: string, value: EngineEvent): boolean }
    ).recordEvent(sessionId, event);
  };
  const read = (selector: EventReplaySelector = { stream: 'request' }) =>
    service.getSessionEvents(sessionId, selector);
  return { service, sessionId, secrets, coordinator, record, read };
}

it('preserves all legacy return shapes and acknowledges every new selector including false', async () => {
  const f = await fixture();
  f.record('console.log', { message: 'hello' });
  f.record('request.finished', { url: 'https://app.test/', status: 200 });
  expect(f.service.getSessionEvents(f.sessionId)).toHaveLength(2);
  expect(f.service.getSessionEvents(f.sessionId, 'console.log')).toHaveLength(1);
  expect(f.read({})).toMatchObject({ events: expect.any(Array), nextCursor: -1 });
  expect(f.read({ type: 'console.log' })).not.toHaveProperty('filter');
  expect(f.read({ type: 'request.finished', limit: 1 })).toMatchObject({
    nextCursor: 0,
    oldestSeq: 0,
    gap: false,
  });
  expect(f.read({ type: 'request.finished', limit: 1 })).not.toHaveProperty('filter');
  for (const selector of [
    { failedOnly: false },
    { urlRegex: '' },
    { stream: 'request' as const },
  ]) {
    expect(f.read(selector)).toMatchObject({
      events: [{ seq: 0 }],
      filter: { version: 1, stream: 'request' },
    });
  }
  expect(f.read({ stream: 'other' })).toMatchObject({
    events: [{ type: 'console.log', seq: 0 }],
    filter: { version: 1, stream: 'other' },
  });
});

it.each([
  null,
  [],
  { unknown: true },
  { since: 0 },
  { stream: 'other', method: 'GET' },
  { stream: 'request', type: 'console.log' },
  { failedOnly: 'true' },
  { method: 'get' },
  { limit: 1001, stream: 'request' },
  { since: 1.5, stream: 'request' },
])('refuses malformed or conflicting object selectors: %j', async (selector) => {
  const f = await fixture();
  expect(() => f.read(selector as EventReplaySelector)).toThrow(
    expect.objectContaining({ code: 'INVALID_REQUEST' })
  );
});

it('refuses selector accessors without invoking them', async () => {
  const f = await fixture();
  const getter = vi.fn(() => {
    throw new Error('must not invoke accessor');
  });
  const selector = Object.defineProperty({}, 'stream', { get: getter, enumerable: true });
  expect(() => f.read(selector)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  expect(getter).not.toHaveBeenCalled();
});

it('combines facts with AND and distinguishes target errors, policy denials, transport failures and unknown intent', async () => {
  const f = await fixture();
  f.record('request.started', { url: 'https://app.test/api/start', method: 'GET', status: 200 });
  f.record('request.finished', { url: 'https://app.test/api/ok', method: 'GET', status: 201 });
  f.record('request.finished', {
    url: 'https://app.test/api/forbidden',
    method: 'GET',
    status: 403,
  });
  f.record('request.finished', {
    url: 'https://app.test/assets/error',
    method: 'GET',
    status: 503,
  });
  f.record('request.finished', { url: 'https://app.test/api/unknown', method: 'GET' });
  f.record('request.finished', {
    url: 'https://app.test/api/passthrough',
    method: 'GET',
    status: 403,
    passthrough: true,
  });
  f.record('request.failed', {
    url: 'https://app.test/api/transport',
    method: 'POST',
    error: 'connection reset',
  });
  f.record('request.failed', {
    url: 'https://app.test/api/denied',
    method: 'GET',
    scope: 'SCOPE_RATE_LIMITED',
    blocked: true,
  });
  f.record('scope.denied', {
    url: 'https://app.test/api/denied',
    method: 'GET',
    scope: 'SCOPE_RATE_LIMITED',
  });
  expect(
    f
      .read({ method: 'GET', urlRegex: '/api/', statusClass: '4xx' })
      .events.map((e) => e.data?.status)
  ).toEqual([403]);
  expect(f.read({ statusClass: '2xx' }).events).toHaveLength(1);
  expect(f.read({ statusClass: '5xx' }).events).toHaveLength(1);
  expect(f.read({ statusClass: 'denied' }).events).toMatchObject([{ type: 'request.failed' }]);
  expect(f.read({ statusClass: 'denied', type: 'scope.denied' }).events).toHaveLength(1);
  expect(f.read({ failedOnly: true }).events.map((e) => e.type)).toEqual([
    'request.finished',
    'request.finished',
    'request.failed',
    'request.failed',
  ]);
  expect(f.read({ failedOnly: false }).events).toHaveLength(8);
});

it('uses only the same published URL for display and search, and re-redacts retained values and keys before predicates', async () => {
  const f = await fixture();
  const secret = 'LateSessionSecret-123456';
  f.record('request.finished', {
    url: `https://user:password@app.test/${secret}?hidden=query#fragment`,
    method: secret,
    [secret]: secret,
    status: 200,
  });
  f.secrets.registerSessionSecret(f.sessionId, secret);
  const page = f.read({ urlRegex: 'app\\.test/' });
  expect(page.events[0]?.data?.url).toBe('https://app.test/***');
  expect(JSON.stringify(page)).not.toContain(secret);
  expect(page.events[0]?.data).toMatchObject({ '***': '***' });
  expect(f.read({ urlRegex: secret }).events).toEqual([]);
  expect(f.read({ urlRegex: 'user|password|query|fragment' }).events).toEqual([]);
  page.events[0]!.data!.url = 'caller mutation';
  expect(f.read().events[0]?.data?.url).toBe('https://app.test/***');
});

it('advances past skipped entries, keeps pages disjoint, reports eviction gaps and receipts on empty pages', async () => {
  const f = await fixture();
  for (let index = 0; index < 1005; index++)
    f.record('request.finished', { status: index % 2 ? 200 : 404 });
  const first = f.read({ statusClass: '4xx', since: -1, limit: 2 });
  expect(first).toMatchObject({ oldestSeq: 5, gap: true, nextCursor: 8 });
  expect(first.events.map((e) => (e as EngineEvent & { seq: number }).seq)).toEqual([6, 8]);
  const next = f.read({ statusClass: '4xx', since: first.nextCursor, limit: 2 });
  expect(next.events.map((e) => (e as EngineEvent & { seq: number }).seq)).toEqual([10, 12]);
  const none = f.read({ method: 'DELETE', since: 1000 });
  expect(none).toMatchObject({
    events: [],
    nextCursor: 1004,
    gap: false,
    filter: { version: 1, stream: 'request' },
  });
  expect(f.read({ stream: 'other' })).toEqual({
    events: [],
    nextCursor: -1,
    oldestSeq: 0,
    gap: false,
    filter: { version: 1, stream: 'other' },
  });
});

it('does not extend a snapshot when redaction reentrantly adds an event', async () => {
  const f = await fixture();
  f.record('request.finished', { status: 200 });
  const capture = f.secrets.captureRegisteredScopedRedactor.bind(f.secrets);
  let inserted = false;
  vi.spyOn(f.secrets, 'captureRegisteredScopedRedactor').mockImplementation((id) => {
    const redact = capture(id)!;
    return (input, keys) => {
      if (!inserted) {
        inserted = true;
        f.record('request.finished', { status: 201 });
      }
      return redact(input, keys);
    };
  });
  expect(f.read().events).toHaveLength(1);
  expect(f.read({ stream: 'request', since: 0 }).events).toHaveLength(1);
});

it('budgets exact complete UTF-8 envelopes, stops before overflow and leaves the match eligible', async () => {
  const f = await fixture();
  // A larger test-only ledger isolates response sizing from production retention caps.
  const ledger = new JsonLedger<EngineEvent>({
    maxEntries: 10,
    maxBytes: 2 ** 20,
    maxEntryBytes: 2 ** 20,
  });
  (
    f.service as unknown as { requestHistory: Map<string, JsonLedger<EngineEvent>> }
  ).requestHistory.set(f.sessionId, ledger);
  const event: EngineEvent = {
    type: 'request.finished',
    sessionId: f.sessionId,
    timestamp: '2026-11-02T00:00:00.000Z',
    data: { text: '🙂\\"' },
  };
  const envelope = {
    events: [{ ...event, seq: 0 }],
    nextCursor: 0,
    oldestSeq: 0,
    gap: false,
    filter: { version: 1, stream: 'request' },
  };
  const padding = EVENT_REPLAY_MAX_RESPONSE_BYTES - Buffer.byteLength(JSON.stringify(envelope));
  event.data!.text += 'x'.repeat(padding);
  ledger.push(event);
  ledger.push({ ...event, data: { text: 'next' } });
  const first = f.read();
  expect(Buffer.byteLength(JSON.stringify(first))).toBe(EVENT_REPLAY_MAX_RESPONSE_BYTES);
  expect(first.nextCursor).toBe(0);
  expect(first.events).toHaveLength(1);
  expect(f.read({ stream: 'request', since: first.nextCursor }).events).toMatchObject([
    { data: { text: 'next' }, seq: 1 },
  ]);
});

it('accounts for cursor digit growth on skipped rows and refuses a single expanded oversized row without advancing', async () => {
  const f = await fixture({ secrets: new SecretManager({ 'vault://short': '~' }) });
  const ledger = new JsonLedger<EngineEvent>({
    maxEntries: 20,
    maxBytes: 2 ** 20,
    maxEntryBytes: 2 ** 20,
  });
  (
    f.service as unknown as { requestHistory: Map<string, JsonLedger<EngineEvent>> }
  ).requestHistory.set(f.sessionId, ledger);
  const event: EngineEvent = {
    type: 'request.finished',
    sessionId: f.sessionId,
    timestamp: '2026-11-02T00:00:00.000Z',
    data: { text: '', method: 'GET' },
  };
  const envelope = {
    events: [{ ...event, seq: 0 }],
    nextCursor: 0,
    oldestSeq: 0,
    gap: false,
    filter: { version: 1, stream: 'request' },
  };
  event.data!.text = 'x'.repeat(
    EVENT_REPLAY_MAX_RESPONSE_BYTES - Buffer.byteLength(JSON.stringify(envelope))
  );
  ledger.push(event);
  for (let index = 1; index <= 10; index++) ledger.push({ ...event, data: { method: 'POST' } });
  expect(f.read({ method: 'GET' })).toMatchObject({ nextCursor: 9, events: [{ seq: 0 }] });
  const expanded = new JsonLedger<EngineEvent>({
    maxEntries: 2,
    maxBytes: 2 ** 20,
    maxEntryBytes: 2 ** 20,
  });
  (
    f.service as unknown as { requestHistory: Map<string, JsonLedger<EngineEvent>> }
  ).requestHistory.set(f.sessionId, expanded);
  expanded.push({ ...event, data: { text: '~'.repeat(90000) } });
  expect(() => f.read()).toThrow(
    expect.objectContaining({ code: 'OUTPUT_TRUNCATED', details: { rule: 'floor.events.output' } })
  );
  expect(() => f.read()).toThrow(expect.objectContaining({ code: 'OUTPUT_TRUNCATED' }));
});

it('admits operator reads during human control but refuses missing or revoked delegated authority', async () => {
  const f = await fixture({ controlled: true });
  f.record('request.finished', { status: 200 });
  expect(() => f.read()).toThrow(expect.objectContaining({ code: 'CONTROL_REQUIRED' }));
  await expect(
    f.service.authority.run(f.sessionId, { actor: 'operator', tenant: 'owner' }, {}, async () =>
      f.read()
    )
  ).resolves.toMatchObject({ events: [{ data: { status: 200 } }] });
  const review = f.service.authority.get(f.sessionId)!.prepareResume();
  const principal = f.service.authority.authenticate(
    f.service.authority.delegate(f.sessionId, review.epoch, 'qa').token
  )!;
  await expect(
    f.service.authority.run(f.sessionId, principal, {}, async () => {
      f.service.authority.takeover(f.sessionId);
      return f.read();
    })
  ).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
});

it.each(['close', 'fault', 'collision'] as const)(
  'refuses reentrant %s publication safely',
  async (mode) => {
    const f = await fixture();
    const secret = 'FaultMustNotLeak-123456';
    f.record('request.finished', { url: 'https://app.test/', [secret]: 'a', '***': 'b' });
    const capture = f.secrets.captureRegisteredScopedRedactor.bind(f.secrets);
    let closing: Promise<void> | undefined;
    let fired = false;
    vi.spyOn(f.secrets, 'captureRegisteredScopedRedactor').mockImplementation((id) => {
      const redact = capture(id)!;
      return (input, keys) => {
        if (!fired) {
          fired = true;
          if (mode === 'close') closing = f.service.closeSession(f.sessionId);
          if (mode === 'fault') throw new Error(secret);
          if (mode === 'collision') f.secrets.registerSessionSecret(f.sessionId, secret);
        }
        return redact(input, keys);
      };
    });
    if (mode === 'collision') {
      const page = f.read();
      expect(page.events[0]?.data).toMatchObject({ '***': 'a', '***#1': 'b' });
      expect(JSON.stringify(page)).not.toContain(secret);
    } else {
      let failure: unknown;
      try {
        f.read();
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: mode === 'close' ? 'CONTROL_REVOKED' : 'INTERNAL' });
      expect(String(failure)).not.toContain(secret);
    }
    await closing;
  }
);

it.each([false, true])(
  'pins the captured owner across forced ID reuse (redactor fault=%s)',
  async (fault) => {
    const f = await fixture();
    f.record('request.finished', { status: 200 });
    const next = await f.service.createSession({
      tenantId: 'owner',
      scope: { allowedHosts: ['next.test'] },
    });
    const oldOwner = f.coordinator.captureForCleanup(f.sessionId)!;
    const nextOwner = f.coordinator.captureForCleanup(next.sessionId)!;
    const owners = (f.coordinator as unknown as { sessions: Map<string, typeof oldOwner> })
      .sessions;
    const scopes = (f.service as unknown as { sessionScopes: Map<string, { stopped?: string }> })
      .sessionScopes;
    const oldScope = scopes.get(f.sessionId)!;
    const nextScope = scopes.get(next.sessionId)!;
    const capture = f.secrets.captureRegisteredScopedRedactor.bind(f.secrets);
    let replaced = false;
    let oldFault = false;
    const replacementSecret = 'ReplacementOwnerSecret-654321';
    vi.spyOn(f.secrets, 'captureRegisteredScopedRedactor').mockImplementation((id) => {
      const redact = capture(id)!;
      return (input, keys) => {
        if (!replaced) {
          replaced = true;
          // Production allocation refuses collisions; inject same-text ownership
          // replacement to model a stale callback crossing allocations.
          owners.set(f.sessionId, nextOwner);
          scopes.set(f.sessionId, nextScope);
          f.secrets.clearSessionSecrets(f.sessionId);
          f.secrets.registerSessionSecret(f.sessionId, replacementSecret);
          oldFault = fault;
        }
        if (oldFault) throw new Error('old-owner-private-error');
        return redact(input, keys);
      };
    });
    try {
      let failure: unknown;
      try {
        f.read();
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: fault ? 'INTERNAL' : 'CONTROL_REVOKED' });
      expect(String(failure)).not.toContain('old-owner-private-error');
      expect(nextScope.stopped).toBeUndefined();
      expect(f.secrets.redactScoped(replacementSecret, f.sessionId)).toBe('***');
      expect(nextOwner.signal.aborted).toBe(false);
    } finally {
      oldFault = false;
      owners.set(f.sessionId, oldOwner);
      scopes.set(f.sessionId, oldScope);
    }
  }
);
