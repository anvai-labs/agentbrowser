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
      release();
      await closing;
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
  vi.spyOn(
    coordinator as unknown as { generateSessionId(): string },
    'generateSessionId'
  ).mockReturnValue('same-id');
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
    await coordinator.create({}, new MockEngine());
    const replacement = coordinator.captureForCleanup('same-id')!;
    expect(replacement).not.toBe(original);
    expect(await coordinator.discardIfCurrent(original, 'creation_failed')).toBe(false);
    release();
    await closing;
    expect(coordinator.captureForCleanup('same-id')).toBe(replacement);
    expect(replacement.signal.aborted).toBe(false);
  } finally {
    release?.();
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
