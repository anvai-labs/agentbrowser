import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryTracer,
  SecretManager,
  SessionCoordinator,
  verifyEngagementLedger,
} from '@agentbrowser/core';
import { EngineError, type EngineSessionOptions } from '@agentbrowser/engine';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { AgentBrowserService, browserFailureOutcomeUnknown } from './service.js';

const COOKIE = 'SeededCookiePrivacyCanary-123456';
const NEXT = 'ReplacementCookiePrivacyCanary-654321';
async function fixture(
  options: {
    delegated?: boolean;
    directory?: string;
    coordinator?: SessionCoordinator;
    secrets?: SecretManager;
  } = {}
) {
  const engine = new FakeEngine();
  const secrets = options.secrets ?? new SecretManager();
  const tracer = new InMemoryTracer();
  const create = vi.spyOn(engine, 'createSession');
  const service = new AgentBrowserService({
    engine,
    secretManager: secrets,
    tracer,
    ...(options.coordinator ? { coordinator: options.coordinator } : {}),
    ...(options.directory ? { engagement: { directory: options.directory } } : {}),
  });
  const session = await service.createSession({
    tenantId: 'owner',
    cookies: [{ name: 'session', value: COOKIE, domain: 'app.test', path: '/' }],
    scope: { allowedHosts: ['app.test'], ...(options.directory ? { ledger: true } : {}) },
    ...(options.delegated ? { controlMode: 'delegated' as const } : {}),
  });
  const operator = <T>(work: () => Promise<T>) =>
    options.delegated
      ? service.authority.run(session.sessionId, { actor: 'operator', tenant: 'owner' }, {}, work)
      : work();
  const page = await operator(() => service.createPage(session.sessionId));
  await operator(() =>
    service.navigate(session.sessionId, page.pageId, { url: 'https://app.test/' })
  );
  const raw = engine.getFakePage(engine.getSessionIds().at(-1)!, page.pageId)!;
  return {
    service,
    session,
    page,
    raw,
    secrets,
    engine,
    tracer,
    operator,
    engineOptions: create.mock.calls[0]![0] as EngineSessionOptions,
  };
}

it('protects cookie strings/keys in both live and retained events without using another tenant registry', async () => {
  const f = await fixture();
  const events: unknown[] = [];
  f.service.subscribe(f.session.sessionId, (event) => events.push(event));
  f.secrets.registerSessionSecret('other', 'OtherTenantCookie-987654');
  try {
    f.raw.emitEvent('console.log', { message: COOKIE, [COOKIE]: 'OtherTenantCookie-987654' });
    await vi.waitFor(() =>
      expect(events.some((event) => (event as { type: string }).type === 'console.log')).toBe(true)
    );
    const retained = f.service.getSessionEvents(f.session.sessionId);
    expect(JSON.stringify({ events, retained })).not.toContain(COOKIE);
    expect(JSON.stringify({ events, retained })).toContain('OtherTenantCookie-987654');
  } finally {
    await f.service.shutdown();
  }
});

it('redacts ordinary observation fields/dictionaries and generated filter echoes while keeping usable refs/history', async () => {
  const f = await fixture();
  try {
    f.raw.setElements([
      { role: 'textbox', name: COOKIE, value: COOKIE, attributes: { [COOKIE]: COOKIE } },
    ]);
    const before = await f.service.observe(f.session.sessionId, f.page.pageId, {});
    expect(before.elements[0]).toMatchObject({ name: '***', attributes: { '***': '***' } });
    expect(before.elements[0]?.ref).toMatch(/^e\d+_\d+$/);
    await f.service.act(f.session.sessionId, f.page.pageId, {
      action: 'fill',
      target: { ref: before.elements[0]!.ref },
      value: `${COOKIE}-changed`,
    });
    const diff = await f.service.observe(f.session.sessionId, f.page.pageId, {
      sinceRevision: before.revision,
    });
    expect(diff.changes?.length).toBeGreaterThan(0);
    const projected = await f.service.observe(f.session.sessionId, f.page.pageId, { name: COOKIE });
    expect(projected.projection?.name).toBe('***');
    expect(JSON.stringify({ before, diff, projected })).not.toContain(COOKIE);
    const ref = diff.elements[0]?.ref;
    expect(ref).toBeDefined();
    await expect(
      f.service.act(f.session.sessionId, f.page.pageId, { action: 'hover', target: { ref: ref! } })
    ).resolves.toMatchObject({ status: 'success' });
  } finally {
    await f.service.shutdown();
  }
});

it('handles attacker-shaped attribute collision families in linear work before the public budget', async () => {
  const f = await fixture();
  const a = 'alphaSeed-123';
  const b = 'bravoSeed-456';
  f.secrets.registerSessionSecrets(f.session.sessionId, [a, b]);
  const bits = 10;
  const attributes = Object.fromEntries(
    Array.from({ length: 2 ** bits }, (_, value) => [
      Array.from({ length: bits }, (_, bit) => ((value >> bit) & 1 ? a : b)).join(''),
      'x',
    ])
  );
  f.raw.setElements([{ role: 'button', name: 'Action', attributes }]);
  const original = Set.prototype.has;
  let calls = 0;
  try {
    Set.prototype.has = function (value) {
      calls++;
      return original.call(this, value);
    };
    let view: Awaited<ReturnType<AgentBrowserService['observe']>>;
    try {
      view = await f.service.observe(f.session.sessionId, f.page.pageId, {});
    } finally {
      Set.prototype.has = original;
    }
    expect(calls).toBeLessThan(16 * 2 ** bits);
    expect(Object.keys(view.elements[0]?.attributes ?? {})).toHaveLength(2 ** bits);
    expect(JSON.stringify(view)).not.toContain(a);
    expect(JSON.stringify(view)).not.toContain(b);
  } finally {
    Set.prototype.has = original;
    await f.service.shutdown();
  }
});

it.each([false, true])(
  'refuses an old observation after close/ID reuse without touching the new owner (redactorFault=%s)',
  async (fault) => {
    const coordinator = new SessionCoordinator();
    vi.spyOn(coordinator as any, 'generateSessionId').mockReturnValue('s_reused_publication');
    const secrets = new SecretManager();
    const capture = secrets.captureRegisteredScopedRedactor.bind(secrets);
    let failOld = false;
    vi.spyOn(secrets, 'captureRegisteredScopedRedactor').mockImplementation((id) => {
      const redact = capture(id);
      const old = secrets.redactScoped(COOKIE, id) === '***';
      return redact
        ? (input, keys) => {
            if (old && failOld) throw new Error(COOKIE);
            return redact(input, keys);
          }
        : undefined;
    });
    const f = await fixture({ coordinator, secrets });
    let release!: (value: Awaited<ReturnType<typeof f.raw.observe>>) => void;
    const entered = vi.fn();
    const snapshot = await f.raw.observe({});
    vi.spyOn(f.raw, 'observe').mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const pending = f.service
      .observe(f.session.sessionId, f.page.pageId, {})
      .catch((error) => error);
    try {
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
      await f.service.closeSession(f.session.sessionId);
      const next = await f.service.createSession({
        tenantId: 'owner',
        cookies: [{ name: 'session', value: NEXT, domain: 'app.test', path: '/' }],
        scope: { allowedHosts: ['app.test'] },
      });
      failOld = fault;
      release(snapshot);
      const failure = await pending;
      expect(failure).toMatchObject({ code: fault ? 'INTERNAL' : 'CONTROL_REVOKED' });
      expect(JSON.stringify({ message: failure.message, details: failure.details })).not.toContain(
        COOKIE
      );
      expect(f.service.getScopeStatus(next.sessionId).stopped).toBeUndefined();
      expect(secrets.redactScoped(NEXT, next.sessionId)).toBe('***');
      await f.service.closeSession(next.sessionId);
      expect(secrets.redactScoped(NEXT, next.sessionId)).toBe(NEXT);
    } finally {
      failOld = false;
      release?.(snapshot);
      await f.service.shutdown();
    }
  }
);

it('rejects a late ordinary read after guard-only human takeover', async () => {
  const f = await fixture({ delegated: true });
  const snapshot = await f.raw.observe({});
  let release!: (value: typeof snapshot) => void;
  const entered = vi.fn();
  vi.spyOn(f.raw, 'observe').mockImplementationOnce(() => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const review = f.service.authority.get(f.session.sessionId)!.prepareResume();
  const agent = f.service.authority.authenticate(
    f.service.authority.delegate(f.session.sessionId, review.epoch, 'qa').token
  )!;
  const pending = f.service.authority
    .run(f.session.sessionId, agent, {}, () =>
      f.service.observe(f.session.sessionId, f.page.pageId, {})
    )
    .catch((error) => error);
  try {
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    f.service.authority.takeover(f.session.sessionId);
    release(snapshot);
    expect(await pending).toMatchObject({ code: 'CONTROL_REVOKED' });
  } finally {
    release?.(snapshot);
    await f.service.shutdown();
  }
});

it.each(['event', 'trace'])(
  'halts traffic and seals a fixed ledger marker when a %s redactor itself fails',
  async (channel) => {
    const directory = await mkdtemp(join(tmpdir(), 'owner-event-fault-'));
    const secrets = new SecretManager();
    const capture = secrets.captureRegisteredScopedRedactor.bind(secrets);
    let broken = false;
    vi.spyOn(secrets, 'captureRegisteredScopedRedactor').mockImplementation((id) => {
      const redact = capture(id);
      return redact
        ? (input, keys) => {
            if (broken) throw new Error(COOKIE);
            return redact(input, keys);
          }
        : undefined;
    });
    const f = await fixture({ secrets, directory });
    const events: unknown[] = [];
    f.service.subscribe(f.session.sessionId, (event) => events.push(event));
    try {
      if (channel === 'event') {
        broken = true;
        f.raw.emitEvent('console.log', { message: COOKIE });
      } else {
        f.raw.setElements([{ role: 'button', name: 'Field' }]);
        const observed = await f.service.observe(f.session.sessionId, f.page.pageId, {});
        const original = f.raw.act.bind(f.raw);
        const entered = vi.fn();
        vi.spyOn(f.raw, 'act').mockImplementation(async (action) => {
          await original(action);
          entered();
          broken = true;
          throw new EngineError('INTERNAL', COOKIE, false, { dispatch: 'uncertain' });
        });
        const failure = await f.service
          .act(f.session.sessionId, f.page.pageId, {
            action: 'hover',
            target: { ref: observed.elements[0]!.ref },
          })
          .catch((error) => error);
        expect(failure).toMatchObject({
          code: 'INTERNAL',
          details: { rule: 'floor.secret.redaction' },
        });
        expect(failure.message).not.toContain(COOKIE);
        expect(browserFailureOutcomeUnknown(failure)).toBe(true);
        expect(entered).toHaveBeenCalledOnce();
      }
      await vi.waitFor(() =>
        expect(f.service.getScopeStatus(f.session.sessionId).stopped).toBe('redaction unavailable')
      );
      await expect(
        f.engineOptions.requestPolicy!.checkRequest({
          hostname: 'app.test',
          url: 'https://app.test/after-fault',
          method: 'GET',
        })
      ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      expect(JSON.stringify(events)).not.toContain(COOKIE);
      broken = false;
      await f.service.closeSession(f.session.sessionId);
      const file = await f.service.engagementLedgerFile('owner', f.session.engagementId!);
      const ledger = await readFile(file.path, 'utf8');
      expect(verifyEngagementLedger(ledger)).toMatchObject({ ok: true, closed: true });
      expect(ledger).toContain('recording.failed');
      expect(ledger).toContain('redaction_unavailable');
      expect(ledger).not.toContain(COOKIE);
      expect(JSON.stringify(f.tracer.completedSpans())).not.toContain(COOKIE);
    } finally {
      broken = false;
      await f.service.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
