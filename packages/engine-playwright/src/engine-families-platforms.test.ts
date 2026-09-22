import { describe, expect, it, vi } from 'vitest';
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
 * Filesystem state for the branded-Chrome probe tests. The mocked
 * node:fs/promises.access passes through by default (the webkit launch in
 * this file needs the real filesystem) and only hides every path while a
 * probe test runs — so the candidate assertions hold on any host, including
 * CI runners that ship /usr/bin/google-chrome.
 */
const probeState = vi.hoisted(() => ({ hideAllPaths: false, probed: [] as string[] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: async (path: Parameters<typeof actual.access>[0], ...rest: unknown[]) => {
      if (probeState.hideAllPaths) {
        probeState.probed.push(String(path));
        throw Object.assign(new Error(`ENOENT: ${String(path)}`), { code: 'ENOENT' });
      }
      // The real signature takes (path, mode?); cast keeps the passthrough honest.
      return (actual.access as (...a: unknown[]) => Promise<void>)(path, ...rest);
    },
  };
});

/**
 * ADR-016: with no explicit path and no preferBundled, headed launches probe
 * the platform's well-known branded-Chrome locations. The candidate list is
 * platform-derived, so each platform branch is exercised by reporting that
 * platform while probing. Every file is hidden during the probe, so each
 * branch must fall back cleanly to the bundled binary.
 */
describe('default branded-Chrome candidates per platform (ADR-016)', () => {
  type HeadedOptions = () => Promise<{ executablePath?: string }>;

  const headedOptionsOn = async (
    platform: NodeJS.Platform
  ): Promise<{ executablePath?: string }> => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform });
    // The engine constructor consults these escape hatches before probing;
    // ambient values from the developer's shell must not skew the assertions.
    const chromePath = process.env.AGENTBROWSER_CHROME_PATH;
    const preferBundled = process.env.AGENTBROWSER_PREFER_BUNDLED;
    Reflect.deleteProperty(process.env, 'AGENTBROWSER_CHROME_PATH');
    Reflect.deleteProperty(process.env, 'AGENTBROWSER_PREFER_BUNDLED');
    probeState.hideAllPaths = true;
    probeState.probed = [];
    try {
      const engine = new PlaywrightChromiumEngine();
      return await (
        engine as unknown as { headedChromiumOptions(): Promise<{ executablePath?: string }> }
      ).headedChromiumOptions();
    } finally {
      probeState.hideAllPaths = false;
      if (chromePath !== undefined) process.env.AGENTBROWSER_CHROME_PATH = chromePath;
      else Reflect.deleteProperty(process.env, 'AGENTBROWSER_CHROME_PATH');
      if (preferBundled !== undefined) process.env.AGENTBROWSER_PREFER_BUNDLED = preferBundled;
      else Reflect.deleteProperty(process.env, 'AGENTBROWSER_PREFER_BUNDLED');
      if (original) {
        Object.defineProperty(process, 'platform', original);
      }
    }
  };

  it('probes the macOS Chrome install location on darwin and falls back to bundled', async () => {
    const options = await headedOptionsOn('darwin');
    expect(options.executablePath).toBeUndefined();
    expect(probeState.probed).toEqual([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]);
  });

  it('probes the Windows Chrome install locations on win32 and falls back to bundled', async () => {
    const options = await headedOptionsOn('win32');
    expect(options.executablePath).toBeUndefined();
    expect(probeState.probed).toContain(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    );
    expect(probeState.probed).toContain(
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    );
  });

  it('probes the Linux Chrome install locations on linux and falls back to bundled', async () => {
    const options = await headedOptionsOn('linux');
    expect(options.executablePath).toBeUndefined();
    expect(probeState.probed).toEqual([
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/opt/google/chrome/chrome',
    ]);
  });
});
