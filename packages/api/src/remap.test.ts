/**
 * F2 end-to-end: remap is opt-in at the service surface too - the healed
 * action reports the ref span it covered, and the default contract
 * (stale => refusal) is unchanged.
 */
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it } from 'vitest';
import { AgentBrowserService } from './service';

async function setup() {
  const engine = new FakeEngine();
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

describe('opt-in remap end to end', () => {
  it('heals a stale ref after a revision bump when remap is opted in', async () => {
    const { service, session, pageId, ref } = await setup();
    // Navigation invalidates every pre-observed ref; the same-named control
    // is still there at the new revision. The re-observe satisfies the
    // observe-before-act contract while the action still pins the OLD ref.
    await service.navigate(session.sessionId, pageId, { url: 'https://example.com/next' });
    await service.observe(session.sessionId, pageId, { mode: 'interactive' });

    const result = await service.act(session.sessionId, pageId, {
      action: 'click',
      target: { ref },
      remap: true,
    });
    expect(result.status).toBe('success');
    expect(result.remap).toEqual({ from: ref, to: expect.any(String) });
    expect(result.remap?.to).not.toBe(ref);
  });

  it('refuses a live semantic mismatch (fingerprint drift) even when remap is opted in', async () => {
    const { service, session, pageId, ref, fakePage } = await setup();
    // Same revision, but the control's live fingerprint no longer matches
    // what was observed: the refusal carries contradicting semantic
    // evidence, so remapping it would overwrite evidence the executor
    // deliberately refused on. Structural replacement (which bumps the
    // revision) stays healable; content drift does not.
    fakePage.setElements([{ role: 'button', name: 'Element 1', value: 'replaced' }]);

    const error = await service
      .act(session.sessionId, pageId, { action: 'click', target: { ref }, remap: true })
      .catch((e: unknown) => e as { code: string; details?: Record<string, unknown> });

    expect(error.code).toBe('STALE_TARGET');
    expect(error.details?.expectedFingerprint).toBeDefined();
    expect(error.details?.remapEligible).toBeUndefined();
  });

  it('still refuses by default when remap is absent', async () => {
    const { service, session, pageId, ref } = await setup();
    await service.navigate(session.sessionId, pageId, { url: 'https://example.com/next' });
    await service.observe(session.sessionId, pageId, { mode: 'interactive' });

    const error = await service
      .act(session.sessionId, pageId, { action: 'click', target: { ref } })
      .catch((e: unknown) => e as { code: string });

    expect(error.code).toBe('STALE_TARGET');
  });

  it('refuses with a candidate count when the semantic match is ambiguous', async () => {
    const { service, session, pageId, ref, fakePage } = await setup();
    // A revision bump makes the old ref a binding-staleness refusal (the
    // healable shape); two same-named controls then make the remap
    // ambiguous, so it must refuse to guess.
    await service.navigate(session.sessionId, pageId, { url: 'https://example.com/next' });
    fakePage.setElements([
      { role: 'button', name: 'Element 1', value: 'a' },
      { role: 'button', name: 'Element 1', value: 'b' },
    ]);
    await service.observe(session.sessionId, pageId, { mode: 'interactive' });

    const error = await service
      .act(session.sessionId, pageId, { action: 'click', target: { ref }, remap: true })
      .catch((e: unknown) => e as { code: string; details?: Record<string, unknown> });

    expect(error.code).toBe('STALE_TARGET');
    expect(error.details?.candidates).toBe(2);
  });
});
