import { EngineError, type EngineSessionOptions } from '@agentbrowser/engine';
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it, vi } from 'vitest';
import { AgentBrowserService } from './service.js';

describe('T10 M5 page-local scope diagnostics', () => {
  it.each(['throw', 'return'] as const)(
    'correlates denials only within the navigating page/window (%s)',
    async (mode) => {
      const engine = new FakeEngine();
      let options: EngineSessionOptions | undefined;
      const create = engine.createSession.bind(engine);
      vi.spyOn(engine, 'createSession').mockImplementation(async (input) => {
        options = input;
        return create(input);
      });
      const service = new AgentBrowserService({ engine });
      try {
        const { sessionId } = await service.createSession({
          scope: {
            allowedHosts: ['example.com'],
            requestBudget: 1,
            rateLimit: { requests: 1, perSeconds: 1 },
          },
        });
        const { pageId } = await service.createPage(sessionId);
        const sibling = await service.createPage(sessionId);
        const raw = engine.getFakePage(engine.getSessionIds()[0]!, pageId)!;
        const other = engine.getFakePage(engine.getSessionIds()[0]!, sibling.pageId)!;
        const before = service.getSession(sessionId)!;
        expect(before.scope).toMatchObject({ budget: { remaining: 1 }, rateLimit: { paced: 0 } });
        vi.spyOn(raw, 'navigate').mockImplementation(async () => {
          await options!.requestPolicy!.checkRequest({
            hostname: 'example.com',
            url: 'https://example.com/',
          });
          await expect(
            options!.requestPolicy!.checkRequest({
              hostname: 'example.com',
              url: 'https://example.com/chunk.js',
            })
          ).rejects.toMatchObject({ details: { scope: 'SCOPE_BUDGET_EXHAUSTED' } });
          const delivered = new Promise<void>((resolve) => {
            const off = service.subscribe(sessionId, (event) => {
              if (event.pageId === pageId && event.type === 'request.failed') {
                off?.();
                resolve();
              }
            });
          });
          other.emitEvent('request.failed', { scope: 'SCOPE_RATE_LIMITED' });
          raw.emitEvent('request.failed', { scope: 'SCOPE_BUDGET_EXHAUSTED' });
          await delivered;
          if (mode === 'throw') throw new EngineError('NAVIGATION_TIMEOUT', 'Timed out');
          return { status: 'timeout', url: 'https://example.com/', redirectChain: [] };
        });
        if (mode === 'throw')
          await expect(
            service.navigate(sessionId, pageId, { url: 'https://example.com/' })
          ).rejects.toMatchObject({
            code: 'NAVIGATION_TIMEOUT',
            details: { reason: 'engine_error', scopeDenials: { SCOPE_BUDGET_EXHAUSTED: 1 } },
          });
        else
          expect(
            await service.navigate(sessionId, pageId, { url: 'https://example.com/' })
          ).toMatchObject({ status: 'timeout', scopeDenials: { SCOPE_BUDGET_EXHAUSTED: 1 } });
        expect(service.getSession(sessionId)?.scope?.budget?.remaining).toBe(0);
        const plain = await service.createSession({});
        expect(service.getSession(plain.sessionId)).not.toHaveProperty('scope');
      } finally {
        await service.shutdown();
      }
    }
  );
});
