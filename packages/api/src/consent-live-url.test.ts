import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it } from 'vitest';
import { AgentBrowserService, ServiceError } from './service.js';

it('uses live URLs for untargeted consent before observation and after history/external navigation', async () => {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({
    engine,
    approvalPolicy: {
      rules: [
        { hostname: 'example.com', action: 'press', effect: 'transaction', decision: 'deny' },
      ],
    },
  });
  try {
    const { sessionId } = await service.createSession({ tenantId: 'local' });
    const { pageId } = await service.createPage(sessionId);
    const engineId = engine.getSessionIds()[0];
    const page = engineId ? engine.getFakePage(engineId, pageId) : undefined;
    if (!page) throw new Error('Missing fake page');
    const press = () => service.act(sessionId, pageId, { action: 'press', key: 'Enter' });
    await service.navigate(sessionId, pageId, { url: 'https://example.com/' });
    await expect(press()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await service.navigate(sessionId, pageId, { url: 'https://allowed.example/' });
    await service.observe(sessionId, pageId, {});
    await service.act(sessionId, pageId, { action: 'goBack' });
    await expect(press()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await page.navigate({ url: 'https://allowed.example/' });
    await service.observe(sessionId, pageId, {});
    await page.navigate({ url: 'https://example.com/external' });
    await expect(press()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  } finally {
    await service.shutdown();
  }
});

it('does not reuse consent after an unobserved URL change', async () => {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({ engine, approvalPolicy: { unknownRisk: 'required' } });
  try {
    const { sessionId } = await service.createSession({ tenantId: 'local' });
    const { pageId } = await service.createPage(sessionId);
    const engineId = engine.getSessionIds()[0];
    const page = engineId ? engine.getFakePage(engineId, pageId) : undefined;
    if (!page) throw new Error('Missing fake page');
    await page.navigate({ url: 'https://example.com/first' });
    let token: string | undefined;
    try {
      await service.act(sessionId, pageId, { action: 'press', key: 'Enter' });
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      expect(error.code).toBe('APPROVAL_REQUIRED');
      token = error.details?.tokenId as string;
    }
    expect(token).toBeTypeOf('string');
    await page.navigate({ url: 'https://example.com/second' });
    await expect(
      service.act(sessionId, pageId, { action: 'press', key: 'Enter', approvalToken: token })
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
  } finally {
    await service.shutdown();
  }
});
