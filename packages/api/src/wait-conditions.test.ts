/**
 * F6/F7: the delivered wait vocabulary grows three scenario-driven
 * conditions — urlPattern (SPA route settles), selectorVisible (render
 * blindness), minElements (page grew after a click). Conditions execute in
 * the service waitFor(), so both the post-action `wait` and the wait
 * ACTION's `condition` share one implementation.
 */
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it } from 'vitest';
import { AgentBrowserService } from './service';

interface WaitShape {
  until: string;
  timeoutMs?: number;
  pattern?: string;
  selector?: string;
  count?: number;
}

async function setup(engine: FakeEngine) {
  const service = new AgentBrowserService({ engine });
  const session = await service.createSession({ tenantId: 't1' });
  const pageId = (await service.createPage(session.sessionId)).pageId;
  await service.navigate(session.sessionId, pageId, { url: 'https://example.com/start' });
  const observation = await service.observe(session.sessionId, pageId, { mode: 'interactive' });
  const ref = observation.elements[0]?.ref;
  if (!ref) throw new Error('no elements observed');
  const engineSessionId = engine.getSessionIds()[0];
  if (engineSessionId === undefined) throw new Error('no engine session');
  const fakePage = engine.getFakePage(engineSessionId, pageId);
  if (!fakePage) throw new Error('no fake page');
  return { service, session, pageId, ref, fakePage };
}

describe('wait condition vocabulary (F6/F7)', () => {
  it('minElements succeeds once a click reveals the elements', async () => {
    const { service, session, pageId, ref, fakePage } = await setup(new FakeEngine());
    fakePage.revealAfterClick(
      'Button 1',
      [
        { role: 'button', name: 'Late A' },
        { role: 'button', name: 'Late B' },
        { role: 'button', name: 'Late C' },
      ],
      150
    );

    const result = await service.act(session.sessionId, pageId, {
      action: 'click',
      target: { ref },
      wait: { until: 'minElements', count: 3, timeoutMs: 2000 } satisfies WaitShape,
      observe: 'after',
    });

    expect(result.status).toBe('success');
    expect(result.waitReason).toBe('minElements');
    expect(result.observation?.elements.length).toBeGreaterThanOrEqual(3);
  });

  it('minElements times out with the shortfall in details', async () => {
    const { service, session, pageId, ref } = await setup(new FakeEngine());

    const error = await service
      .act(session.sessionId, pageId, {
        action: 'click',
        target: { ref },
        wait: { until: 'minElements', count: 9, timeoutMs: 300 } satisfies WaitShape,
      })
      .catch((e: unknown) => e as { code: string; details?: Record<string, unknown> });

    expect(error.code).toBe('ACTION_TIMEOUT');
    expect(error.details?.until).toBe('minElements');
    expect(error.details?.count).toBe(9);
  });

  it('urlPattern matches the settled SPA route', async () => {
    const { service, session, pageId } = await setup(new FakeEngine());

    const result = await service.act(session.sessionId, pageId, {
      action: 'wait',
      condition: { until: 'urlPattern', pattern: '**/start', timeoutMs: 1000 } satisfies WaitShape,
    });

    expect(result.status).toBe('success');
    expect(result.waitReason).toBe('urlPattern');
  });

  it('urlPattern supports /regex/ patterns and reports the last url on timeout', async () => {
    const { service, session, pageId } = await setup(new FakeEngine());

    const ok = await service.act(session.sessionId, pageId, {
      action: 'wait',
      condition: {
        until: 'urlPattern',
        pattern: '/example\\.com/',
        timeoutMs: 1000,
      } satisfies WaitShape,
    });
    expect(ok.status).toBe('success');

    const error = await service
      .act(session.sessionId, pageId, {
        action: 'wait',
        condition: { until: 'urlPattern', pattern: '**/never', timeoutMs: 300 } satisfies WaitShape,
      })
      .catch((e: unknown) => e as { code: string; details?: Record<string, unknown> });

    expect(error.code).toBe('ACTION_TIMEOUT');
    expect(error.details?.until).toBe('urlPattern');
    expect(error.details?.url).toBe('https://example.com/start');
  });

  it('selectorVisible uses the engine primitive when the engine has it', async () => {
    const { service, session, pageId, ref, fakePage } = await setup(new FakeEngine());
    fakePage.revealSelector('#late-panel', 150);

    const result = await service.act(session.sessionId, pageId, {
      action: 'click',
      target: { ref },
      wait: {
        until: 'selectorVisible',
        selector: '#late-panel',
        timeoutMs: 2000,
      } satisfies WaitShape,
    });

    expect(result.status).toBe('success');
    expect(result.waitReason).toBe('selectorVisible');
  });

  it('selectorVisible times out against a missing selector', async () => {
    const { service, session, pageId, ref, fakePage } = await setup(new FakeEngine());
    fakePage.revealSelector('#late-panel', 0);

    const error = await service
      .act(session.sessionId, pageId, {
        action: 'click',
        target: { ref },
        wait: { until: 'selectorVisible', selector: '#absent', timeoutMs: 250 } satisfies WaitShape,
      })
      .catch((e: unknown) => e as { code: string; details?: Record<string, unknown> });

    expect(error.code).toBe('ACTION_TIMEOUT');
    expect(error.details?.until).toBe('selectorVisible');
    expect(error.details?.selector).toBe('#absent');
  });

  it('selectorVisible is ENGINE_UNSUPPORTED when the engine lacks the primitive', async () => {
    const { service, session, pageId, ref, fakePage } = await setup(new FakeEngine());
    Reflect.defineProperty(fakePage, 'waitForSelector', { value: undefined });

    const error = await service
      .act(session.sessionId, pageId, {
        action: 'click',
        target: { ref },
        wait: { until: 'selectorVisible', selector: '#x', timeoutMs: 250 } satisfies WaitShape,
      })
      .catch((e: unknown) => e as { code: string });

    expect(error.code).toBe('ENGINE_UNSUPPORTED');
  });

  it('rejects malformed condition fields before anything runs', async () => {
    const { service, session, pageId, ref } = await setup(new FakeEngine());

    const noCount = await service
      .act(session.sessionId, pageId, {
        action: 'click',
        target: { ref },
        wait: { until: 'minElements', timeoutMs: 100 } satisfies WaitShape,
      })
      .catch((e: unknown) => e as { code: string });
    expect(noCount.code).toBe('INVALID_REQUEST');

    const zeroCount = await service
      .act(session.sessionId, pageId, {
        action: 'click',
        target: { ref },
        wait: { until: 'minElements', count: 0, timeoutMs: 100 } satisfies WaitShape,
      })
      .catch((e: unknown) => e as { code: string });
    expect(zeroCount.code).toBe('INVALID_REQUEST');

    const noSelector = await service
      .act(session.sessionId, pageId, {
        action: 'click',
        target: { ref },
        wait: { until: 'selectorVisible', timeoutMs: 100 } satisfies WaitShape,
      })
      .catch((e: unknown) => e as { code: string });
    expect(noSelector.code).toBe('INVALID_REQUEST');

    const noPattern = await service
      .act(session.sessionId, pageId, {
        action: 'click',
        target: { ref },
        wait: { until: 'urlPattern', timeoutMs: 100 } satisfies WaitShape,
      })
      .catch((e: unknown) => e as { code: string });
    expect(noPattern.code).toBe('INVALID_REQUEST');
  });

  it('rejects a syntactically invalid /regex/ pattern before anything runs', async () => {
    const { service, session, pageId, ref } = await setup(new FakeEngine());

    const error = await service
      .act(session.sessionId, pageId, {
        action: 'click',
        target: { ref },
        wait: { until: 'urlPattern', pattern: '/([/', timeoutMs: 100 } satisfies WaitShape,
      })
      .catch((e: unknown) => e as { code: string });
    expect(error.code).toBe('INVALID_REQUEST');
  });

  it('rejects an over-long urlPattern before anything runs', async () => {
    const { service, session, pageId, ref } = await setup(new FakeEngine());

    const error = await service
      .act(session.sessionId, pageId, {
        action: 'click',
        target: { ref },
        wait: {
          until: 'urlPattern',
          pattern: `/${'a'.repeat(513)}/`,
          timeoutMs: 100,
        } satisfies WaitShape,
      })
      .catch((e: unknown) => e as { code: string });
    expect(error.code).toBe('INVALID_REQUEST');
  });

  it('clamps a wire-supplied timeoutMs of 0 for urlPattern so the wait stays deadline-bounded', async () => {
    // Playwright reads an explicit 0 as "wait forever"; the service must
    // floor every condition deadline. A never-matching pattern with a
    // zero timeout has to fail fast with ACTION_TIMEOUT, not hang.
    const { service, session, pageId, ref } = await setup(new FakeEngine());

    const error = await service
      .act(session.sessionId, pageId, {
        action: 'click',
        target: { ref },
        wait: {
          until: 'urlPattern',
          pattern: '/never-in-a-timely-manner/',
          timeoutMs: 0,
        } satisfies WaitShape,
      })
      .catch((e: unknown) => e as { code: string });
    expect(error.code).toBe('ACTION_TIMEOUT');
  });

  it('clamps a wire-supplied timeoutMs of 0 for selectorVisible so the wait stays deadline-bounded', async () => {
    const { service, session, pageId, ref } = await setup(new FakeEngine());

    const error = await service
      .act(session.sessionId, pageId, {
        action: 'click',
        target: { ref },
        wait: { until: 'selectorVisible', selector: '#absent', timeoutMs: 0 } satisfies WaitShape,
      })
      .catch((e: unknown) => e as { code: string });
    expect(error.code).toBe('ACTION_TIMEOUT');
  });
});
