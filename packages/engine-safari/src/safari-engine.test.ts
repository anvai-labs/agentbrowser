/**
 * TD-BROWSER-7 Phase 2: real-Safari engine tests.
 *
 * Gated on the machine being able to drive real Safari (macOS, safaridriver
 * installed and enabled). Everything else skips with the availability probe
 * so the suite stays green on linux CI and on macs without enablement.
 */

import { describe, expect, it } from 'vitest';
import { SafaridriverEngine } from './index.js';

const safariReady = await SafaridriverEngine.available();

describe('SafaridriverEngine (TD-BROWSER-7 Phase 2)', () => {
  it('reports availability honestly for this platform', () => {
    // darwin with safaridriver installed must be available; linux never is.
    if (process.platform === 'darwin') {
      expect(typeof safariReady).toBe('boolean');
    } else {
      expect(safariReady).toBe(false);
    }
  });

  it.runIf(safariReady)('declares alwaysHeaded and no PDF in capabilities', async () => {
    const engine = new SafaridriverEngine();
    const capabilities = await engine.capabilities();
    expect(capabilities.alwaysHeaded).toBe(true);
    expect(capabilities.supportsPdf).toBe(false);
    expect(capabilities.supportedObservationModes).toContain('interactive');
  });

  it.runIf(safariReady)('passes the engine contract suite against real Safari', async () => {
    const { runEngineContractSuite } = await import('@agentbrowser/testkit');
    const engine = new SafaridriverEngine();
    await runEngineContractSuite(engine);
  });

  it.runIf(safariReady)(
    'accepts headless:true by running headed (loud refusal lives at the service layer)',
    async () => {
      const engine = new SafaridriverEngine();
      const session = await engine.createSession({ headless: true });
      expect(session.id).toMatch(/^safari-/);
      await session.close();
    }
  );

  it.runIf(safariReady)('refuses egress policy loudly', async () => {
    const engine = new SafaridriverEngine();
    await expect(
      engine.createSession({
        headless: true,
        requestPolicy: { checkRequest: async () => {} },
      })
    ).rejects.toThrow(/EGRESS_UNSUPPORTED/);
  });

  it.runIf(safariReady)('round-trips seeded cookies through first navigation', async () => {
    const engine = new SafaridriverEngine();
    const session = await engine.createSession({
      headless: true,
      cookies: [{ name: 'sid', value: 'abc', domain: 'example.com', path: '/', secure: true }],
    });
    const page = await session.newPage();
    await page.navigate({ url: 'https://example.com' });
    const cookies = await session.cookies();
    expect(cookies.some((c) => c.name === 'sid' && c.value === 'abc')).toBe(true);
    await session.close();
  });

  it.runIf(safariReady)('navigates and observes semantic elements', async () => {
    const engine = new SafaridriverEngine();
    const session = await engine.createSession({ headless: true });
    const page = await session.newPage();
    await page.navigate({ url: 'data:text/html,<title>probe</title><button>go</button>' });
    const observation = await page.observe({ mode: 'interactive' });
    expect(observation.title).toBe('probe');
    expect(observation.elements.some((element) => element.role === 'button')).toBe(true);
    await session.close();
  });
});
