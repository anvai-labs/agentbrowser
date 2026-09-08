/**
 * F5: include:["overlays"] is the only delivered enrichment token — unknown
 * tokens are rejected with the valid set, known tokens reach the engine.
 */
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it, vi } from 'vitest';
import { AgentBrowserService } from './service';

describe('observe include tokens', () => {
  it('rejects undelivered include tokens with the valid set', async () => {
    const service = new AgentBrowserService({ engine: new FakeEngine() });
    const session = await service.createSession({ tenantId: 't1' });
    const pageId = (await service.createPage(session.sessionId)).pageId;

    const error = await service
      .observe(session.sessionId, pageId, { include: ['overlay', 'shadows'] })
      .catch((e: unknown) => e as { code: string; details?: { validIncludes?: string[] } });

    expect(error.code).toBe('INVALID_REQUEST');
    expect(error.details?.validIncludes).toEqual(['overlays']);
  });

  it('forwards known include tokens to the engine', async () => {
    const engine = new FakeEngine();
    const service = new AgentBrowserService({ engine });
    const session = await service.createSession({ tenantId: 't1' });
    const pageId = (await service.createPage(session.sessionId)).pageId;
    const engineSessionId = engine.getSessionIds()[0];
    if (engineSessionId === undefined) throw new Error('no engine session');
    const fakePage = engine.getFakePage(engineSessionId, pageId);
    if (!fakePage) throw new Error('no fake page');
    const observe = vi.spyOn(fakePage, 'observe');

    await service.observe(session.sessionId, pageId, { include: ['overlays'] });

    expect(observe.mock.calls[0]?.[0]?.include).toEqual(['overlays']);
  });
});
