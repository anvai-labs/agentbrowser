/**
 * WS2: observe() and screenshot() accept an optional readiness `wait` that runs
 * the shared waitFor() machinery BEFORE the snapshot/capture, so a slow-mounting
 * SPA does not observe empty or screenshot blank. Uses the minElements condition
 * (engine-agnostic: it polls observe()) to prove the wait gates the operation.
 */
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it } from 'vitest';
import { AgentBrowserService } from './service';

async function setup() {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({ engine });
  const session = await service.createSession({ tenantId: 't1' });
  const pageId = (await service.createPage(session.sessionId)).pageId;
  await service.navigate(session.sessionId, pageId, { url: 'https://example.com' });
  return { service, sessionId: session.sessionId, pageId };
}

describe('observe/screenshot readiness wait (WS2)', () => {
  it('observe runs the wait first and surfaces its timeout (never reaching a snapshot)', async () => {
    const { service, sessionId, pageId } = await setup();
    const error = await service
      .observe(sessionId, pageId, {
        mode: 'interactive',
        wait: { until: 'minElements', count: 99, timeoutMs: 150 },
      })
      .catch((e: unknown) => e as { code: string; details?: Record<string, unknown> });
    expect(error.code).toBe('ACTION_TIMEOUT');
    expect(error.details?.until).toBe('minElements');
    await service.shutdown();
  });

  it('observe without a wait returns normally (unchanged default path)', async () => {
    const { service, sessionId, pageId } = await setup();
    const observation = await service.observe(sessionId, pageId, { mode: 'interactive' });
    expect(observation).toBeDefined();
    expect(Array.isArray(observation.elements)).toBe(true);
    await service.shutdown();
  });

  it('screenshot runs the wait first and surfaces its timeout (never reaching a capture)', async () => {
    const { service, sessionId, pageId } = await setup();
    const error = await service
      .screenshot(sessionId, pageId, {
        wait: { until: 'minElements', count: 99, timeoutMs: 150 },
      })
      .catch((e: unknown) => e as { code: string });
    expect(error.code).toBe('ACTION_TIMEOUT');
    await service.shutdown();
  });

  it('screenshot without a wait captures normally', async () => {
    const { service, sessionId, pageId } = await setup();
    const artifact = await service.screenshot(sessionId, pageId, {});
    expect(artifact).toBeDefined();
    await service.shutdown();
  });
});
