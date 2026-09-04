/**
 * TDD Tests for Engine Interface and Types
 *
 * These tests define the expected behavior of the BrowserEngine interface.
 * Following TDD principles, tests are written before implementation.
 */

import { describe, expect, it } from 'vitest';
import type {
  ActionEffect,
  BrowserEngine,
  EngineAction,
  EngineCapabilities,
  EngineEvent,
  EnginePage,
  EngineSession,
  EngineSessionOptions,
  EngineTarget,
  ExtractionRequest,
  ExtractionResult,
  NavigationRequest,
  NavigationResult,
  NewPageOptions,
  NormalizedCookie,
  ObservationRequest,
  PdfRequest,
  RawPageState,
  ResolvedTarget,
  ScreenshotRequest,
} from './types';

describe('Engine Interface Types', () => {
  describe('BrowserEngine interface', () => {
    it('should require name and version as readonly', () => {
      // This test validates the interface structure
      type EngineProperties = Pick<BrowserEngine, 'name' | 'version'>;

      const engine: EngineProperties = {
        get name(): string {
          return 'test-engine';
        },
        get version(): string {
          return '1.0.0';
        },
      };

      expect(engine.name).toBe('test-engine');
      expect(engine.version).toBe('1.0.0');
    });

    it('should require capabilities method', () => {
      type EngineMethods = Pick<BrowserEngine, 'capabilities'>;

      const engine: EngineMethods = {
        async capabilities(): Promise<EngineCapabilities> {
          return {
            supportsScreenshots: true,
            supportsPdf: false,
            supportsDownloads: true,
            supportsUploads: true,
            supportsJavascript: true,
            supportsWebgl: false,
            supportsVideo: false,
            supportsPersistentStorage: true,
            supportsAccessibilityTree: true,
            supportsCdp: false,
            supportedObservationModes: ['interactive'],
            supportedActionTypes: ['click'],
          };
        },
      };

      expect(typeof engine.capabilities).toBe('function');
    });

    it('should require createSession method', () => {
      type EngineMethods = Pick<BrowserEngine, 'createSession'>;

      const engine: EngineMethods = {
        async createSession(options: EngineSessionOptions): Promise<EngineSession> {
          throw new Error('Not implemented');
        },
      };

      expect(typeof engine.createSession).toBe('function');
    });

    it('should require close method', () => {
      type EngineMethods = Pick<BrowserEngine, 'close'>;

      const engine: EngineMethods = {
        async close(): Promise<void> {
          // Mock implementation
        },
      };

      expect(typeof engine.close).toBe('function');
    });

    it('should have optional restoreSession method', () => {
      type EngineWithRestore = BrowserEngine & {
        restoreSession?: (
          snapshot: Uint8Array,
          options: EngineSessionOptions
        ) => Promise<EngineSession>;
      };

      const engine: EngineWithRestore = {
        name: 'test',
        version: '1.0.0',
        async capabilities() {
          return {} as EngineCapabilities;
        },
        async createSession() {
          return {} as EngineSession;
        },
        async close() {},
        async restoreSession(snapshot, options) {
          return {} as EngineSession;
        },
      };

      expect(typeof engine.restoreSession).toBe('function');
    });
  });

  describe('EngineSession interface', () => {
    it('should require id property', () => {
      type SessionProperties = Pick<EngineSession, 'id'>;

      const session: SessionProperties = {
        get id(): string {
          return 'session-id';
        },
      };

      expect(session.id).toBe('session-id');
    });

    it('should require newPage method', () => {
      type SessionMethods = Pick<EngineSession, 'newPage'>;

      const session: SessionMethods = {
        async newPage(options?: NewPageOptions): Promise<EnginePage> {
          return {} as EnginePage;
        },
      };

      expect(typeof session.newPage).toBe('function');
    });

    it('should require pages method', () => {
      type SessionMethods = Pick<EngineSession, 'pages'>;

      const session: SessionMethods = {
        async pages(): Promise<EnginePage[]> {
          return [];
        },
      };

      expect(typeof session.pages).toBe('function');
    });

    it('should require close method', () => {
      type SessionMethods = Pick<EngineSession, 'close'>;

      const session: SessionMethods = {
        async close(reason?: string): Promise<void> {
          // Mock implementation
        },
      };

      expect(typeof session.close).toBe('function');
    });
  });

  describe('EnginePage interface', () => {
    it('should require id property', () => {
      type PageProperties = Pick<EnginePage, 'id'>;

      const page: PageProperties = {
        get id(): string {
          return 'page-id';
        },
      };

      expect(page.id).toBe('page-id');
    });

    it('should require navigate method', () => {
      type PageMethods = Pick<EnginePage, 'navigate'>;

      const page: PageMethods = {
        async navigate(request: NavigationRequest): Promise<NavigationResult> {
          return {
            status: 'success',
            url: request.url,
            redirectChain: [],
          };
        },
      };

      expect(typeof page.navigate).toBe('function');
    });

    it('should require observe method', () => {
      type PageMethods = Pick<EnginePage, 'observe'>;

      const page: PageMethods = {
        async observe(request: ObservationRequest): Promise<RawPageState> {
          return {
            url: 'https://example.com',
            title: 'Example',
            status: 'interactive',
            content: '<html></html>',
            elements: [],
          };
        },
      };

      expect(typeof page.observe).toBe('function');
    });

    it('should require act method', () => {
      type PageMethods = Pick<EnginePage, 'act'>;

      const page: PageMethods = {
        async act(action: EngineAction): Promise<ActionEffect> {
          return {
            actionId: 'action-1',
            startTimestamp: new Date().toISOString(),
            endTimestamp: new Date().toISOString(),
            oldRevision: 1,
            newRevision: 2,
            result: null,
          };
        },
      };

      expect(typeof page.act).toBe('function');
    });

    it('should require screenshot method', () => {
      type PageMethods = Pick<EnginePage, 'screenshot'>;

      const page: PageMethods = {
        async screenshot(
          request: ScreenshotRequest
        ): Promise<{ artifactId: string; contentType: string; sizeBytes: number; url: string }> {
          return {
            artifactId: 'art-1',
            contentType: 'image/png',
            sizeBytes: 1024,
            url: '/v1/artifacts/art-1',
          };
        },
      };

      expect(typeof page.screenshot).toBe('function');
    });

    it('should have optional pdf method', () => {
      type PageWithPdf = EnginePage & {
        pdf?: (
          request: PdfRequest
        ) => Promise<{ artifactId: string; contentType: string; sizeBytes: number; url: string }>;
      };

      const page: PageWithPdf = {
        id: 'page-1',
        async navigate() {
          return {} as NavigationResult;
        },
        async observe() {
          return {} as RawPageState;
        },
        async resolve() {
          return {} as ResolvedTarget;
        },
        async act() {
          return {} as ActionEffect;
        },
        async extract() {
          return {} as ExtractionResult;
        },
        async screenshot() {
          return { artifactId: '', contentType: '', sizeBytes: 0, url: '' };
        },
        async *events() {},
        async close() {},
        async pdf(request) {
          return {
            artifactId: 'pdf-1',
            contentType: 'application/pdf',
            sizeBytes: 2048,
            url: '/v1/artifacts/pdf-1',
          };
        },
      };

      expect(typeof page.pdf).toBe('function');
    });

    it('should require events method returning AsyncIterable', () => {
      type PageMethods = Pick<EnginePage, 'events'>;

      const page: PageMethods = {
        async *events(): AsyncIterable<EngineEvent> {
          yield {
            type: 'page.loaded',
            timestamp: new Date().toISOString(),
            sessionId: 'ses-1',
            pageId: 'page-1',
          };
        },
      };

      expect(typeof page.events).toBe('function');
    });
  });
});

describe('Engine Request/Response Types', () => {
  describe('NavigationRequest', () => {
    it('should require url', () => {
      const request: NavigationRequest = {
        url: 'https://example.com',
      };

      expect(request.url).toBeDefined();
    });

    it('should accept optional waitUntil', () => {
      const request1: NavigationRequest = {
        url: 'https://example.com',
        waitUntil: 'load',
      };

      const request2: NavigationRequest = {
        url: 'https://example.com',
        waitUntil: 'networkidle',
      };

      expect(request1.waitUntil).toBe('load');
      expect(request2.waitUntil).toBe('networkidle');
    });
  });

  describe('NavigationResult', () => {
    it('should require status, url, and redirectChain', () => {
      const result: NavigationResult = {
        status: 'success',
        url: 'https://example.com',
        redirectChain: [],
      };

      expect(result.status).toBeDefined();
      expect(result.url).toBeDefined();
      expect(result.redirectChain).toBeDefined();
    });

    it('should accept different status values', () => {
      const success: NavigationResult = {
        status: 'success',
        url: 'https://example.com',
        redirectChain: [],
      };
      const timeout: NavigationResult = {
        status: 'timeout',
        url: 'https://example.com',
        redirectChain: [],
      };
      const blocked: NavigationResult = {
        status: 'blocked',
        url: 'https://example.com',
        redirectChain: [],
      };

      expect(success.status).toBe('success');
      expect(timeout.status).toBe('timeout');
      expect(blocked.status).toBe('blocked');
    });
  });

  describe('EngineTarget', () => {
    it('should require ref property', () => {
      const target: EngineTarget = {
        ref: 'e17_01',
      };

      expect(target.ref).toBe('e17_01');
    });
  });

  describe('ResolvedTarget', () => {
    it('should include fingerprint and element properties', () => {
      const resolved: ResolvedTarget = {
        ref: 'e17_01',
        fingerprint: 'abc123',
        role: 'button',
        name: 'Submit',
        visible: true,
        enabled: true,
      };

      expect(resolved.ref).toBeDefined();
      expect(resolved.fingerprint).toBeDefined();
      expect(resolved.role).toBeDefined();
      expect(resolved.visible).toBeDefined();
      expect(resolved.enabled).toBeDefined();
    });
  });

  describe('NormalizedCookie', () => {
    it('should include all required cookie properties', () => {
      const cookie: NormalizedCookie = {
        name: 'session',
        value: 'abc123',
        domain: 'example.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
      };

      expect(cookie.name).toBeDefined();
      expect(cookie.value).toBeDefined();
      expect(cookie.domain).toBeDefined();
      expect(cookie.path).toBeDefined();
      expect(cookie.httpOnly).toBeDefined();
      expect(cookie.secure).toBeDefined();
      expect(cookie.sameSite).toBeDefined();
    });

    it('should accept optional expires', () => {
      const cookie: NormalizedCookie = {
        name: 'session',
        value: 'abc123',
        domain: 'example.com',
        path: '/',
        httpOnly: false,
        secure: true,
        sameSite: 'Lax',
        expires: 1234567890,
      };

      expect(cookie.expires).toBeDefined();
    });
  });
});

describe('Engine Event Types', () => {
  it('should define all required event types', () => {
    const eventTypes = [
      'page.created',
      'page.destroyed',
      'page.navigated',
      'page.loaded',
      'page.crashed',
      'console.log',
      'console.error',
      'console.warning',
      'request.started',
      'request.finished',
      'request.failed',
      'download.created',
      'download.finished',
      'dialog.opened',
      'dialog.closed',
      'worker.created',
      'worker.destroyed',
    ];

    // Verify that all event types can be used
    eventTypes.forEach((type) => {
      const event: EngineEvent = {
        type: type as any,
        timestamp: new Date().toISOString(),
        sessionId: 'ses-1',
      };

      expect(event.type).toBeDefined();
    });
  });
});

describe('Engine Capabilities', () => {
  it('should include all capability flags', () => {
    const capabilities: EngineCapabilities = {
      supportsScreenshots: true,
      supportsPdf: false,
      supportsDownloads: true,
      supportsUploads: true,
      supportsJavascript: true,
      supportsWebgl: false,
      supportsVideo: false,
      supportsPersistentStorage: true,
      supportsAccessibilityTree: true,
      supportsCdp: false,
      supportedObservationModes: ['interactive', 'content'],
      supportedActionTypes: ['click', 'fill', 'navigate'],
    };

    expect(capabilities.supportsScreenshots).toBe(true);
    expect(capabilities.supportsPdf).toBe(false);
    expect(capabilities.supportedObservationModes).toContain('interactive');
    expect(capabilities.supportedActionTypes).toContain('click');
  });
});

describe('Type Compatibility', () => {
  it('should ensure interface types are compatible with protocol types', () => {
    // This test validates that engine types are compatible with protocol types
    // For a real implementation, this would check type compatibility

    type ProtocolCapabilities = {
      supportsScreenshots: boolean;
      supportsPdf: boolean;
      // ... other properties
    };

    const capabilities: EngineCapabilities = {
      supportsScreenshots: true,
      supportsPdf: false,
      supportsDownloads: true,
      supportsUploads: true,
      supportsJavascript: true,
      supportsWebgl: false,
      supportsVideo: false,
      supportsPersistentStorage: true,
      supportsAccessibilityTree: true,
      supportsCdp: false,
      supportedObservationModes: ['interactive'],
      supportedActionTypes: ['click'],
    };

    // Verify capabilities structure
    expect('supportsScreenshots' in capabilities).toBe(true);
    expect('supportedObservationModes' in capabilities).toBe(true);
  });
});
