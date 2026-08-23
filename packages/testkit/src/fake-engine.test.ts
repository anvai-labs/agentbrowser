/**
 * TDD Tests for FakeEngine
 *
 * These tests verify that FakeEngine correctly implements the BrowserEngine
 * interface and behaves as expected for contract testing.
 */

import type { BrowserEngine, EngineCapabilities } from '@agentbrowser/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEngine } from './fake-engine';

describe('FakeEngine', () => {
  let engine: FakeEngine;

  beforeEach(() => {
    engine = new FakeEngine();
  });

  afterEach(async () => {
    await engine.close();
  });

  describe('engine properties', () => {
    it('should have name "fake-engine"', () => {
      expect(engine.name).toBe('fake-engine');
    });

    it('should have version "1.0.0"', () => {
      expect(engine.version).toBe('1.0.0');
    });

    it('should have name as readonly at runtime', () => {
      expect(() => {
        (engine as any).name = 'modified';
      }).toThrow(); // Now protected at runtime with getters
      expect(engine.name).toBe('fake-engine');
    });

    it('should have version as readonly at runtime', () => {
      expect(() => {
        (engine as any).version = '2.0.0';
      }).toThrow(); // Now protected at runtime with getters
      expect(engine.version).toBe('1.0.0');
    });
  });

  describe('capabilities', () => {
    it('should return capabilities', async () => {
      const capabilities = await engine.capabilities();

      expect(capabilities).toBeDefined();
      expect(typeof capabilities.supportsScreenshots).toBe('boolean');
      expect(typeof capabilities.supportsPdf).toBe('boolean');
    });

    it('should support screenshots', async () => {
      const capabilities = await engine.capabilities();
      expect(capabilities.supportsScreenshots).toBe(true);
    });

    it('should support PDF', async () => {
      const capabilities = await engine.capabilities();
      expect(capabilities.supportsPdf).toBe(true);
    });

    it('should support all basic features', async () => {
      const capabilities = await engine.capabilities();

      expect(capabilities.supportsDownloads).toBe(true);
      expect(capabilities.supportsUploads).toBe(true);
      expect(capabilities.supportsJavascript).toBe(true);
      expect(capabilities.supportsPersistentStorage).toBe(true);
      expect(capabilities.supportsAccessibilityTree).toBe(true);
    });

    it('should not support advanced features', async () => {
      const capabilities = await engine.capabilities();

      expect(capabilities.supportsWebgl).toBe(false);
      expect(capabilities.supportsVideo).toBe(false);
      expect(capabilities.supportsCdp).toBe(false);
    });

    it('should support observation modes', async () => {
      const capabilities = await engine.capabilities();

      expect(capabilities.supportedObservationModes).toContain('interactive');
      expect(capabilities.supportedObservationModes).toContain('content');
      expect(capabilities.supportedObservationModes).toContain('accessibility');
    });

    it('should support action types', async () => {
      const capabilities = await engine.capabilities();

      expect(capabilities.supportedActionTypes).toContain('navigate');
      expect(capabilities.supportedActionTypes).toContain('click');
      expect(capabilities.supportedActionTypes).toContain('fill');
    });
  });

  describe('session creation', () => {
    it('should create a session', async () => {
      const session = await engine.createSession({});

      expect(session).toBeDefined();
      expect(session.id).toBeDefined();
      expect(session.id).toMatch(/^fake-session-\d+$/);
    });

    it('should track created sessions', async () => {
      const session1 = await engine.createSession({});
      const session2 = await engine.createSession({});

      expect(engine.hasSession(session1.id)).toBe(true);
      expect(engine.hasSession(session2.id)).toBe(true);
    });

    it('should generate unique session IDs', async () => {
      const session1 = await engine.createSession({});
      const session2 = await engine.createSession({});

      expect(session1.id).not.toBe(session2.id);
    });

    it('should retrieve session by ID', async () => {
      const session = await engine.createSession({});
      const retrieved = engine.getSession(session.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(session.id);
    });

    it('should return undefined for non-existent session', () => {
      const session = engine.getSession('non-existent');

      expect(session).toBeUndefined();
    });
  });

  describe('session operations', () => {
    it('should create pages in session', async () => {
      const session = await engine.createSession({});
      const page = await session.newPage();

      expect(page).toBeDefined();
      expect(page.id).toMatch(/^fake-page-\d+$/);
    });

    it('should list pages in session', async () => {
      const session = await engine.createSession({});
      await session.newPage();
      await session.newPage();

      const pages = await session.pages();

      expect(pages.length).toBe(2);
    });

    it('should return cookies', async () => {
      const session = await engine.createSession({});
      const cookies = await session.cookies();

      expect(cookies).toEqual([]);
    });

    it('should close session', async () => {
      const session = await engine.createSession({});
      await session.close();

      expect(session.isClosed()).toBe(true);
    });
  });

  describe('page operations', () => {
    it('should navigate to URL', async () => {
      const session = await engine.createSession({});
      const page = await session.newPage();

      await page.navigate({ url: 'https://example.com' });

      const observation = await page.observe({ mode: 'interactive' });
      expect(observation.url).toBe('https://example.com');
    });

    it('should observe page state', async () => {
      const session = await engine.createSession({});
      const page = await session.newPage();

      await page.navigate({ url: 'https://example.com' });
      const observation = await page.observe({ mode: 'interactive' });

      expect(observation).toBeDefined();
      expect(observation.url).toBe('https://example.com');
      expect(observation.elements).toBeDefined();
    });

    it('should generate element refs', async () => {
      const session = await engine.createSession({});
      const page = await session.newPage();

      await page.navigate({ url: 'https://example.com' });
      const observation = await page.observe({ mode: 'interactive' });

      expect(observation.elements.length).toBeGreaterThan(0);
      expect(observation.elements[0].ref).toBeDefined();
    });

    it('should execute actions', async () => {
      const session = await engine.createSession({});
      const page = await session.newPage();

      await page.navigate({ url: 'https://example.com' });

      const action = {
        type: 'click',
        target: { ref: 'e1_1' },
      };

      const effect = await page.act(action);

      expect(effect.actionId).toBeDefined();
      expect(effect.newRevision).toBeGreaterThan(effect.oldRevision);
    });

    it('should close page', async () => {
      const session = await engine.createSession({});
      const page = await session.newPage();

      await page.close();

      // Should throw on operations after close
      await expect(page.observe({ mode: 'interactive' })).rejects.toThrow('Page is closed');
    });

    it('should emit the canonical fingerprint format', async () => {
      const session = await engine.createSession({});
      const page = await session.newPage();

      await page.navigate({ url: 'https://example.com' });
      const observation = await page.observe({ mode: 'interactive' });

      // The engine contract requires the canonical semantic fingerprint
      // (`role_name_visible_X_enabled_Y[_value_Z]`) so that resolved targets
      // can be compared against normalized observations.
      const target = observation.elements[0];
      const resolved = await page.resolve({ ref: target.ref });

      const expected = [
        target.role,
        target.name ?? '',
        `visible_${target.visible}`,
        `enabled_${target.enabled}`,
        target.value !== undefined && target.value !== '' ? `value_${target.value}` : '',
      ]
        .filter(Boolean)
        .join('_');

      expect(resolved.fingerprint).toBe(expected);
    });

    it('should allow tests to inject elements with risk metadata', async () => {
      const engine2 = new FakeEngine();
      const session = await engine2.createSession({});
      const page = await session.newPage();

      const fakePage = engine2.getFakePage(session.id, page.id);
      expect(fakePage).toBeDefined();

      fakePage!.setElements([
        {
          ref: `e${1}_0`,
          role: 'button',
          name: 'Pay now',
          visible: true,
          enabled: true,
          risk: 'transaction',
        },
      ]);

      const observation = await page.observe({ mode: 'interactive' });
      expect(observation.elements[0].name).toBe('Pay now');
      expect(observation.elements[0].risk).toBe('transaction');
    });
  });

  describe('engine cleanup', () => {
    it('should close engine', async () => {
      await engine.createSession({});
      await engine.createSession({});

      await engine.close();

      // After closing, sessions should be closed
      expect(engine.getSession('fake-session-0')).toBeUndefined();
      expect(engine.getSession('fake-session-1')).toBeUndefined();
    });

    it('should handle closing empty engine', async () => {
      await expect(engine.close()).resolves.not.toThrow();
    });

    it('should close all sessions on engine close', async () => {
      const session1 = await engine.createSession({});
      const session2 = await engine.createSession({});

      await engine.close();

      expect(session1.isClosed()).toBe(true);
      expect(session2.isClosed()).toBe(true);
    });
  });

  describe('interface compliance', () => {
    it('should implement BrowserEngine interface', () => {
      expect(engine).toMatchObject({
        name: expect.any(String),
        version: expect.any(String),
      });

      expect(typeof engine.capabilities).toBe('function');
      expect(typeof engine.createSession).toBe('function');
      expect(typeof engine.close).toBe('function');
    });
  });
});

describe('FakeEngine Integration', () => {
  it('should work in complete workflow', async () => {
    const engine = new FakeEngine();

    try {
      // Create session
      const session = await engine.createSession({
        viewport: { width: 1280, height: 720 },
      });

      // Create page
      const page = await session.newPage();

      // Navigate
      await page.navigate({ url: 'https://example.com' });

      // Observe
      const observation = await page.observe({ mode: 'interactive' });

      expect(observation.elements.length).toBeGreaterThan(0);

      // Act
      const effect = await page.act({
        type: 'click',
        target: { ref: observation.elements[0].ref || 'e1_1' },
      });

      expect(effect.newRevision).toBeGreaterThan(0);

      // Cleanup
      await page.close();
      await session.close();
    } finally {
      await engine.close();
    }
  });

  it('should handle multiple sessions', async () => {
    const engine = new FakeEngine();

    try {
      const session1 = await engine.createSession({});
      const session2 = await engine.createSession({});

      const page1 = await session1.newPage();
      const page2 = await session2.newPage();

      await page1.navigate({ url: 'https://example1.com' });
      await page2.navigate({ url: 'https://example2.com' });

      const obs1 = await page1.observe({ mode: 'interactive' });
      const obs2 = await page2.observe({ mode: 'interactive' });

      expect(obs1.url).toBe('https://example1.com');
      expect(obs2.url).toBe('https://example2.com');
    } finally {
      await engine.close();
    }
  });
});
