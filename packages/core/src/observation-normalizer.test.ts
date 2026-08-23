/**
 * TDD Tests for Observation Normalization
 *
 * These tests define the expected behavior of semantic observation generation.
 * Following TDD principles, tests are written before implementation.
 */

import type { ObservationRequest, PageState, RawPageState } from '@agentbrowser/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { ObservationNormalizer } from './observation-normalizer';

describe('ObservationNormalizer', () => {
  let normalizer: ObservationNormalizer;

  beforeEach(() => {
    normalizer = new ObservationNormalizer();
  });

  describe('element reference generation', () => {
    it('should generate stable element refs with revision', () => {
      const rawState: RawPageState = {
        url: 'https://example.com',
        title: 'Test Page',
        status: 'interactive',
        content: '<html><body></body></html>',
        elements: [{ role: 'button', visible: true, enabled: true }],
      };

      const observation = normalizer.normalize(rawState, {
        mode: 'interactive',
        revision: 1,
      });

      expect(observation.elements[0].ref).toMatch(/^e\d+_\d+$/);
      expect(observation.revision).toBe(1);
    });

    it('should increment revision on subsequent observations', () => {
      const rawState: RawPageState = {
        url: 'https://example.com',
        title: 'Test Page',
        status: 'interactive',
        content: '<html><body></body></html>',
        elements: [{ role: 'button', visible: true, enabled: true }],
      };

      const obs1 = normalizer.normalize(rawState, {
        mode: 'interactive',
        revision: 1,
      });

      const obs2 = normalizer.normalize(rawState, {
        mode: 'interactive',
        revision: 2,
      });

      expect(obs1.revision).toBe(1);
      expect(obs2.revision).toBe(2);
      expect(obs1.elements[0].ref).not.toBe(obs2.elements[0].ref);
    });
  });

  describe('semantic role extraction', () => {
    it('should preserve semantic roles from accessibility tree', () => {
      const rawState: RawPageState = {
        url: 'https://example.com',
        title: 'Test Page',
        status: 'interactive',
        content: '<html><body></body></html>',
        elements: [
          { role: 'button', name: 'Submit', visible: true, enabled: true },
          { role: 'textbox', name: 'Email', visible: true, enabled: true },
          { role: 'link', name: 'Home', visible: true, enabled: true },
        ],
      };

      const observation = normalizer.normalize(rawState, {
        mode: 'interactive',
        revision: 1,
      });

      expect(observation.elements[0].role).toBe('button');
      expect(observation.elements[1].role).toBe('textbox');
      expect(observation.elements[2].role).toBe('link');
    });

    it('should include element names from accessibility tree', () => {
      const rawState: RawPageState = {
        url: 'https://example.com',
        title: 'Test Page',
        status: 'interactive',
        content: '<html><body></body></html>',
        elements: [{ role: 'button', name: 'Submit', visible: true, enabled: true }],
      };

      const observation = normalizer.normalize(rawState, {
        mode: 'interactive',
        revision: 1,
      });

      expect(observation.elements[0].name).toBe('Submit');
    });
  });

  describe('truncation and prioritization', () => {
    it('should prioritize interactive elements when truncated', () => {
      const rawState: RawPageState = {
        url: 'https://example.com',
        title: 'Test Page',
        status: 'interactive',
        content: '<html><body></body></html>',
        elements: Array.from({ length: 100 }, (_, i) => ({
          role: i < 10 ? 'button' : 'text',
          visible: true,
          enabled: true,
          name: i < 10 ? `Button ${i}` : undefined,
        })),
      };

      const observation = normalizer.normalize(rawState, {
        mode: 'interactive',
        revision: 1,
        maxElements: 20,
      });

      // Should prioritize buttons over text
      const buttonCount = observation.elements.filter((e) => e.role === 'button').length;
      expect(buttonCount).toBeGreaterThan(5);
      expect(observation.elements.length).toBeLessThanOrEqual(20);
    });

    it('should always include focused element even when truncated', () => {
      const rawState: RawPageState = {
        url: 'https://example.com',
        title: 'Test Page',
        status: 'interactive',
        content: '<html><body></body></html>',
        elements: [
          { role: 'button', visible: true, enabled: true, focused: true },
          ...Array.from({ length: 50 }, (_, i) => ({
            role: 'text',
            visible: true,
            enabled: true,
          })),
        ],
      };

      const observation = normalizer.normalize(rawState, {
        mode: 'interactive',
        revision: 1,
        maxElements: 10,
      });

      const focusedElement = observation.elements.find((e) => e.focused);
      expect(focusedElement).toBeDefined();
      expect(observation.elements.slice(0, 3)).toContain(focusedElement);
    });
  });

  describe('observation modes', () => {
    it('should support interactive mode with semantic elements', () => {
      const rawState: RawPageState = {
        url: 'https://example.com',
        title: 'Test Page',
        status: 'interactive',
        content: '<html><body></body></html>',
        elements: [
          { role: 'button', visible: true, enabled: true },
          { role: 'textbox', visible: true, enabled: true },
        ],
      };

      const observation = normalizer.normalize(rawState, {
        mode: 'interactive',
        revision: 1,
      });

      expect(observation.elements.length).toBeGreaterThan(0);
      expect(observation.elements.every((e) => e.role === 'button' || e.role === 'textbox')).toBe(
        true
      );
    });

    it('should support content mode with text content', () => {
      const rawState: RawPageState = {
        url: 'https://example.com',
        title: 'Test Page',
        status: 'interactive',
        content: '<html><body><p>Some content</p></body></html>',
        elements: [{ role: 'text', visible: true, enabled: true }],
      };

      const observation = normalizer.normalize(rawState, {
        mode: 'content',
        revision: 1,
      });

      expect(observation.elements.length).toBeGreaterThan(0);
      expect(observation.truncated).toBeDefined();
    });
  });

  describe('semantic fingerprinting', () => {
    it('should generate fingerprints for staleness detection', () => {
      const rawState: RawPageState = {
        url: 'https://example.com',
        title: 'Test Page',
        status: 'interactive',
        content: '<html><body></body></html>',
        elements: [{ role: 'button', name: 'Submit', visible: true, enabled: true }],
      };

      const observation = normalizer.normalize(rawState, {
        mode: 'interactive',
        revision: 1,
      });

      // Each element should have stable properties for fingerprinting
      expect(observation.elements[0].role).toBeDefined();
      expect(observation.elements[0].visible).toBeDefined();
      expect(observation.elements[0].enabled).toBeDefined();
    });
  });

  describe('form state preservation', () => {
    it('should preserve form element values', () => {
      const rawState: RawPageState = {
        url: 'https://example.com',
        title: 'Test Page',
        status: 'interactive',
        content: '<html><body></body></html>',
        elements: [
          {
            role: 'textbox',
            name: 'Email',
            value: 'test@example.com',
            visible: true,
            enabled: true,
          },
          {
            role: 'checkbox',
            name: 'Agree',
            value: 'checked',
            visible: true,
            enabled: true,
            required: true,
          },
        ],
      };

      const observation = normalizer.normalize(rawState, {
        mode: 'interactive',
        revision: 1,
      });

      expect(observation.elements[0].value).toBe('test@example.com');
      expect(observation.elements[1].value).toBe('checked');
      expect(observation.elements[1].required).toBe(true);
    });
  });

  describe('page state normalization', () => {
    it('should include all required page state fields', () => {
      const rawState: RawPageState = {
        url: 'https://example.com',
        title: 'Test Page',
        status: 'interactive',
        content: '<html><body></body></html>',
        elements: [],
      };

      const observation = normalizer.normalize(rawState, {
        mode: 'interactive',
        revision: 1,
      });

      expect(observation.sessionId).toBeDefined();
      expect(observation.pageId).toBeDefined();
      expect(observation.revision).toBe(1);
      expect(observation.url).toBe('https://example.com');
      expect(observation.title).toBe('Test Page');
      expect(observation.status).toBe('interactive');
      expect(observation.truncated).toBeDefined();
      expect(observation.untrustedContent).toBe(true);
    });

    it('should generate page and session IDs', () => {
      const rawState: RawPageState = {
        url: 'https://example.com',
        title: 'Test Page',
        status: 'interactive',
        content: '<html><body></body></html>',
        elements: [],
      };

      const observation = normalizer.normalize(rawState, {
        mode: 'interactive',
        revision: 1,
        sessionId: 'test-session',
        pageId: 'test-page',
      });

      expect(observation.sessionId).toBe('test-session');
      expect(observation.pageId).toBe('test-page');
    });
  });

  describe('summary generation', () => {
    it('should generate page summary', () => {
      const rawState: RawPageState = {
        url: 'https://example.com/checkout',
        title: 'Checkout',
        status: 'interactive',
        content: '<html><body></body></html>',
        elements: [
          { role: 'textbox', visible: true, enabled: true },
          { role: 'button', visible: true, enabled: true },
          { role: 'button', visible: true, enabled: true },
        ],
      };

      const observation = normalizer.normalize(rawState, {
        mode: 'interactive',
        revision: 1,
      });

      expect(observation.summary).toBeDefined();
      expect(typeof observation.summary).toBe('string');
    });
  });

  describe('error handling', () => {
    it('should handle empty elements array', () => {
      const rawState: RawPageState = {
        url: 'https://example.com',
        title: 'Test Page',
        status: 'interactive',
        content: '<html><body></body></html>',
        elements: [],
      };

      const observation = normalizer.normalize(rawState, {
        mode: 'interactive',
        revision: 1,
      });

      expect(observation.elements).toEqual([]);
      expect(observation.truncated).toBe(false);
    });

    it('should handle missing optional element properties', () => {
      const rawState: RawPageState = {
        url: 'https://example.com',
        title: 'Test Page',
        status: 'interactive',
        content: '<html><body></body></html>',
        elements: [
          { role: 'button', visible: true, enabled: true }, // No name
        ],
      };

      const observation = normalizer.normalize(rawState, {
        mode: 'interactive',
        revision: 1,
      });

      expect(observation.elements[0].name).toBeUndefined();
      expect(observation.elements[0].role).toBe('button');
    });
  });
});
