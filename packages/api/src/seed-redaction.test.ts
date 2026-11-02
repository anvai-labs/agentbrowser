import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretManager, SessionCoordinator, verifyEngagementLedger } from '@agentbrowser/core';
import type { EngineSessionOptions } from '@agentbrowser/engine';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { EngagementLedger } from './engagement-ledger.js';
import { AgentBrowserService, ServiceError } from './service.js';

const COOKIE = 'InitialSeedCookieSecret-123456';
const record = (secret = COOKIE) => ({
  type: 'request.failed' as const,
  timestamp: new Date().toISOString(),
  data: { url: `https://app.test/${secret}`, method: 'PUT', scope: 'SCOPE_METHOD_DENIED' },
});

it('registers the detached cookie seed before engine work and protects early ledger records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seed-redaction-'));
  const engine = new FakeEngine();
  const secrets = new SecretManager();
  const register = vi.spyOn(secrets, 'initializeSessionSecrets');
  const cookies = [{ name: 'session', value: COOKIE, domain: 'app.test', path: '/' }];
  const create = engine.createSession.bind(engine);
  let options: EngineSessionOptions | undefined;
  vi.spyOn(engine, 'createSession').mockImplementation(async (input) => {
    options = input;
    expect(register).toHaveBeenCalledWith(expect.any(String), [COOKIE]);
    expect(input?.cookies?.[0]?.value).toBe(COOKIE);
    cookies[0]!.value = 'caller-mutated-cookie-secret';
    expect(input?.cookies?.[0]?.value).toBe(COOKIE);
    input?.requestRecorder?.(record());
    return create(input);
  });
  const service = new AgentBrowserService({
    engine,
    secretManager: secrets,
    engagement: { directory },
  });
  try {
    const session = await service.createSession({
      cookies,
      scope: { allowedHosts: ['app.test'], ledger: true },
    });
    expect(register.mock.calls[0]![0]).toBe(session.sessionId);
    expect(secrets.redactScoped(COOKIE, session.sessionId)).toBe('***');
    await service.closeSession(session.sessionId);
    options?.requestRecorder?.(record());
    const files = (await readdir(directory, { recursive: true })).filter((file) =>
      file.endsWith('.jsonl')
    );
    const ledger = (
      await Promise.all(files.map((file) => readFile(join(directory, file), 'utf8')))
    ).join('\n');
    expect(verifyEngagementLedger(ledger)).toMatchObject({ ok: true, closed: true });
    const rows = ledger
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rows).toContainEqual(
      expect.objectContaining({
        type: 'request',
        data: expect.objectContaining({
          outcome: 'failed',
          scope: 'SCOPE_METHOD_DENIED',
          url: 'https://app.test/***',
        }),
      })
    );
    expect(ledger).not.toContain(COOKIE);
  } finally {
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

it('redacts allocation failure before clearing the seed registry', async () => {
  const engine = new FakeEngine();
  const secrets = new SecretManager();
  const register = vi.spyOn(secrets, 'initializeSessionSecrets');
  vi.spyOn(engine, 'createSession').mockImplementation(async () => {
    throw new ServiceError('POLICY_DENIED', `Allocation failed ${COOKIE}`, false, {
      diagnostic: COOKIE,
    });
  });
  const service = new AgentBrowserService({ engine, secretManager: secrets });
  try {
    const failure = await service
      .createSession({
        cookies: [{ name: 'session', value: COOKIE, domain: 'app.test', path: '/' }],
      })
      .catch((error) => error);
    expect(failure).toMatchObject({ code: 'POLICY_DENIED' });
    expect(failure.message).not.toContain(COOKIE);
    expect(JSON.stringify(failure.details)).not.toContain(COOKIE);
    const owner = register.mock.calls[0]![0];
    expect(secrets.redactScoped(COOKIE, owner)).toBe(COOKIE);
  } finally {
    await service.shutdown();
  }
});

it('does not attribute old recorder events to a new owner after textual session ID reuse', async () => {
  const coordinator = new SessionCoordinator();
  vi.spyOn(coordinator as any, 'generateSessionId').mockReturnValue('s_reused_owner');
  const engine = new FakeEngine();
  const create = vi.spyOn(engine, 'createSession');
  const service = new AgentBrowserService({ engine, coordinator });
  try {
    const first = await service.createSession({
      tenantId: 'first',
      mode: 'bounty',
      cookies: [{ name: 'session', value: COOKIE, domain: 'app.test', path: '/' }],
      scope: { allowedHosts: ['app.test'] },
    });
    const oldRecorder = create.mock.calls[0]![0]!.requestRecorder!;
    await service.closeSession(first.sessionId);
    const second = await service.createSession({
      tenantId: 'second',
      mode: 'bounty',
      scope: { allowedHosts: ['app.test'] },
    });
    expect(second.sessionId).toBe(first.sessionId);
    const events: unknown[] = [];
    const unsubscribe = service.subscribe(second.sessionId, (event) => events.push(event));
    oldRecorder(record());
    expect(events).toEqual([]);
    unsubscribe();
  } finally {
    await service.shutdown();
  }
});

it('refuses a broken eager capture before starting an engine and cleans its registry', async () => {
  const engine = new FakeEngine();
  const secrets = new SecretManager();
  const initialize = vi.spyOn(secrets, 'initializeSessionSecrets');
  vi.spyOn(secrets, 'captureRegisteredScopedRedactor').mockReturnValue(() => {
    throw new Error(COOKIE);
  });
  const create = vi.spyOn(engine, 'createSession');
  const service = new AgentBrowserService({ engine, secretManager: secrets });
  try {
    const failure = await service
      .createSession({
        cookies: [{ name: 'session', value: COOKIE, domain: 'app.test', path: '/' }],
        scope: { allowedHosts: ['app.test'] },
      })
      .catch((error) => error);
    expect(create).not.toHaveBeenCalled();
    expect(JSON.stringify(failure)).not.toContain(COOKIE);
    expect(failure.message).not.toContain(COOKIE);
    expect(secrets.redactScoped(COOKIE, initialize.mock.calls[0]![0])).toBe(COOKIE);
    expect(service.listSessions()).toEqual([]);
  } finally {
    await service.shutdown();
  }
});

it('halts the exact scope even when the engine swallows a later recorder redaction failure', async () => {
  const engine = new FakeEngine();
  const secrets = new SecretManager();
  const originalCapture = secrets.captureRegisteredScopedRedactor.bind(secrets);
  let calls = 0;
  vi.spyOn(secrets, 'captureRegisteredScopedRedactor').mockImplementation((id) => {
    const redact = originalCapture(id);
    return (value) => {
      if (++calls > 1) throw new Error(COOKIE);
      return redact?.(value) ?? value;
    };
  });
  const create = engine.createSession.bind(engine);
  let policy: EngineSessionOptions['requestPolicy'];
  vi.spyOn(engine, 'createSession').mockImplementation(async (options) => {
    policy = options?.requestPolicy;
    try {
      options?.requestRecorder?.(record());
    } catch {
      /* Native hooks isolate recorder errors. */
    }
    return create(options);
  });
  const service = new AgentBrowserService({ engine, secretManager: secrets });
  try {
    const failure = await service
      .createSession({
        cookies: [{ name: 'session', value: COOKIE, domain: 'app.test', path: '/' }],
        scope: { allowedHosts: ['app.test'] },
      })
      .catch((error) => error);
    expect(failure).toMatchObject({ code: 'INTERNAL' });
    expect(JSON.stringify(failure)).not.toContain(COOKIE);
    await expect(
      policy!.checkRequest({
        hostname: 'app.test',
        url: 'https://app.test/after-recorder-failure',
        method: 'GET',
      })
    ).rejects.toMatchObject({ details: { scope: 'SCOPE_LEDGER_UNAVAILABLE' } });
    expect(service.listSessions()).toEqual([]);
  } finally {
    await service.shutdown();
  }
});

it('cleans a hidden allocated session even when post-allocation error mapping fails', async () => {
  const engine = new FakeEngine();
  const secrets = new SecretManager();
  const initialize = vi.spyOn(secrets, 'initializeSessionSecrets');
  const original = secrets.captureRegisteredScopedRedactor.bind(secrets);
  let calls = 0;
  vi.spyOn(secrets, 'captureRegisteredScopedRedactor').mockImplementation((id) => {
    const redact = original(id);
    return (value) => {
      if (++calls > 1) throw new Error(COOKIE);
      return redact?.(value) ?? value;
    };
  });
  const service = new AgentBrowserService({ engine, secretManager: secrets });
  try {
    const failure = await service
      .createSession(
        { cookies: [{ name: 'session', value: COOKIE, domain: 'app.test', path: '/' }] },
        async () => {
          throw new ServiceError('POLICY_DENIED', 'Initialization refused');
        }
      )
      .catch((error) => error);
    expect(JSON.stringify(failure)).not.toContain(COOKIE);
    expect(failure.message).not.toContain(COOKIE);
    expect(service.listSessions()).toEqual([]);
    expect(secrets.redactScoped(COOKIE, initialize.mock.calls[0]![0])).toBe(COOKIE);
  } finally {
    await service.shutdown();
  }
});

it('batches a large valid seed before engine work without per-cookie registry compilation', async () => {
  const engine = new FakeEngine();
  const secrets = new SecretManager();
  const compile = vi.spyOn(secrets as any, 'buildSessionPattern');
  const initialize = vi.spyOn(secrets, 'initializeSessionSecrets');
  const cookies = Array.from({ length: 1000 }, (_, i) => ({
    name: `cookie${i}`,
    value: `${'abcD-123456789'.repeat(65)}-cookie-${i}`,
    domain: 'app.test',
    path: '/',
  }));
  expect(Buffer.byteLength(JSON.stringify(cookies))).toBeLessThan(1048576);
  const create = engine.createSession.bind(engine);
  vi.spyOn(engine, 'createSession').mockImplementation(async (options) => {
    expect(compile).toHaveBeenCalledOnce();
    return create(options);
  });
  const service = new AgentBrowserService({ engine, secretManager: secrets });
  try {
    const session = await service.createSession({ cookies });
    expect(initialize).toHaveBeenCalledExactlyOnceWith(
      session.sessionId,
      cookies.map(({ value }) => value)
    );
    expect(compile).toHaveBeenCalledOnce();
    expect(secrets.redactScoped(cookies.at(-1)!.value, session.sessionId)).toBe('***');
  } finally {
    await service.shutdown();
  }
});

it('a late failed recorder halts only its captured scope after the ID belongs to another owner', async () => {
  const coordinator = new SessionCoordinator();
  vi.spyOn(coordinator as any, 'generateSessionId').mockReturnValue('s_reused_owner');
  const engine = new FakeEngine();
  const create = vi.spyOn(engine, 'createSession');
  const secrets = new SecretManager();
  const originalCapture = secrets.captureRegisteredScopedRedactor.bind(secrets);
  let failOld = false;
  vi.spyOn(secrets, 'captureRegisteredScopedRedactor').mockImplementation((id) => {
    const old = secrets.redactScoped(COOKIE, id) === '***';
    const redact = originalCapture(id);
    return (value) => {
      if (old && failOld) throw new Error(COOKIE);
      return redact?.(value) ?? value;
    };
  });
  const service = new AgentBrowserService({ engine, coordinator, secretManager: secrets });
  const nextCookie = 'ReplacementSeedCookie-987654';
  try {
    const first = await service.createSession({
      cookies: [{ name: 'session', value: COOKIE, domain: 'app.test', path: '/' }],
      scope: { allowedHosts: ['app.test'] },
    });
    const old = create.mock.calls[0]![0]!;
    await service.closeSession(first.sessionId);
    const second = await service.createSession({
      cookies: [{ name: 'session', value: nextCookie, domain: 'app.test', path: '/' }],
      scope: { allowedHosts: ['app.test'] },
    });
    failOld = true;
    old.requestRecorder!(record());
    await expect(
      old.requestPolicy!.checkRequest({
        hostname: 'app.test',
        url: 'https://app.test/old',
        method: 'GET',
      })
    ).rejects.toMatchObject({ details: { scope: 'SCOPE_LEDGER_UNAVAILABLE' } });
    await expect(
      create.mock.calls[1]![0]!.requestPolicy!.checkRequest({
        hostname: 'app.test',
        url: 'https://app.test/new',
        method: 'GET',
      })
    ).resolves.toBeUndefined();
    expect(service.getScopeStatus(second.sessionId).stopped).toBeUndefined();
    expect(secrets.redactScoped(nextCookie, second.sessionId)).toBe('***');
  } finally {
    await service.shutdown();
  }
});

it('old close cleanup cannot clear a replacement owner created before its finally resumes', async () => {
  const coordinator = new SessionCoordinator();
  vi.spyOn(coordinator as any, 'generateSessionId').mockReturnValue('s_reused_owner');
  const secrets = new SecretManager();
  const service = new AgentBrowserService({
    engine: new FakeEngine(),
    coordinator,
    secretManager: secrets,
  });
  const nextCookie = 'ReplacementSeedCookie-987654';
  let replacement: Awaited<ReturnType<AgentBrowserService['createSession']>> | undefined;
  let restore: (() => void) | undefined;
  try {
    const first = await service.createSession({
      cookies: [{ name: 'session', value: COOKIE, domain: 'app.test', path: '/' }],
      scope: { allowedHosts: ['app.test'] },
    });
    const close = coordinator.close.bind(coordinator);
    const spy = vi.spyOn(coordinator, 'close').mockImplementation(async (id) => {
      await close(id);
      replacement = await service.createSession({
        cookies: [{ name: 'session', value: nextCookie, domain: 'app.test', path: '/' }],
        scope: { allowedHosts: ['app.test'] },
      });
    });
    restore = () => spy.mockRestore();
    await service.closeSession(first.sessionId);
    restore();
    expect(replacement!.sessionId).toBe(first.sessionId);
    expect(service.getScopeStatus(replacement!.sessionId).allowedHosts).toEqual(['app.test']);
    expect(secrets.redactScoped(nextCookie, replacement!.sessionId)).toBe('***');
    expect(service.listSessions()).toHaveLength(1);
  } finally {
    restore?.();
    await service.shutdown();
  }
});

it('late old creation cannot replace a new owner cleanup before its context fence', async () => {
  const coordinator = new SessionCoordinator();
  vi.spyOn(coordinator as any, 'generateSessionId').mockReturnValue('s_reused_owner');
  const secrets = new SecretManager();
  const service = new AgentBrowserService({
    engine: new FakeEngine(),
    coordinator,
    secretManager: secrets,
  });
  const nextCookie = 'ReplacementSeedCookie-987654';
  const create = coordinator.createOwned.bind(coordinator);
  let replacement: Awaited<ReturnType<AgentBrowserService['createSession']>> | undefined;
  let first = true;
  vi.spyOn(coordinator, 'createOwned').mockImplementation(async (...args) => {
    const allocation = await create(...args);
    if (first) {
      first = false;
      await coordinator.close(allocation.response.sessionId);
      replacement = await service.createSession({
        cookies: [{ name: 'session', value: nextCookie, domain: 'app.test', path: '/' }],
        scope: { allowedHosts: ['app.test'] },
      });
    }
    return allocation;
  });
  try {
    await expect(
      service.createSession({
        cookies: [{ name: 'session', value: COOKIE, domain: 'app.test', path: '/' }],
        scope: { allowedHosts: ['app.test'] },
      })
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(replacement).toBeDefined();
    const id = replacement!.sessionId;
    expect(coordinator.getSessionCount()).toBe(1);
    expect(service.getScopeStatus(id).allowedHosts).toEqual(['app.test']);
    expect(secrets.redactScoped(nextCookie, id)).toBe('***');
    await service.closeSession(id);
    expect(coordinator.getSessionCount()).toBe(0);
    expect(secrets.redactScoped(nextCookie, id)).toBe(nextCookie);
    expect(secrets.redactScoped(COOKIE, id)).toBe(COOKIE);
  } finally {
    await service.shutdown();
  }
});

it.each(['complete', 'fail'] as const)(
  'late ledger %s cannot publish or close a replacement owner',
  async (outcome) => {
    const directory = await mkdtemp(join(tmpdir(), 'seed-late-ledger-'));
    const coordinator = new SessionCoordinator();
    vi.spyOn(coordinator as any, 'generateSessionId').mockReturnValue('s_reused_ledger_owner');
    const secrets = new SecretManager();
    const service = new AgentBrowserService({
      engine: new FakeEngine(),
      coordinator,
      secretManager: secrets,
      engagement: { directory },
    });
    const nextCookie = 'ReplacementSeedCookie-987654';
    const open = EngagementLedger.open.bind(EngagementLedger);
    let replacement: Awaited<ReturnType<AgentBrowserService['createSession']>> | undefined;
    const spy = vi.spyOn(EngagementLedger, 'open').mockImplementation(async (...args) => {
      const ledger = outcome === 'complete' ? await open(...args) : undefined;
      await coordinator.close('s_reused_ledger_owner');
      replacement = await service.createSession({
        cookies: [{ name: 'session', value: nextCookie, domain: 'app.test', path: '/' }],
        scope: { allowedHosts: ['app.test'] },
      });
      if (!ledger) throw new Error('fixture ledger allocation failed');
      return ledger;
    });
    try {
      await expect(
        service.createSession({
          cookies: [{ name: 'session', value: COOKIE, domain: 'app.test', path: '/' }],
          scope: { allowedHosts: ['app.test'], ledger: true },
        })
      ).rejects.toMatchObject({ code: outcome === 'complete' ? 'SESSION_NOT_FOUND' : 'INTERNAL' });
      expect(replacement).toBeDefined();
      const id = replacement!.sessionId;
      expect(coordinator.getSessionCount()).toBe(1);
      expect(service.getSession(id)?.engagementId).toBeUndefined();
      expect(secrets.redactScoped(nextCookie, id)).toBe('***');
      await service.closeSession(id);
      expect(coordinator.getSessionCount()).toBe(0);
      expect(secrets.redactScoped(nextCookie, id)).toBe(nextCookie);
      if (outcome === 'complete') {
        const files = (await readdir(directory, { recursive: true })).filter((file) =>
          file.endsWith('.jsonl')
        );
        expect(files).toHaveLength(1);
        const ledger = await readFile(join(directory, files[0]!), 'utf8');
        expect(verifyEngagementLedger(ledger)).toMatchObject({ ok: true, closed: true });
      }
    } finally {
      spy.mockRestore();
      await service.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

it('records a fixed failure marker and stops traffic when an active ledger recorder loses redaction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seed-recorder-failure-'));
  const engine = new FakeEngine();
  const create = vi.spyOn(engine, 'createSession');
  const secrets = new SecretManager();
  const original = secrets.captureRegisteredScopedRedactor.bind(secrets);
  let broken = false;
  vi.spyOn(secrets, 'captureRegisteredScopedRedactor').mockImplementation((id) => {
    const redact = original(id);
    return (value) => {
      if (broken) throw new Error(COOKIE);
      return redact?.(value) ?? value;
    };
  });
  const service = new AgentBrowserService({
    engine,
    secretManager: secrets,
    engagement: { directory },
  });
  try {
    const session = await service.createSession({
      cookies: [{ name: 'session', value: COOKIE, domain: 'app.test', path: '/' }],
      scope: { allowedHosts: ['app.test'], ledger: true },
    });
    broken = true;
    const options = create.mock.calls[0]![0]!;
    options.requestRecorder!(record());
    expect(service.getScopeStatus(session.sessionId).stopped).toBe('request recording unavailable');
    await expect(
      options.requestPolicy!.checkRequest({
        hostname: 'app.test',
        url: 'https://app.test/after-recorder-failure',
        method: 'GET',
      })
    ).rejects.toMatchObject({ details: { scope: 'SCOPE_LEDGER_UNAVAILABLE' } });
    await service.closeSession(session.sessionId);
    const files = (await readdir(directory, { recursive: true })).filter((file) =>
      file.endsWith('.jsonl')
    );
    const ledger = (
      await Promise.all(files.map((file) => readFile(join(directory, file), 'utf8')))
    ).join('\n');
    expect(verifyEngagementLedger(ledger)).toMatchObject({ ok: true, closed: true });
    expect(ledger).toContain('recording.failed');
    expect(ledger).toContain('redaction_unavailable');
    expect(ledger).not.toContain(COOKIE);
  } finally {
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
