import { SCOPE_DENIAL_CODES } from '@agentbrowser/protocol';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { AgentBrowserService } from './service.js';

it.each(SCOPE_DENIAL_CODES)(
  'page creation preserves %s without navigation payloads',
  async (scope) => {
    const engine = new FakeEngine();
    const service = new AgentBrowserService({ engine });
    try {
      const { sessionId } = await service.createSession({ tenantId: 'local' });
      let close: ReturnType<typeof vi.spyOn> | undefined;
      vi.spyOn(service, 'navigate').mockImplementation(async (_, pageId) => {
        const page = engine.getFakePage(engine.getSessionIds()[0]!, pageId)!;
        close = vi.spyOn(page, 'close');
        return {
          status: 'blocked',
          reason: 'egress_policy',
          scope,
          url: 'https://example.com/private-path?token=fixture-only-secret',
          redirectChain: ['https://example.com/private-path?token=fixture-only-secret'],
        };
      });
      const error = await service
        .createPage(sessionId, { url: 'https://example.com/start' })
        .catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        code: 'POLICY_DENIED',
        retryable: false,
        details: { reason: 'egress_policy', scope },
      });
      expect(JSON.stringify(error)).not.toContain('fixture-only-secret');
      expect(close).toHaveBeenCalledOnce();
      expect(await service.listPages(sessionId)).toEqual([]);
    } finally {
      await service.shutdown();
    }
  }
);

it.each([
  { status: 'blocked' as const, reason: 'egress_policy' as const },
  { status: 'blocked' as const, reason: 'egress_policy' as const, scope: 'UNKNOWN_SCOPE' },
  { status: 'timeout' as const, reason: 'dns_timeout' as const, scope: 'SCOPE_HOST_DENIED' },
])('rejects failed page creation even without a validated scope denial: %j', async (outcome) => {
  const service = new AgentBrowserService({ engine: new FakeEngine() });
  try {
    const { sessionId } = await service.createSession({ tenantId: 'local' });
    vi.spyOn(service, 'navigate').mockResolvedValue({
      ...outcome,
      url: 'https://example.com/start',
      redirectChain: [],
    });
    await expect(
      service.createPage(sessionId, { url: 'https://example.com/start' })
    ).rejects.toMatchObject({
      code: outcome.status === 'timeout' ? 'NAVIGATION_TIMEOUT' : 'POLICY_DENIED',
      retryable: false,
      details: { reason: outcome.reason },
    });
    expect(await service.listPages(sessionId)).toEqual([]);
  } finally {
    await service.shutdown();
  }
});

it('a page close failure does not replace the scoped navigation denial or retain the page', async () => {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({ engine });
  try {
    const { sessionId } = await service.createSession({ tenantId: 'local' });
    vi.spyOn(service, 'navigate').mockImplementation(async (_, pageId) => {
      const page = engine.getFakePage(engine.getSessionIds()[0]!, pageId)!;
      vi.spyOn(page, 'close').mockRejectedValueOnce(new Error('fixture close failure'));
      return {
        status: 'blocked',
        reason: 'egress_policy',
        scope: 'SCOPE_HOST_DENIED',
        url: 'https://example.com/start',
        redirectChain: [],
      };
    });
    await expect(
      service.createPage(sessionId, { url: 'https://example.com/start' })
    ).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { reason: 'egress_policy', scope: 'SCOPE_HOST_DENIED' },
    });
    expect(await service.listPages(sessionId)).toEqual([]);
  } finally {
    await service.shutdown();
  }
});

it.each([
  {
    status: 'blocked' as const,
    reason: 'egress_policy' as const,
    scope: 'SCOPE_HOST_DENIED',
    code: 'POLICY_DENIED',
  },
  { status: 'blocked' as const, reason: 'browser_error_document' as const, code: 'INTERNAL' },
  { status: 'timeout' as const, reason: 'dns_timeout' as const, code: 'NAVIGATION_TIMEOUT' },
])(
  'retains the created page for the human when takeover overlaps $status/$reason',
  async (outcome) => {
    const engine = new FakeEngine();
    const service = new AgentBrowserService({ engine });
    try {
      const { sessionId } = await service.createSession({
        tenantId: 'local',
        controlMode: 'delegated',
      });
      const review = service.authority.get(sessionId)!.prepareResume();
      const grant = service.authority.delegate(sessionId, review.epoch);
      const principal = service.authority.authenticate(grant.token)!;
      let retainedPageId: string | undefined;
      let close: ReturnType<typeof vi.spyOn> | undefined;
      vi.spyOn(service, 'navigate').mockImplementation(async (_, pageId) => {
        retainedPageId = pageId;
        const page = engine.getFakePage(engine.getSessionIds()[0]!, pageId)!;
        close = vi.spyOn(page, 'close');
        expect(service.authority.takeover(sessionId)).toMatchObject({
          state: 'PAUSE_REQUESTED',
          busy: true,
        });
        return {
          ...outcome,
          url: 'https://example.com/start',
          redirectChain: [],
        };
      });
      await expect(
        service.authority.run(sessionId, principal, { id: 'create', fingerprint: 'fixture' }, () =>
          service.createPage(sessionId, { url: 'https://example.com/start' })
        )
      ).rejects.toMatchObject({
        code: outcome.code,
        details: {
          reason: outcome.reason,
          ...('scope' in outcome ? { scope: outcome.scope } : {}),
        },
      });
      expect(retainedPageId).toBeDefined();
      expect(close).not.toHaveBeenCalled();
      expect(service.authority.status(sessionId)).toMatchObject({
        state: 'HUMAN_ACTIVE',
        busy: false,
      });
      const pages = await service.authority.run(
        sessionId,
        { actor: 'operator', tenant: 'local' },
        {},
        () => service.listPages(sessionId)
      );
      expect(pages).toEqual([expect.objectContaining({ pageId: retainedPageId })]);
      expect(service.getSession(sessionId)?.pages).toBe(1);
    } finally {
      await service.shutdown();
    }
  }
);
