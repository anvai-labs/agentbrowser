import { describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

/**
 * TD-BROWSER-16 phase 6 (ADR-025 §3): the engine pieces of the handoff.
 * The init script must reach EVERY frame — the main document, a synchronous
 * about:blank iframe, and a window.open popup — and the shared Chromium
 * launches with the WebRTC IP-handling policy while the login browser is
 * enabled. Real browser, like the login-browser suite.
 */

const RTC_REMOVAL =
  '(() => { const remove = (name) => { try { delete window[name]; } catch {} ' +
  'Object.defineProperty(window, name, { get: () => undefined, configurable: true }); }; ' +
  "remove('RTCPeerConnection'); remove('webkitRTCPeerConnection'); })();";

const PROBE =
  'data:text/html,<!doctype html><html><body>' +
  `<button id="main">pending</button><button id="frame">pending</button><button id="popup">pending</button>` +
  `<iframe id="f"></iframe>` +
  '<script>' +
  'const set = (id, v) => { document.getElementById(id).textContent = v; };' +
  `set('main', String(typeof RTCPeerConnection));` +
  `set('frame', String(typeof document.getElementById('f').contentWindow.RTCPeerConnection));` +
  `const w = window.open('about:blank');` +
  `if (w) { set('popup', String(typeof w.RTCPeerConnection)); w.close(); }` +
  `else set('popup', 'no-popup');` +
  '</script></body></html>';

const buttonText = async (
  elements: Array<{ role?: string; name?: string }>,
  id: string
): Promise<string> => {
  // The probe buttons carry their result as the accessible name.
  const values = elements.filter((e) => e.role === 'button')?.map((e) => e.name ?? '');
  void id;
  return values.join('|');
};

describe('TD-BROWSER-16 phase 6: handoff engine pieces', () => {
  it('the all-frames init script removes RTCPeerConnection in main, iframe and popup', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({});
      await session.addInitScript?.(RTC_REMOVAL);
      const page = await session.newPage();
      await page.navigate({ url: PROBE });
      const observed = await page.observe({ mode: 'interactive' });
      const results = await buttonText(observed.elements ?? [], '');
      expect(results).toBe('undefined|undefined|undefined');
      await session.close('done');
    } finally {
      await engine.close();
    }
  }, 60_000);

  it('without the init script the probe sees RTCPeerConnection (the test discriminates)', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({});
      const page = await session.newPage();
      await page.navigate({ url: PROBE });
      const observed = await page.observe({ mode: 'interactive' });
      const results = await buttonText(observed.elements ?? [], '');
      expect(results).toBe('function|function|function');
      await session.close('done');
    } finally {
      await engine.close();
    }
  }, 60_000);

  it('the shared Chromium carries the WebRTC flag only when forced', async () => {
    // The login-suite predicate: the engine's own chromium is the process
    // carrying the pipe flag. Some local setups (snapd under WSL2) hide
    // argv; the login suite's precedent is a warned skip there — CI runners
    // expose the full cmdline and the assertion runs for real.
    let warned = false;
    const readArgv = async (): Promise<string[] | undefined> => {
      const { readFile, readdir } = await import('node:fs/promises');
      for (const entry of await readdir('/proc').catch(() => [] as string[])) {
        if (!/^\d+$/.test(entry)) continue;
        const cmdline = await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '');
        const argv = cmdline.split('\0');
        if (argv.includes('--remote-debugging-pipe')) return argv;
      }
      if (!warned) {
        warned = true;
        console.warn('handoff-init test: chromium argv not found; flag assert skipped');
      }
      return undefined;
    };

    const plain = new PlaywrightChromiumEngine();
    try {
      const session = await plain.createSession({});
      const page = await session.newPage();
      await page.navigate({ url: 'about:blank' });
      const plainArgv = await readArgv();
      if (plainArgv !== undefined)
        expect(plainArgv.some((token) => token.startsWith('--force-webrtc'))).toBe(false);
      await session.close('done');
    } finally {
      await plain.close();
    }

    const forced = new PlaywrightChromiumEngine({ forceWebrtcIpHandlingPolicy: true });
    try {
      const session = await forced.createSession({});
      const page = await session.newPage();
      await page.navigate({ url: 'about:blank' });
      const forcedArgv = await readArgv();
      if (forcedArgv !== undefined)
        expect(forcedArgv).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
      await session.close('done');
    } finally {
      await forced.close();
    }
  }, 120_000);
});
