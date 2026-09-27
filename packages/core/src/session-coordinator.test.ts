/**
 * TDD Tests for Session Coordinator
 *
 * These tests define the expected behavior of session lifecycle management.
 * Written following TDD principles before implementation.
 */

import type {
  BrowserEngine,
  EngineCapabilities,
  EngineSession,
  EngineSessionOptions,
  RequestPolicy,
} from '@agentbrowser/engine';
import type { SessionRequest } from '@agentbrowser/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StructuredLogger } from './logger';
import { SessionCoordinator, SessionState } from './session-coordinator';

// Mock engine implementation for testing
class MockEngine implements BrowserEngine {
  readonly name = 'mock-engine';
  readonly version = '1.0.0';

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
      supportedObservationModes: ['interactive', 'content'],
      supportedActionTypes: ['click', 'fill', 'navigate'],
    };
  }

  /** Captures the options the coordinator forwarded, for assertions. */
  lastOptions?: EngineSessionOptions;

  async createSession(options?: EngineSessionOptions): Promise<EngineSession> {
    this.lastOptions = options;
    return new MockEngineSession();
  }

  async close(): Promise<void> {
    // Mock cleanup
  }
}

class MockEngineSession implements EngineSession {
  id = 'mock-session-id';
  closed = false;
  closeReason?: string;

  async newPage(): Promise<any> {
    return {}; // Mock page
  }

  async pages(): Promise<any[]> {
    return [];
  }

  async cookies(): Promise<any[]> {
    return [];
  }

  async close(reason?: string): Promise<void> {
    this.closed = true;
    this.closeReason = reason;
  }
}

describe('SessionCoordinator', () => {
  it('does not allocate or register a session when adapter capabilities fail', async () => {
    const owner = new SessionCoordinator();
    const engine = new MockEngine();
    const failure = new Error('capabilities unavailable');
    vi.spyOn(engine, 'capabilities').mockRejectedValue(failure);
    const create = vi.spyOn(engine, 'createSession');
    try {
      await expect(owner.create({ engine: 'auto' }, engine)).rejects.toBe(failure);
      expect(owner.getSessionCount()).toBe(0);
      expect(create).not.toHaveBeenCalled();
    } finally {
      await owner.shutdown();
    }
  });
  it('cancels consumers when the background sweep detects expiry', async () => {
    vi.useFakeTimers();
    const owner = new SessionCoordinator({ cleanupCheckIntervalMs: 10 });
    try {
      const created = await owner.create({ engine: 'auto', ttlMs: 20 }, new MockEngine());
      const context = owner.get(created.sessionId);
      if (!context) throw new Error('Missing session context');
      await vi.advanceTimersByTimeAsync(30);
      expect(context.signal.aborted).toBe(true);
      expect(context.signal.reason).toMatchObject({ code: 'SESSION_EXPIRED' });
      expect(context.metadata.state).toBe(SessionState.EXPIRED);
    } finally {
      await owner.shutdown();
      vi.useRealTimers();
    }
  });
  it.each(['close', 'terminate', 'expiry', 'shutdown'])(
    'cancels session consumers before engine teardown: %s',
    async (mode) => {
      const owner = new SessionCoordinator({ cleanupCheckIntervalMs: 3_600_000 });
      const created = await owner.create({ engine: 'auto', ttlMs: 60_000 }, new MockEngine());
      const context = owner.get(created.sessionId);
      if (!context) throw new Error('Missing session context');
      let finish!: () => void;
      const stalled = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const close = vi.spyOn(context.engineSession, 'close').mockImplementation(() => {
        expect(context.signal.aborted).toBe(true);
        return stalled;
      });
      let completion: Promise<void> | undefined;
      try {
        if (mode === 'close') completion = owner.close(created.sessionId);
        else if (mode === 'terminate')
          completion = owner.terminate(created.sessionId, SessionState.ENGINE_CRASHED, 'crash');
        else if (mode === 'shutdown') completion = owner.shutdown();
        else {
          context.metadata.expiresAt = 0;
          expect(owner.get(created.sessionId)).toBeUndefined();
        }
        expect(context.signal.aborted).toBe(true);
        expect(close).toHaveBeenCalledTimes(1);
        expect(context.metadata.state).toBe(context.state);
      } finally {
        finish();
        await completion;
        await owner.shutdown();
        expect(context.metadata.state).toBe(context.state);
      }
    }
  );
  let coordinator: SessionCoordinator;
  let mockEngine: MockEngine;

  beforeEach(() => {
    coordinator = new SessionCoordinator({
      maxSessions: 10,
      defaultIdleTimeoutMs: 120000,
      cleanupCheckIntervalMs: 1000,
    });
    mockEngine = new MockEngine();
  });

  afterEach(async () => {
    await coordinator.shutdown();
  });

  describe('session creation', () => {
    it('should create session in READY state', async () => {
      const request: SessionRequest = {
        engine: 'mock-engine',
        ttlMs: 900000,
      };

      const response = await coordinator.create(request, mockEngine);
      const session = coordinator.get(response.sessionId);

      expect(session).toBeDefined();
      expect(session?.state).toBe(SessionState.READY);
      expect(session?.metadata.state).toBe(SessionState.READY);
    });

    it('should forward seed cookies to the engine', async () => {
      // Regression: the coordinator built sessionOptions but dropped `cookies`,
      // so an authenticated-session reuse silently created an anonymous context.
      const cookies = [
        {
          name: '__Host-databricksapps',
          value: 'reused-auth-value',
          domain: 'app.example.com',
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'Lax' as const,
        },
      ];
      const request: SessionRequest = {
        engine: 'mock-engine',
        ttlMs: 900000,
        cookies,
      };

      await coordinator.create(request, mockEngine);

      expect(mockEngine.lastOptions?.cookies).toEqual(cookies);
    });

    it('defaults headless to true when the request omits it (pinned: the pool stays honest)', async () => {
      // The headless-first default (ADR-003) lives HERE, not in callers — a
      // request that omits `headless` must land on the engine as an explicit
      // `true`, never as `undefined` (which some engines could read as headed).
      await coordinator.create({ engine: 'mock-engine' }, mockEngine);
      expect(mockEngine.lastOptions?.headless).toBe(true);

      await coordinator.create({ engine: 'mock-engine', headless: false }, mockEngine);
      expect(mockEngine.lastOptions?.headless).toBe(false);
    });

    it('should generate unique session IDs', async () => {
      const request: SessionRequest = { engine: 'mock-engine' };

      const session1 = await coordinator.create(request, mockEngine);
      const session2 = await coordinator.create(request, mockEngine);

      expect(session1.sessionId).not.toBe(session2.sessionId);
    });

    it('should set creation timestamp', async () => {
      const request: SessionRequest = { engine: 'mock-engine' };
      const beforeCreate = Date.now();

      const response = await coordinator.create(request, mockEngine);
      const session = coordinator.get(response.sessionId);

      expect(session?.metadata.createdAt).toBeGreaterThanOrEqual(beforeCreate);
      expect(session?.metadata.createdAt).toBeLessThanOrEqual(Date.now());
    });

    it('should calculate expiration time', async () => {
      const request: SessionRequest = {
        engine: 'mock-engine',
        ttlMs: 60000,
      };

      const beforeCreate = Date.now();
      const response = await coordinator.create(request, mockEngine);
      const session = coordinator.get(response.sessionId);

      const expectedExpiresAt = beforeCreate + 60000;
      expect(session?.metadata.expiresAt).toBeGreaterThanOrEqual(expectedExpiresAt - 100);
      expect(session?.metadata.expiresAt).toBeLessThanOrEqual(expectedExpiresAt + 100);
    });

    it('should use default TTL when not specified', async () => {
      const request: SessionRequest = { engine: 'mock-engine' };

      const response = await coordinator.create(request, mockEngine);
      const session = coordinator.get(response.sessionId);

      expect(session?.metadata.ttlMs).toBe(12600000); // Default: 3.5 hours
      expect(response.ttlMs).toBe(12600000);
    });

    it('should use default idle timeout when not specified', async () => {
      const request: SessionRequest = { engine: 'mock-engine' };

      const response = await coordinator.create(request, mockEngine);
      const session = coordinator.get(response.sessionId);

      expect(session?.metadata.idleTimeoutMs).toBe(120000); // Default
      expect(response.idleTimeoutMs).toBe(120000);
    });

    it('defaults the idle timeout to 10 minutes without configuration', async () => {
      const unconfigured = new SessionCoordinator({ maxSessions: 1 });
      try {
        const response = await unconfigured.create({ engine: 'mock-engine' }, mockEngine);
        expect(response.idleTimeoutMs).toBe(600000);
      } finally {
        await unconfigured.shutdown();
      }
    });

    it('should enforce max session limit', async () => {
      const coordinator = new SessionCoordinator({ maxSessions: 2 });
      const request: SessionRequest = { engine: 'mock-engine' };

      // Create 2 sessions successfully
      await coordinator.create(request, mockEngine);
      await coordinator.create(request, mockEngine);

      // 3rd session should fail
      await expect(coordinator.create(request, mockEngine)).rejects.toThrow('QUOTA_EXCEEDED');

      await coordinator.shutdown();
    });
  });

  describe('session retrieval', () => {
    it('should return session by ID', async () => {
      const request: SessionRequest = { engine: 'mock-engine' };
      const response = await coordinator.create(request, mockEngine);

      const session = coordinator.get(response.sessionId);

      expect(session).toBeDefined();
      expect(session?.id).toBe(response.sessionId);
    });

    it('should return undefined for non-existent session', () => {
      const session = coordinator.get('non-existent-id');

      expect(session).toBeUndefined();
    });

    it('should check expiration on retrieval', async () => {
      const request: SessionRequest = {
        engine: 'mock-engine',
        ttlMs: 100, // Very short TTL
      };

      const response = await coordinator.create(request, mockEngine);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 150));

      const session = coordinator.get(response.sessionId);

      // Session should be expired and removed
      expect(session).toBeUndefined();
    });
  });

  describe('session activity', () => {
    it('should update last activity time', async () => {
      const request: SessionRequest = { engine: 'mock-engine' };
      const response = await coordinator.create(request, mockEngine);

      const beforeUpdate = Date.now();
      coordinator.updateActivity(response.sessionId);
      const session = coordinator.get(response.sessionId);

      expect(session?.metadata.lastActivityAt).toBeGreaterThanOrEqual(beforeUpdate);
      expect(session?.metadata.lastActivityAt).toBeLessThanOrEqual(Date.now());
    });

    it('should transition to ACTIVE on first activity', async () => {
      const request: SessionRequest = { engine: 'mock-engine' };
      const response = await coordinator.create(request, mockEngine);

      // Initially READY
      let session = coordinator.get(response.sessionId);
      expect(session?.state).toBe(SessionState.READY);

      // Update activity
      coordinator.updateActivity(response.sessionId);
      session = coordinator.get(response.sessionId);

      // Should be ACTIVE
      expect(session?.state).toBe(SessionState.ACTIVE);
      expect(session?.metadata.state).toBe(SessionState.ACTIVE);
      expect(coordinator.getAllSessions()[0]?.state).toBe(SessionState.ACTIVE);
    });

    it('should remain ACTIVE on subsequent activities', async () => {
      const request: SessionRequest = { engine: 'mock-engine' };
      const response = await coordinator.create(request, mockEngine);

      // First activity
      coordinator.updateActivity(response.sessionId);
      let session = coordinator.get(response.sessionId);
      expect(session?.state).toBe(SessionState.ACTIVE);

      // Second activity
      coordinator.updateActivity(response.sessionId);
      session = coordinator.get(response.sessionId);

      // Should still be ACTIVE
      expect(session?.state).toBe(SessionState.ACTIVE);
    });
  });

  describe('session closure', () => {
    it('should close session successfully', async () => {
      const request: SessionRequest = { engine: 'mock-engine' };
      const response = await coordinator.create(request, mockEngine);

      await coordinator.close(response.sessionId, 'user_requested');

      const session = coordinator.get(response.sessionId);
      expect(session).toBeUndefined();
    });

    it('should mark session as CLOSING before closure', async () => {
      const request: SessionRequest = { engine: 'mock-engine' };
      const response = await coordinator.create(request, mockEngine);

      const closePromise = coordinator.close(response.sessionId);

      // Check state during closure
      const session = coordinator.get(response.sessionId);
      expect(session?.state).toBe(SessionState.CLOSING);

      await closePromise;
    });

    it('should close engine session', async () => {
      const request: SessionRequest = { engine: 'mock-engine' };
      const response = await coordinator.create(request, mockEngine);

      const session = coordinator.get(response.sessionId);
      const engineSession = session?.engineSession;

      await coordinator.close(response.sessionId, 'test');

      expect((engineSession as MockEngineSession).closed).toBe(true);
      expect((engineSession as MockEngineSession).closeReason).toBe('test');
    });

    it('keeps metadata synchronized when engine close fails', async () => {
      const created = await coordinator.create({ engine: 'mock-engine' }, mockEngine);
      const context = coordinator.get(created.sessionId);
      if (!context) throw new Error('Missing session context');
      vi.spyOn(context.engineSession, 'close').mockRejectedValueOnce(new Error('close failed'));
      await expect(coordinator.close(created.sessionId)).rejects.toThrow('close failed');
      expect(context.state).toBe(SessionState.ENGINE_CRASHED);
      expect(context.metadata.state).toBe(SessionState.ENGINE_CRASHED);
      expect(coordinator.getAllSessions()[0]?.state).toBe(SessionState.ENGINE_CRASHED);
    });

    it('should throw for non-existent session', async () => {
      await expect(coordinator.close('non-existent-id', 'test')).rejects.toThrow(
        'SESSION_NOT_FOUND'
      );
    });

    it('should transition to CLOSED state', async () => {
      const request: SessionRequest = { engine: 'mock-engine' };
      const response = await coordinator.create(request, mockEngine);

      const session = coordinator.get(response.sessionId);

      await coordinator.close(response.sessionId);

      expect(session?.state).toBe(SessionState.CLOSED);
    });
  });

  describe('session counting', () => {
    it('should return zero sessions initially', () => {
      expect(coordinator.getSessionCount()).toBe(0);
    });

    it('should increment session count on creation', async () => {
      const request: SessionRequest = { engine: 'mock-engine' };

      await coordinator.create(request, mockEngine);
      expect(coordinator.getSessionCount()).toBe(1);

      await coordinator.create(request, mockEngine);
      expect(coordinator.getSessionCount()).toBe(2);
    });

    it('should decrement session count on closure', async () => {
      const request: SessionRequest = { engine: 'mock-engine' };

      await coordinator.create(request, mockEngine);
      await coordinator.create(request, mockEngine);
      expect(coordinator.getSessionCount()).toBe(2);

      const response = await coordinator.create(request, mockEngine);
      expect(coordinator.getSessionCount()).toBe(3);

      await coordinator.close(response.sessionId);
      expect(coordinator.getSessionCount()).toBe(2);
    });
  });

  describe('session listing', () => {
    it('should return empty array initially', () => {
      const sessions = coordinator.getAllSessions();

      expect(sessions).toEqual([]);
      expect(sessions.length).toBe(0);
    });

    it('should return session metadata', async () => {
      const request: SessionRequest = {
        engine: 'mock-engine',
        ttlMs: 60000,
        idleTimeoutMs: 30000,
      };

      const response = await coordinator.create(request, mockEngine);
      const sessions = coordinator.getAllSessions();

      expect(sessions.length).toBe(1);
      expect(sessions[0]).toMatchObject({
        id: response.sessionId,
        state: SessionState.READY,
        ttlMs: 60000,
        idleTimeoutMs: 30000,
        engineName: 'mock-engine',
      });
    });

    it('should return multiple sessions', async () => {
      const request: SessionRequest = { engine: 'mock-engine' };

      await coordinator.create(request, mockEngine);
      await coordinator.create(request, mockEngine);
      await coordinator.create(request, mockEngine);

      const sessions = coordinator.getAllSessions();

      expect(sessions.length).toBe(3);
    });
  });

  describe('crash termination', () => {
    it('should terminate a session as ENGINE_CRASHED and release tracking', async () => {
      const engine = new MockEngine();
      const coordinator = new SessionCoordinator({ cleanupCheckIntervalMs: 3_600_000 });
      const created = await coordinator.create({ engine: 'auto', headless: true }, engine);

      await coordinator.terminate(created.sessionId, SessionState.ENGINE_CRASHED, 'page crashed');

      expect(coordinator.get(created.sessionId)).toBeUndefined();
      expect(coordinator.getAllSessions()).toHaveLength(0);
    });

    it('should close the engine session best-effort on termination', async () => {
      const engine = new MockEngine();
      const coordinator = new SessionCoordinator({ cleanupCheckIntervalMs: 3_600_000 });
      const created = await coordinator.create({ engine: 'auto', headless: true }, engine);

      const context = coordinator.get(created.sessionId);
      const engineSession = context?.engineSession as MockEngineSession;

      await coordinator.terminate(created.sessionId, SessionState.ENGINE_CRASHED, 'crash');

      expect(engineSession.closed).toBe(true);
    });

    it('should reject terminating an unknown session', async () => {
      const coordinator = new SessionCoordinator({ cleanupCheckIntervalMs: 3_600_000 });
      await expect(
        coordinator.terminate('ses_missing', SessionState.ENGINE_CRASHED, 'x')
      ).rejects.toThrow('SESSION_NOT_FOUND');
    });
  });

  describe('cleanup', () => {
    it('should shutdown all sessions', async () => {
      const request: SessionRequest = { engine: 'mock-engine' };

      await coordinator.create(request, mockEngine);
      await coordinator.create(request, mockEngine);
      await coordinator.create(request, mockEngine);

      expect(coordinator.getSessionCount()).toBe(3);

      await coordinator.shutdown();

      expect(coordinator.getSessionCount()).toBe(0);
    });

    it('should cleanup expired sessions', async () => {
      const shortLivedCoordinator = new SessionCoordinator({
        defaultTtlMs: 100,
        cleanupCheckIntervalMs: 50,
      });

      const request: SessionRequest = { engine: 'mock-engine' };

      await shortLivedCoordinator.create(request, mockEngine);
      expect(shortLivedCoordinator.getSessionCount()).toBe(1);

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(shortLivedCoordinator.getSessionCount()).toBe(0);

      await shortLivedCoordinator.shutdown();
    });

    it('should route a failed cleanup-close through the injected logger, not console (hygiene G2)', async () => {
      const lines: string[] = [];
      const logger = new StructuredLogger({ sink: (line) => lines.push(line) });
      const failingEngine = new MockEngine();
      failingEngine.createSession = async () => {
        const session = new MockEngineSession();
        session.close = async () => {
          throw new Error('engine session close failed');
        };
        return session;
      };
      const loggedCoordinator = new SessionCoordinator({
        defaultTtlMs: 50,
        cleanupCheckIntervalMs: 30,
        logger,
      });

      await loggedCoordinator.create({ engine: 'mock-engine' }, failingEngine);
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(lines.some((line) => line.includes('session.cleanup-close-failed'))).toBe(true);
      expect(lines.some((line) => line.includes('engine session close failed'))).toBe(true);

      await loggedCoordinator.shutdown();
    });

    it('should stringify non-Error cleanup-close failures for the logger', async () => {
      const lines: string[] = [];
      const logger = new StructuredLogger({ sink: (line) => lines.push(line) });
      const failingEngine = new MockEngine();
      failingEngine.createSession = async () => {
        const session = new MockEngineSession();
        session.close = async () => {
          throw 'close failed without an error object';
        };
        return session;
      };
      const loggedCoordinator = new SessionCoordinator({
        defaultTtlMs: 50,
        cleanupCheckIntervalMs: 30,
        logger,
      });

      await loggedCoordinator.create({ engine: 'mock-engine' }, failingEngine);
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(lines.some((line) => line.includes('close failed without an error object'))).toBe(
        true
      );

      await loggedCoordinator.shutdown();
    });
  });

  describe('engine integration', () => {
    it('should pass viewport options to engine', async () => {
      const request: SessionRequest = {
        engine: 'mock-engine',
        viewport: { width: 1920, height: 1080 },
      };

      // This would verify that viewport is passed to engine.createSession
      const response = await coordinator.create(request, mockEngine);

      expect(response.sessionId).toBeDefined();
    });

    it('should pass locale options to engine', async () => {
      const request: SessionRequest = {
        engine: 'mock-engine',
        locale: 'en-US',
      };

      const response = await coordinator.create(request, mockEngine);

      expect(response.sessionId).toBeDefined();
    });

    it('should include engine capabilities in response', async () => {
      const request: SessionRequest = { engine: 'mock-engine' };

      const response = await coordinator.create(request, mockEngine);

      expect(response.engine).toBeDefined();
      expect(response.engine.name).toBe('mock-engine');
      expect(response.engine.version).toBe('1.0.0');
      expect(response.engine.capabilities).toBeDefined();
    });

    it('should forward timezone, egress policy, service-worker opt-out and snapshot budget to the engine', async () => {
      // Each optional session-create field rides through to the engine
      // untouched; dropping any of them would silently change engine behavior
      // (locale-style regressions happened before with `cookies`).
      const requestPolicy: RequestPolicy = {
        checkRequest: async () => {},
      };
      const downloadPolicy = { allow: false, maxBytes: 0 };

      await coordinator.create(
        {
          engine: 'mock-engine',
          timezoneId: 'Europe/Berlin',
          requestPolicy,
          downloadPolicy,
          allowServiceWorkers: true,
          snapshotTimeoutMs: 20000,
        },
        mockEngine
      );

      expect(mockEngine.lastOptions).toMatchObject({
        timezoneId: 'Europe/Berlin',
        requestPolicy,
        downloadPolicy,
        allowServiceWorkers: true,
        snapshotTimeoutMs: 20000,
      });
    });

    it('should record the owning tenant on the session metadata when the request carries one', async () => {
      await coordinator.create(
        { engine: 'mock-engine', tenantId: 'tenant-a' } as SessionRequest,
        mockEngine
      );

      expect(coordinator.getAllSessions()).toHaveLength(1);
      expect(coordinator.getAllSessions()[0]?.tenantId).toBe('tenant-a');
    });

    it('should omit the tenant field when the request does not carry one', async () => {
      await coordinator.create({ engine: 'mock-engine' }, mockEngine);

      expect(coordinator.getAllSessions()[0]?.tenantId).toBeUndefined();
    });

    it('should omit passthrough options the request does not set', async () => {
      await coordinator.create({ engine: 'mock-engine' }, mockEngine);

      expect(mockEngine.lastOptions).toMatchObject({
        headless: true,
      });
      expect(mockEngine.lastOptions?.timezoneId).toBeUndefined();
      expect(mockEngine.lastOptions?.requestPolicy).toBeUndefined();
      expect(mockEngine.lastOptions?.allowServiceWorkers).toBeUndefined();
      expect(mockEngine.lastOptions?.snapshotTimeoutMs).toBeUndefined();
    });
  });

  describe('cookie export', () => {
    it('should return the engine session cookies for an existing session', async () => {
      const created = await coordinator.create({ engine: 'mock-engine' }, mockEngine);
      const context = coordinator.get(created.sessionId);
      const engineCookies = [
        {
          name: 'session',
          value: 'secret-value',
          domain: 'app.example.com',
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'Lax' as const,
        },
      ];
      vi.spyOn(context?.engineSession as MockEngineSession, 'cookies').mockResolvedValue(
        engineCookies
      );

      await expect(coordinator.cookies(created.sessionId)).resolves.toEqual(engineCookies);
    });

    it('should reject a cookie export for an unknown session', async () => {
      await expect(coordinator.cookies('ses_missing')).rejects.toThrow('SESSION_NOT_FOUND');
    });
  });

  describe('engine failure handling', () => {
    it('should mark the session ENGINE_CRASHED and rethrow when the engine close fails', async () => {
      const created = await coordinator.create({ engine: 'mock-engine' }, mockEngine);
      const context = coordinator.get(created.sessionId);
      vi.spyOn(context?.engineSession as MockEngineSession, 'close').mockRejectedValue(
        new Error('transport died')
      );

      await expect(coordinator.close(created.sessionId)).rejects.toThrow('transport died');
      expect(context?.state).toBe(SessionState.ENGINE_CRASHED);
      // A failed close keeps the (crashed) entry tracked rather than silently
      // dropping the session from coordination.
      expect(coordinator.getSessionCount()).toBe(1);
    });

    it('should terminate without surfacing an engine close failure', async () => {
      const created = await coordinator.create({ engine: 'mock-engine' }, mockEngine);
      const context = coordinator.get(created.sessionId);
      vi.spyOn(context?.engineSession as MockEngineSession, 'close').mockRejectedValue(
        new Error('engine already dead')
      );

      // A dead engine must not block abnormal cleanup.
      await expect(
        coordinator.terminate(created.sessionId, SessionState.POLICY_TERMINATED, 'egress violation')
      ).resolves.toBeUndefined();
      expect(coordinator.get(created.sessionId)).toBeUndefined();
      // Non-crash terminations cancel consumers with the generic reason code.
      expect(context?.signal.reason).toMatchObject({ code: 'SESSION_NOT_FOUND' });
    });

    it('should cancel consumers with ENGINE_CRASHED when terminating for a crash', async () => {
      const created = await coordinator.create({ engine: 'mock-engine' }, mockEngine);
      const context = coordinator.get(created.sessionId);

      await coordinator.terminate(created.sessionId, SessionState.ENGINE_CRASHED, 'renderer gone');

      expect(context?.signal.reason).toMatchObject({ code: 'ENGINE_CRASHED' });
    });

    it('should expire an idle session even while its ttl is still in the future', async () => {
      const idleCoordinator = new SessionCoordinator({ cleanupCheckIntervalMs: 3_600_000 });
      const created = await idleCoordinator.create(
        { engine: 'mock-engine', ttlMs: 3_600_000, idleTimeoutMs: 30 },
        mockEngine
      );
      const context = idleCoordinator.get(created.sessionId);

      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(idleCoordinator.get(created.sessionId)).toBeUndefined();
      expect(context?.signal.aborted).toBe(true);
      expect(context?.signal.reason).toMatchObject({ code: 'SESSION_EXPIRED' });
      await idleCoordinator.shutdown();
    });
  });

  describe('bounded terminal facts', () => {
    it.each([
      { maxSessions: 0 },
      { maxSessions: 10, maxTerminalRecords: 11 },
      { maxSessions: 2000, maxTerminalRecords: 1001 },
      { maxSessions: 1000, maxTerminalRecordsPerTenant: 101 },
      { maxSessions: 50, maxTerminalRecordsPerTenant: 51 },
      { maxSessions: 50, maxTerminalRecords: 50, maxTerminalRecordsPerTenant: 13 },
      { terminalRetentionMs: Number.MAX_SAFE_INTEGER },
    ])('rejects terminal configuration outside hard bounds: %j', (config) => {
      expect(() => new SessionCoordinator(config)).toThrow(/^Invalid /);
    });

    it('derives abnormal causes instead of accepting injected cause arguments', async () => {
      const owner = new SessionCoordinator({ now: () => 1000 });
      try {
        const created = await owner.create({}, new MockEngine());
        const terminate = owner.terminate.bind(owner) as unknown as (
          sessionId: string,
          state: SessionState,
          reason: string,
          untrustedCause: string
        ) => Promise<void>;
        await terminate(created.sessionId, SessionState.ENGINE_CRASHED, 'fixture', 'ttl_expired');
        expect(owner.inspectTerminal(created.sessionId)?.view).toMatchObject({
          closeCause: 'unknown',
          state: 'engine_crashed',
        });
      } finally {
        await owner.shutdown();
      }
    });

    it('keeps the default tenant share below a small global terminal cap', async () => {
      const owner = new SessionCoordinator({ now: () => 1000, maxSessions: 4 });
      try {
        const first = await owner.create({ tenantId: 'a' }, new MockEngine());
        await owner.close(first.sessionId);
        const second = await owner.create({ tenantId: 'a' }, new MockEngine());
        await owner.close(second.sessionId);
        const other = await owner.create({ tenantId: 'b' }, new MockEngine());
        await owner.close(other.sessionId);
        expect(owner.inspectTerminal(first.sessionId)).toBeUndefined();
        expect(owner.inspectTerminal(second.sessionId)).toBeDefined();
        expect(owner.inspectTerminal(other.sessionId)).toBeDefined();
      } finally {
        await owner.shutdown();
      }
    });

    it('classifies exact TTL and strict idle boundaries with TTL precedence', async () => {
      let now = 1000;
      const owner = new SessionCoordinator({
        now: () => now,
        cleanupCheckIntervalMs: 3_600_000,
      });
      const ttl = await owner.createOwned(
        { engine: 'mock-engine', tenantId: 'owner', ttlMs: 100, idleTimeoutMs: 100 },
        new MockEngine()
      );
      now = 1100;
      expect(owner.get(ttl.response.sessionId)).toBeUndefined();
      expect(owner.inspectTerminal(ttl.response.sessionId)).toMatchObject({
        ownerTenant: 'owner',
        view: {
          closeCause: 'ttl_expired',
          endedAt: 1100,
          state: 'expired',
          leaseRemainingMs: 0,
          lease: { sampledAt: 1100, expiresAt: 1100, idleExpiresAt: 1100 },
        },
      });

      now = 2000;
      const idle = await owner.createOwned(
        { engine: 'mock-engine', tenantId: 'owner', ttlMs: 1000, idleTimeoutMs: 100 },
        new MockEngine()
      );
      now = 2100;
      expect(owner.get(idle.response.sessionId)).toBe(idle.context);
      expect(owner.inspectTerminal(idle.response.sessionId)).toBeUndefined();
      now = 2101;
      expect(owner.get(idle.response.sessionId)).toBeUndefined();
      expect(owner.inspectTerminal(idle.response.sessionId)?.view.closeCause).toBe('idle_expired');
      await owner.shutdown();
    });

    it('records explicit and policy causes without rewriting cleanup failures', async () => {
      let now = 1000;
      const owner = new SessionCoordinator({
        now: () => now,
        cleanupCheckIntervalMs: 3_600_000,
      });
      const explicit = await owner.createOwned(
        { engine: 'mock-engine', tenantId: 'owner', ttlMs: 1000, idleTimeoutMs: 500 },
        new MockEngine()
      );
      now = 1100;
      await owner.close(explicit.response.sessionId);
      expect(owner.inspectTerminal(explicit.response.sessionId)).toMatchObject({
        ownerTenant: 'owner',
        view: {
          closeCause: 'explicit_close',
          endedAt: 1100,
          state: 'closed',
          leaseRemainingMs: 0,
          lease: { sampledAt: 1100, expiresAt: 2000, idleExpiresAt: 1500 },
        },
      });
      const explicitTerminal = owner.inspectTerminal(explicit.response.sessionId);
      expect(Object.isFrozen(explicitTerminal)).toBe(true);
      expect(Object.isFrozen(explicitTerminal?.view)).toBe(true);
      expect(Object.isFrozen(explicitTerminal?.view.lease)).toBe(true);
      expect(Object.keys(explicitTerminal?.view ?? {}).sort()).toEqual(
        ['closeCause', 'endedAt', 'lease', 'leaseRemainingMs', 'state'].sort()
      );

      now = 1200;
      const policy = await owner.createOwned(
        { engine: 'mock-engine', tenantId: 'owner', ttlMs: 1000, idleTimeoutMs: 500 },
        new MockEngine()
      );
      await owner.terminate(policy.response.sessionId, SessionState.POLICY_TERMINATED, 'fixture');
      expect(owner.inspectTerminal(policy.response.sessionId)?.view.closeCause).toBe(
        'policy_terminated'
      );
      expect(owner.inspectTerminal(policy.response.sessionId)?.view).toMatchObject({
        leaseRemainingMs: 0,
        lease: { sampledAt: 1200, expiresAt: 2200, idleExpiresAt: 1700 },
      });

      now = 1300;
      const failed = await owner.createOwned(
        { engine: 'mock-engine', tenantId: 'owner', ttlMs: 1000, idleTimeoutMs: 500 },
        new MockEngine()
      );
      vi.spyOn(failed.context.engineSession, 'close').mockRejectedValue(
        new Error('cleanup failed')
      );
      await expect(owner.close(failed.response.sessionId)).rejects.toThrow('cleanup failed');
      expect(owner.inspect(failed.response.sessionId)).toMatchObject({
        context: { terminal: { closeCause: 'explicit_close' } },
      });
      expect(owner.inspect(failed.response.sessionId)?.lease).toBeUndefined();
      expect(owner.inspectTerminal(failed.response.sessionId)).toBeUndefined();
      await owner.shutdown();
    });

    it('bounds terminal retention without refreshing it on lookup', async () => {
      let now = 1000;
      const owner = new SessionCoordinator({
        now: () => now,
        cleanupCheckIntervalMs: 3_600_000,
        terminalRetentionMs: 50,
        maxTerminalRecords: 2,
        maxTerminalRecordsPerTenant: 1,
      });
      const first = await owner.create({ engine: 'mock-engine', tenantId: 'a' }, new MockEngine());
      await owner.close(first.sessionId);
      now = 1010;
      const replacement = await owner.create(
        { engine: 'mock-engine', tenantId: 'a' },
        new MockEngine()
      );
      await owner.close(replacement.sessionId);
      expect(owner.inspectTerminal(first.sessionId)).toBeUndefined();
      expect(owner.inspectTerminal(replacement.sessionId)).toBeDefined();

      now = 1020;
      const otherTenant = await owner.create(
        { engine: 'mock-engine', tenantId: 'b' },
        new MockEngine()
      );
      await owner.close(otherTenant.sessionId);
      now = 1030;
      const thirdTenant = await owner.create(
        { engine: 'mock-engine', tenantId: 'c' },
        new MockEngine()
      );
      await owner.close(thirdTenant.sessionId);
      expect(owner.inspectTerminal(replacement.sessionId)).toBeUndefined();
      expect(owner.inspectTerminal(otherTenant.sessionId)).toBeDefined();
      expect(owner.inspectTerminal(thirdTenant.sessionId)).toBeDefined();

      now = 1079;
      expect(owner.inspectTerminal(thirdTenant.sessionId)).toBeDefined();
      now = 1080;
      expect(owner.inspectTerminal(thirdTenant.sessionId)).toBeUndefined();
      await owner.shutdown();
    });

    it('does not retain an invalid unbounded tenant string in a terminal record', async () => {
      const owner = new SessionCoordinator({ now: () => 1000 });
      try {
        const created = await owner.create(
          { engine: 'mock-engine', tenantId: 'x'.repeat(10_000) },
          new MockEngine()
        );
        await owner.close(created.sessionId);
        expect(owner.inspectTerminal(created.sessionId)).toEqual({
          view: expect.objectContaining({ closeCause: 'explicit_close' }),
        });
      } finally {
        await owner.shutdown();
      }
    });
  });
});

describe('SessionState Enum', () => {
  it('should have all required states', () => {
    expect(SessionState.CREATING).toBe('CREATING');
    expect(SessionState.READY).toBe('READY');
    expect(SessionState.ACTIVE).toBe('ACTIVE');
    expect(SessionState.CLOSING).toBe('CLOSING');
    expect(SessionState.CLOSED).toBe('CLOSED');
    expect(SessionState.EXPIRED).toBe('EXPIRED');
    expect(SessionState.POLICY_TERMINATED).toBe('POLICY_TERMINATED');
    expect(SessionState.ENGINE_CRASHED).toBe('ENGINE_CRASHED');
    expect(SessionState.QUOTA_TERMINATED).toBe('QUOTA_TERMINATED');
  });

  it('should have unique state values', () => {
    const values = Object.values(SessionState);
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(values.length);
  });
});

describe('authoritative active-session lease inspection', () => {
  it('samples the injected clock once, detaches snapshots, and does not keep sessions alive', async () => {
    let now = 10_000;
    const clock = vi.fn(() => now);
    const coordinator = new SessionCoordinator({ now: clock });
    try {
      const { sessionId } = await coordinator.create(
        { ttlMs: 1000, idleTimeoutMs: 100 },
        new MockEngine()
      );
      clock.mockClear();
      const first = coordinator.inspect(sessionId)!;
      expect(clock).toHaveBeenCalledTimes(1);
      expect(first.lease).toEqual({
        sampledAt: 10_000,
        expiresAt: 11_000,
        lastActivityAt: 10_000,
        idleExpiresAt: 10_100,
      });
      expect(Object.isFrozen(first.lease)).toBe(true);
      now = 10_100;
      expect(coordinator.inspect(sessionId)?.lease.lastActivityAt).toBe(10_000);
      now++;
      expect(coordinator.inspect(sessionId)).toBeUndefined();
      expect(first.context.signal.aborted).toBe(true);
      expect(first.lease.sampledAt).toBe(10_000);
    } finally {
      await coordinator.shutdown();
    }
  });

  it('refreshes only activity and expires at the exact absolute TTL boundary', async () => {
    let now = 10_000;
    const coordinator = new SessionCoordinator({ now: () => now });
    try {
      const { sessionId } = await coordinator.create(
        { ttlMs: 100, idleTimeoutMs: 80 },
        new MockEngine()
      );
      now = 10_050;
      coordinator.updateActivity(sessionId);
      expect(coordinator.inspect(sessionId)?.lease).toEqual({
        sampledAt: now,
        expiresAt: 10_100,
        lastActivityAt: now,
        idleExpiresAt: 10_130,
      });
      now = 10_100;
      expect(coordinator.inspect(sessionId)).toBeUndefined();
    } finally {
      await coordinator.shutdown();
    }
  });

  it('uses the same clock for timer cleanup and never inspects closed sessions', async () => {
    vi.useFakeTimers();
    let now = 10_000;
    const coordinator = new SessionCoordinator({ now: () => now, cleanupCheckIntervalMs: 50 });
    try {
      const expired = await coordinator.create(
        { ttlMs: 100, idleTimeoutMs: 500 },
        new MockEngine()
      );
      const closed = await coordinator.create({ ttlMs: 1000 }, new MockEngine());
      await coordinator.close(closed.sessionId);
      expect(coordinator.inspect(closed.sessionId)).toBeUndefined();
      now = 10_100;
      await vi.advanceTimersByTimeAsync(50);
      expect(coordinator.getAllSessions()).toEqual([]);
      expect(coordinator.inspect(expired.sessionId)).toBeUndefined();
    } finally {
      await coordinator.shutdown();
      vi.useRealTimers();
    }
  });
});

describe('lease lifecycle boundaries', () => {
  it('shares one explicit engine close across concurrent callers', async () => {
    const coordinator = new SessionCoordinator({ now: () => 1000 });
    const release = Promise.withResolvers<void>();
    try {
      const { sessionId } = await coordinator.create({}, new MockEngine());
      const close = vi
        .spyOn(coordinator.get(sessionId)!.engineSession, 'close')
        .mockImplementation(() => release.promise);
      const first = coordinator.close(sessionId, 'first');
      const second = coordinator.close(sessionId, 'second');
      expect(close).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledWith('first');
      release.resolve();
      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
      expect(coordinator.inspectTerminal(sessionId)?.view).toMatchObject({
        closeCause: 'explicit_close',
        state: 'closed',
      });
    } finally {
      release.resolve();
      await coordinator.shutdown();
    }
  });

  it('publishes the close owner before abort listeners can reenter', async () => {
    const coordinator = new SessionCoordinator({ now: () => 1000 });
    try {
      const { sessionId } = await coordinator.create({}, new MockEngine());
      const context = coordinator.get(sessionId)!;
      const close = vi.spyOn(context.engineSession, 'close');
      let reentered: Promise<void> | undefined;
      context.signal.addEventListener(
        'abort',
        () => {
          reentered = coordinator.close(sessionId, 'reentrant');
        },
        { once: true }
      );
      await coordinator.close(sessionId, 'outer');
      expect(reentered).toBeDefined();
      await reentered;
      expect(close).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledWith('outer');
    } finally {
      await coordinator.shutdown();
    }
  });

  it.each([false, true])(
    'shutdown joins a pending close and retries only after failure: %s',
    async (fails) => {
      const coordinator = new SessionCoordinator({ now: () => 1000 });
      const release = Promise.withResolvers<void>();
      const created = await coordinator.create({}, new MockEngine());
      const context = coordinator.get(created.sessionId)!;
      const close = vi.spyOn(context.engineSession, 'close').mockImplementationOnce(async () => {
        await release.promise;
        if (fails) throw new Error('first close failed');
      });
      if (fails) close.mockResolvedValueOnce(undefined);
      const closing = coordinator.close(created.sessionId);
      const observedClose = closing.then(
        () => 'resolved' as const,
        () => 'rejected' as const
      );
      let shutdownSettled = false;
      const shutdown = coordinator.shutdown().then(() => {
        shutdownSettled = true;
      });
      await Promise.resolve();
      expect(shutdownSettled).toBe(false);
      release.resolve();
      await shutdown;
      expect(await observedClose).toBe(fails ? 'rejected' : 'resolved');
      expect(close).toHaveBeenCalledTimes(fails ? 2 : 1);
      expect(coordinator.getSessionCount()).toBe(0);
    }
  );

  it('preserves a closing view without a lease and expiration cannot close it twice', async () => {
    let now = 1000;
    const coordinator = new SessionCoordinator({ now: () => now });
    let release!: () => void;
    try {
      const { sessionId } = await coordinator.create({ ttlMs: 100 }, new MockEngine());
      const context = coordinator.get(sessionId)!;
      const close = vi.spyOn(context.engineSession, 'close').mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      );
      const closing = coordinator.close(sessionId);
      expect(coordinator.inspect(sessionId)?.context.state).toBe(SessionState.CLOSING);
      expect(coordinator.inspect(sessionId)).not.toHaveProperty('lease');
      now = 1100;
      expect(coordinator.inspect(sessionId)).toBeUndefined();
      expect(close).toHaveBeenCalledTimes(1);
      expect(coordinator.inspectTerminal(sessionId)?.view).toMatchObject({
        closeCause: 'explicit_close',
        state: 'closed',
        leaseRemainingMs: 0,
      });
      release();
      await closing;
      expect(coordinator.inspectTerminal(sessionId)?.view.state).toBe('closed');
    } finally {
      release?.();
      await coordinator.shutdown();
    }
  });

  it('retains failed-close status without advertising an active lease', async () => {
    const coordinator = new SessionCoordinator({ now: () => 1000 });
    try {
      const { sessionId } = await coordinator.create({}, new MockEngine());
      vi.spyOn(coordinator.get(sessionId)!.engineSession, 'close').mockRejectedValueOnce(
        new Error('failed')
      );
      await expect(coordinator.close(sessionId)).rejects.toThrow('failed');
      expect(coordinator.inspect(sessionId)?.context.state).toBe(SessionState.ENGINE_CRASHED);
      expect(coordinator.inspect(sessionId)).not.toHaveProperty('lease');
    } finally {
      await coordinator.shutdown();
    }
  });

  it('samples an entire scoped list once and expires sessions through the same owner', async () => {
    let now = 1000;
    const clock = vi.fn(() => now);
    const coordinator = new SessionCoordinator({ now: clock });
    try {
      const a = await coordinator.create({ tenantId: 'a', ttlMs: 100 }, new MockEngine());
      await coordinator.create({ tenantId: 'b' }, new MockEngine());
      const close = vi.spyOn(coordinator.get(a.sessionId)!.engineSession, 'close');
      clock.mockClear();
      expect(coordinator.inspectAll('a').map((view) => view.context.id)).toEqual([a.sessionId]);
      expect(clock).toHaveBeenCalledTimes(1);
      now = 1100;
      expect(coordinator.inspectAll('a')).toEqual([]);
      expect(coordinator.inspect(a.sessionId)).toBeUndefined();
      expect(close).toHaveBeenCalledTimes(1);
      expect(coordinator.inspectAll('b')).toHaveLength(1);
    } finally {
      await coordinator.shutdown();
    }
  });
});

it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'refuses invalid clock %s without leaking an allocated engine session',
  async (now) => {
    const coordinator = new SessionCoordinator({ now: () => now });
    const engine = new MockEngine();
    const engineSession = new MockEngineSession();
    vi.spyOn(engine, 'createSession').mockResolvedValue(engineSession);
    try {
      await expect(coordinator.create({}, engine)).rejects.toThrow('Invalid session clock');
      expect(engineSession.closed).toBe(true);
      expect(coordinator.getSessionCount()).toBe(0);
    } finally {
      await coordinator.shutdown();
    }
  }
);

it('does not let terminal diagnostic clock failure block explicit teardown', async () => {
  let now = 1000;
  const coordinator = new SessionCoordinator({ now: () => now });
  const engineSession = new MockEngineSession();
  const engine = new MockEngine();
  vi.spyOn(engine, 'createSession').mockResolvedValue(engineSession);
  try {
    const { sessionId } = await coordinator.create({}, engine);
    now = Number.NaN;
    await expect(coordinator.close(sessionId)).resolves.toBeUndefined();
    expect(engineSession.closed).toBe(true);
    expect(coordinator.getSessionCount()).toBe(0);
  } finally {
    await coordinator.shutdown();
  }
});

it('refuses unsafe lifetime addition without leaking an allocated engine session', async () => {
  const coordinator = new SessionCoordinator({ now: () => 1000 });
  const engine = new MockEngine();
  const engineSession = new MockEngineSession();
  vi.spyOn(engine, 'createSession').mockResolvedValue(engineSession);
  try {
    await expect(coordinator.create({ ttlMs: Number.MAX_SAFE_INTEGER }, engine)).rejects.toThrow(
      'Invalid session lifetime'
    );
    expect(engineSession.closed).toBe(true);
    expect(coordinator.getSessionCount()).toBe(0);
  } finally {
    await coordinator.shutdown();
  }
});

it('retries settled failed-close cleanup at expiry without overlapping teardown', async () => {
  let now = 1000;
  const coordinator = new SessionCoordinator({ now: () => now });
  try {
    const { sessionId } = await coordinator.create({ ttlMs: 100 }, new MockEngine());
    const close = vi
      .spyOn(coordinator.get(sessionId)!.engineSession, 'close')
      .mockRejectedValueOnce(new Error('failed'))
      .mockResolvedValue(undefined);
    await expect(coordinator.close(sessionId)).rejects.toThrow('failed');
    now = 1100;
    expect(coordinator.inspect(sessionId)).toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenLastCalledWith('expired');
  } finally {
    await coordinator.shutdown();
  }
});

it('does not discard a replacement when an old close settles', async () => {
  const coordinator = new SessionCoordinator({ now: () => 1000 });
  vi.spyOn(coordinator as unknown as { generateSessionId(): string }, 'generateSessionId')
    .mockReturnValueOnce('same-id')
    .mockReturnValueOnce('same-id')
    .mockReturnValueOnce('replacement-id');
  let release!: () => void;
  try {
    await coordinator.create({}, new MockEngine());
    const original = coordinator.captureForCleanup('same-id')!;
    vi.spyOn(original.engineSession, 'close').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const closing = coordinator.close('same-id');
    const createdReplacement = await coordinator.create({}, new MockEngine());
    expect(createdReplacement.sessionId).toBe('replacement-id');
    expect(coordinator.captureForCleanup('same-id')).toBe(original);

    // Production allocation refused the collision above. Inject a same-text
    // replacement only to model a stale external callback crossing generations.
    const replacement = coordinator.captureForCleanup('replacement-id')!;
    const privateOwner = coordinator as unknown as {
      sessions: Map<string, typeof replacement & { cancellation: AbortController }>;
    };
    privateOwner.sessions.delete('replacement-id');
    replacement.id = 'same-id';
    replacement.metadata.id = 'same-id';
    privateOwner.sessions.set(
      'same-id',
      replacement as typeof replacement & { cancellation: AbortController }
    );

    expect(replacement).not.toBe(original);
    expect(await coordinator.discardIfCurrent(original, 'creation_failed')).toBe(false);
    expect(
      await coordinator.terminateIfCurrent(original, SessionState.ENGINE_CRASHED, 'stale crash')
    ).toBe(false);
    expect(coordinator.captureForCleanup('same-id')).toBe(replacement);
    expect(coordinator.inspectTerminal('same-id')).toBeUndefined();
    release();
    await closing;
    expect(coordinator.captureForCleanup('same-id')).toBe(replacement);
    expect(replacement.signal.aborted).toBe(false);
  } finally {
    release?.();
    await coordinator.shutdown();
  }
});

it('refuses bounded session ID exhaustion without overwriting a live allocation', async () => {
  const coordinator = new SessionCoordinator({ now: () => 1000 });
  vi.spyOn(
    coordinator as unknown as { generateSessionId(): string },
    'generateSessionId'
  ).mockReturnValue('same-id');
  const engine = new MockEngine();
  const allocate = vi.spyOn(engine, 'createSession');
  try {
    await coordinator.create({}, engine);
    const original = coordinator.captureForCleanup('same-id');
    await expect(coordinator.create({}, engine)).rejects.toThrow('SESSION_ID_EXHAUSTED');
    expect(coordinator.captureForCleanup('same-id')).toBe(original);
    expect(allocate).toHaveBeenCalledTimes(1);
  } finally {
    await coordinator.shutdown();
  }
});

it('reserves generated IDs across concurrent engine allocation', async () => {
  const coordinator = new SessionCoordinator({ now: () => 1000 });
  vi.spyOn(coordinator as unknown as { generateSessionId(): string }, 'generateSessionId')
    .mockReturnValueOnce('same-id')
    .mockReturnValueOnce('same-id')
    .mockReturnValueOnce('other-id');
  const engine = new MockEngine();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let allocations = 0;
  vi.spyOn(engine, 'createSession').mockImplementation(async () => {
    allocations++;
    if (allocations === 2) entered.resolve();
    await release.promise;
    return new MockEngineSession();
  });
  try {
    const first = coordinator.create({}, engine);
    const second = coordinator.create({}, engine);
    await entered.promise;
    release.resolve();
    const created = await Promise.all([first, second]);
    expect(created.map(({ sessionId }) => sessionId).sort()).toEqual(['other-id', 'same-id']);
    expect(coordinator.getSessionCount()).toBe(2);
    expect(allocations).toBe(2);
  } finally {
    release.resolve();
    await coordinator.shutdown();
  }
});

it('releases a failed allocation reservation for later reuse', async () => {
  const coordinator = new SessionCoordinator({ now: () => 1000 });
  vi.spyOn(
    coordinator as unknown as { generateSessionId(): string },
    'generateSessionId'
  ).mockReturnValue('same-id');
  const failed = new MockEngine();
  vi.spyOn(failed, 'createSession').mockRejectedValue(new Error('allocation failed'));
  try {
    await expect(coordinator.create({}, failed)).rejects.toThrow('allocation failed');
    const created = await coordinator.create({}, new MockEngine());
    expect(created.sessionId).toBe('same-id');
    expect(coordinator.getSessionCount()).toBe(1);
  } finally {
    await coordinator.shutdown();
  }
});

it('discards a current allocation without duplicating its pending close', async () => {
  const coordinator = new SessionCoordinator({ now: () => 1000 });
  let release!: () => void;
  try {
    const { sessionId } = await coordinator.create({}, new MockEngine());
    const original = coordinator.captureForCleanup(sessionId)!;
    const close = vi.spyOn(original.engineSession, 'close').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const closing = coordinator.close(sessionId);
    const discarded = coordinator.discardIfCurrent(original, 'creation_failed');
    expect(close).toHaveBeenCalledTimes(1);
    release();
    await closing;
    expect(await discarded).toBe(true);
    expect(coordinator.captureForCleanup(sessionId)).toBeUndefined();
  } finally {
    release?.();
    await coordinator.shutdown();
  }
});
