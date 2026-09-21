import { describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

/**
 * Family launch paths run wherever the browser binaries exist (CI installs
 * all three; a host without webkit skips honestly instead of failing).
 */
describe('browser family launch', () => {
  it('runs a webkit session with webkit capabilities when the binaries are installed', async () => {
    const { webkit } = await import('playwright');
    const available = await webkit
      .launch({ headless: true })
      .then((b) => b.close().then(() => true))
      .catch(() => false);
    if (!available) {
      console.warn('webkit binaries not installed; skipping');
      return;
    }
    const engine = new PlaywrightChromiumEngine({ browser: 'webkit' });
    try {
      expect(engine.name).toBe('playwright-webkit');
      const capabilities = await engine.capabilities();
      expect(capabilities.supportsPdf).toBe(false);
      expect(capabilities.supportsCdp).toBe(false);

      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: 'data:text/html,<button>WebKit</button>' });
      const state = await page.observe({});
      expect(state.elements.some((el) => el.role === 'button' && el.name === 'WebKit')).toBe(true);
      await session.close();
    } finally {
      await engine.close();
    }
  }, 60_000);
});

/**
 * ADR-016: with no explicit path and no preferBundled, headed launches probe
 * the platform's well-known branded-Chrome locations. The candidate list is
 * platform-derived, so each platform branch is exercised by reporting that
 * platform while probing. This host has no Chrome at any probed location, so
 * every branch must still fall back cleanly to the bundled binary.
 */
describe('default branded-Chrome candidates per platform (ADR-016)', () => {
  type HeadedOptions = () => Promise<{ executablePath?: string }>;

  const headedOptionsOn = async (
    platform: NodeJS.Platform
  ): Promise<{ executablePath?: string }> => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      const engine = new PlaywrightChromiumEngine();
      return await (
        engine as unknown as { headedChromiumOptions(): Promise<{ executablePath?: string }> }
      ).headedChromiumOptions();
    } finally {
      if (original) {
        Object.defineProperty(process, 'platform', original);
      }
    }
  };

  it('probes the Windows Chrome install locations on win32', async () => {
    const options = await headedOptionsOn('win32');
    expect(options.executablePath).toBeUndefined();
  });

  it('probes the Linux Chrome install locations on linux', async () => {
    const options = await headedOptionsOn('linux');
    expect(options.executablePath).toBeUndefined();
  });
});
