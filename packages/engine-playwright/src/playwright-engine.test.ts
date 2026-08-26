/**
 * TDD Tests for Playwright Chromium Engine
 *
 * These tests define the expected behavior of the PlaywrightChromiumEngine.
 * Following TDD principles, tests are written before implementation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index';

describe('PlaywrightChromiumEngine', () => {
  let engine: PlaywrightChromiumEngine;

  beforeEach(async () => {
    engine = new PlaywrightChromiumEngine();
  });

  afterEach(async () => {
    await engine.close();
  });

  describe('engine properties', () => {
    it('should have engine name as playwright-chromium', () => {
      expect(engine.name).toBe('playwright-chromium');
    });

    it('should have version property', () => {
      expect(engine.version).toBeDefined();
      expect(typeof engine.version).toBe('string');
    });

    it('should have name and version as readonly at runtime', () => {
      expect(() => {
        (engine as any).name = 'modified';
      }).toThrow();
      expect(engine.name).toBe('playwright-chromium');

      expect(() => {
        (engine as any).version = '2.0.0';
      }).toThrow();
    });
  });

  describe('capabilities', () => {
    it('should return engine capabilities', async () => {
      const capabilities = await engine.capabilities();

      expect(capabilities).toBeDefined();
      expect(typeof capabilities.supportsScreenshots).toBe('boolean');
      expect(typeof capabilities.supportsPdf).toBe('boolean');
      expect(typeof capabilities.supportsDownloads).toBe('boolean');
      expect(typeof capabilities.supportsJavascript).toBe('boolean');
    });

    it('should support screenshots', async () => {
      const capabilities = await engine.capabilities();
      expect(capabilities.supportsScreenshots).toBe(true);
    });

    it('should support PDF', async () => {
      const capabilities = await engine.capabilities();
      expect(capabilities.supportsPdf).toBe(true);
    });

    it('should support accessibility tree', async () => {
      const capabilities = await engine.capabilities();
      expect(capabilities.supportsAccessibilityTree).toBe(true);
    });

    it('should support required observation modes', async () => {
      const capabilities = await engine.capabilities();
      expect(capabilities.supportedObservationModes).toContain('interactive');
      expect(capabilities.supportedObservationModes).toContain('content');
    });

    it('should support required action types', async () => {
      const capabilities = await engine.capabilities();
      // Capability truth: exactly the action set the executor delivers.
      expect(capabilities.supportedActionTypes).toContain('click');
      expect(capabilities.supportedActionTypes).toContain('fill');
      expect(capabilities.supportedActionTypes).not.toContain('navigate');
    });
  });

  describe('session creation', () => {
    it('should create a new session', async () => {
      const session = await engine.createSession({
        viewport: { width: 1280, height: 720 },
      });

      expect(session).toBeDefined();
      expect(session.id).toBeDefined();
      expect(typeof session.id).toBe('string');
    });

    it('should create sessions with default options', async () => {
      const session = await engine.createSession();

      expect(session).toBeDefined();
      expect(session.id).toBeDefined();
    });

    it('should create isolated sessions', async () => {
      const session1 = await engine.createSession();
      const session2 = await engine.createSession();

      expect(session1.id).not.toBe(session2.id);
    });
  });

  describe('session lifecycle', () => {
    it('should close session successfully', async () => {
      const session = await engine.createSession();

      await expect(session.close()).resolves.not.toThrow();
    });

    it('should close session with reason', async () => {
      const session = await engine.createSession();

      await expect(session.close('user_requested')).resolves.not.toThrow();
    });

    it('should support creating pages in session', async () => {
      const session = await engine.createSession();
      const page = await session.newPage();

      expect(page).toBeDefined();
      expect(page.id).toBeDefined();
    });
  });

  describe('page operations', () => {
    it('should navigate to URL', async () => {
      const session = await engine.createSession();
      const page = await session.newPage();

      const result = await page.navigate({
        url: 'https://example.com',
        waitUntil: 'load',
      });

      expect(result.status).toBe('success');
      expect(result.url).toBe('https://example.com/'); // Browsers normalize URLs
    });

    it('should observe page state', async () => {
      const session = await engine.createSession();
      const page = await session.newPage();

      await page.navigate({ url: 'https://example.com' });
      const observation = await page.observe({ mode: 'interactive' });

      expect(observation).toBeDefined();
      expect(observation.url).toBe('https://example.com/'); // Browsers normalize URLs
      expect(observation.elements).toBeDefined();
      expect(Array.isArray(observation.elements)).toBe(true);
    });

    it('should execute click action', async () => {
      const session = await engine.createSession();
      const page = await session.newPage();

      await page.navigate({ url: 'https://example.com' });
      const observation = await page.observe({ mode: 'interactive' });

      if (observation.elements.length > 0) {
        const target = { ref: observation.elements[0].ref };
        const result = await page.act({ type: 'click', target });

        expect(result).toBeDefined();
        expect(result.actionId).toBeDefined();
      }
    });

    it('should capture screenshot', async () => {
      const session = await engine.createSession();
      const page = await session.newPage();

      await page.navigate({ url: 'https://example.com' });
      const screenshot = await page.screenshot({ fullPage: false });

      expect(screenshot).toBeDefined();
      expect(screenshot.artifactId).toBeDefined();
      expect(screenshot.contentType).toBe('image/png');
      expect(screenshot.sizeBytes).toBeGreaterThan(0);
    });

    it('should generate PDF', async () => {
      const session = await engine.createSession();
      const page = await session.newPage();

      await page.navigate({ url: 'https://example.com' });

      if (page.pdf) {
        const pdf = await page.pdf({ landscape: false });

        expect(pdf).toBeDefined();
        expect(pdf.artifactId).toBeDefined();
        expect(pdf.contentType).toBe('application/pdf');
      }
    });
  });

  describe('element references', () => {
    it('should generate stable element refs', async () => {
      const session = await engine.createSession();
      const page = await session.newPage();

      await page.navigate({ url: 'https://example.com' });
      const observation1 = await page.observe({ mode: 'interactive' });

      // Navigate again to get same page
      await page.navigate({ url: 'https://example.com' });
      const observation2 = await page.observe({ mode: 'interactive' });

      if (observation1.elements.length > 0 && observation2.elements.length > 0) {
        expect(observation1.elements[0].ref).toMatch(/^e\d+_\d+$/);
        expect(observation2.elements[0].ref).toMatch(/^e\d+_\d+$/);
      }
    });

    it('should resolve element refs', async () => {
      const session = await engine.createSession();
      const page = await session.newPage();

      await page.navigate({ url: 'https://example.com' });
      const observation = await page.observe({ mode: 'interactive' });

      if (observation.elements.length > 0) {
        const target = { ref: observation.elements[0].ref };
        const resolved = await page.resolve(target);

        expect(resolved).toBeDefined();
        expect(resolved.ref).toBe(target.ref);
        expect(resolved.role).toBeDefined();
      }
    });
  });

  describe('cleanup', () => {
    it('should cleanup all resources on close', async () => {
      const session = await engine.createSession();
      await session.newPage();

      await engine.close();

      // Engine should be closed cleanly
      // This is verified by no resource leaks
    });

    it('should handle multiple sessions', async () => {
      const session1 = await engine.createSession();
      const session2 = await engine.createSession();

      await session1.newPage();
      await session2.newPage();

      await engine.close();

      // All sessions should be cleaned up
    });
  });
});

describe('PlaywrightChromiumEngine ref store', () => {
  let engine: PlaywrightChromiumEngine;

  // Encoded: the raw fragment would truncate the data URL at the first '#'.
  const TEST_PAGE = `data:text/html,${encodeURIComponent(
    '<!DOCTYPE html><html><body><button id="submit">Submit</button>' +
      '<input aria-label="Email" type="email" /><a href="#next">Next page</a></body></html>'
  )}`;

  /** Observe the test page and hand back the engine page for interaction. */
  const observedPage = async () => {
    const session = await engine.createSession({ headless: true });
    const page = await session.newPage();
    await page.navigate({ url: TEST_PAGE });
    await page.observe({ mode: 'interactive' });
    return page;
  };

  beforeEach(() => {
    engine = new PlaywrightChromiumEngine();
  });

  afterEach(async () => {
    await engine.close();
  });

  it('should expose semantic elements with revision-stamped refs', async () => {
    const page = await observedPage();
    const state = await page.observe({ mode: 'interactive' });

    expect(state.url.startsWith('data:')).toBe(true);
    expect(state.elements.length).toBeGreaterThan(0);
    for (const element of state.elements) {
      expect(element.ref).toMatch(/^e\d+_\d+$/);
    }

    const submit = state.elements.find((el) => el.role === 'button' && el.name === 'Submit');
    expect(submit).toBeDefined();
  });

  it('should produce stable refs within a revision', async () => {
    const page = await observedPage();
    const first = await page.observe({ mode: 'interactive' });
    const second = await page.observe({ mode: 'interactive' });

    const a = first.elements.find((el) => el.name === 'Submit')?.ref;
    const b = second.elements.find((el) => el.name === 'Submit')?.ref;

    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  it('should resolve an observed ref to real element state with the canonical fingerprint', async () => {
    const page = await observedPage();
    const state = await page.observe({ mode: 'interactive' });

    const submit = state.elements.find((el) => el.role === 'button' && el.name === 'Submit');
    const resolved = await page.resolve({ ref: submit?.ref });

    expect(resolved.ref).toBe(submit?.ref);
    expect(resolved.role).toBe('button');
    expect(resolved.name).toBe('Submit');
    expect(resolved.visible).toBe(true);
    expect(resolved.enabled).toBe(true);
    expect(resolved.fingerprint).toBe('button_Submit_visible_true_enabled_true');
  });

  it('should reject an unknown ref', async () => {
    const page = await observedPage();

    await expect(page.resolve({ ref: 'e1_99' })).rejects.toThrow(/not found/i);
  });

  it('should click through a ref', async () => {
    const page = await observedPage();
    const state = await page.observe({ mode: 'interactive' });
    const link = state.elements.find((el) => el.role === 'link' && el.name === 'Next page');

    const effect = await page.act({ type: 'click', target: { ref: link?.ref } });

    expect(effect.actionId).toBeDefined();
    expect(effect.newRevision).toBeGreaterThan(effect.oldRevision);
  });

  it('should fill through a ref and reflect the value on the next observation', async () => {
    const page = await observedPage();
    const state = await page.observe({ mode: 'interactive' });
    const email = state.elements.find((el) => el.role === 'textbox' && el.name === 'Email');

    await page.act({ type: 'fill', target: { ref: email?.ref }, value: 'agent@example.com' });

    const after = await page.observe({ mode: 'interactive' });
    const filled = after.elements.find((el) => el.role === 'textbox' && el.name === 'Email');
    expect(filled?.value).toBe('agent@example.com');
  });

  it('should reject acting on an unknown ref', async () => {
    const page = await observedPage();

    await expect(page.act({ type: 'click', target: { ref: 'e1_99' } })).rejects.toThrow(
      /not found/i
    );
  });
});
