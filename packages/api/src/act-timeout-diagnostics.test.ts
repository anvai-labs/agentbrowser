/**
 * F4: a timed-out act should hand the client the evidence it needs in one
 * round trip — the service captures a screenshot artifact and merges its id
 * into the ACTION_TIMEOUT details.
 */
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentBrowserService } from './service';

afterEach(() => vi.restoreAllMocks());

async function setup(engine: FakeEngine) {
  const service = new AgentBrowserService({ engine });
  const session = await service.createSession({ tenantId: 't1' });
  const pageId = (await service.createPage(session.sessionId)).pageId;
  await service.navigate(session.sessionId, pageId, { url: 'https://example.com/' });
  const observation = await service.observe(session.sessionId, pageId, { mode: 'interactive' });
  const ref = observation.elements[0]?.ref;
  if (!ref) throw new Error('no elements observed');
  const engineSessionId = engine.getSessionIds()[0];
  if (engineSessionId === undefined) throw new Error('no engine session');
  const fakePage = engine.getFakePage(engineSessionId, pageId);
  if (!fakePage) throw new Error('no fake page');
  return { service, session, pageId, ref, fakePage };
}

describe('act ACTION_TIMEOUT diagnostics', () => {
  it('attaches a screenshot artifact when an action times out', async () => {
    const { service, session, pageId, ref, fakePage } = await setup(new FakeEngine());
    vi.spyOn(fakePage, 'act').mockRejectedValue(new Error('click timed out'));

    const error = await service
      .act(session.sessionId, pageId, { action: 'click', target: { ref } })
      .catch((e: unknown) => e as { code: string; details?: { screenshotArtifactId?: string } });

    expect(error.code).toBe('ACTION_TIMEOUT');
    expect(error.details?.screenshotArtifactId).toEqual(expect.any(String));

    const artifactId = error.details?.screenshotArtifactId;
    if (artifactId === undefined) {
      throw new Error('expected screenshotArtifactId in details');
    }
    const artifact = await service.getArtifact(session.sessionId, artifactId);
    expect(artifact.metadata.type).toBe('screenshot');
  });

  it('leaves the error untouched when the diagnostic screenshot fails', async () => {
    const { service, session, pageId, ref, fakePage } = await setup(new FakeEngine());
    vi.spyOn(fakePage, 'act').mockRejectedValue(new Error('click timed out'));
    vi.spyOn(fakePage, 'screenshot').mockRejectedValue(new Error('capture unavailable'));

    const error = await service
      .act(session.sessionId, pageId, { action: 'click', target: { ref } })
      .catch((e: unknown) => e as { code: string; details?: { screenshotArtifactId?: string } });

    expect(error.code).toBe('ACTION_TIMEOUT');
    expect(error.details?.screenshotArtifactId).toBeUndefined();
  });
});
