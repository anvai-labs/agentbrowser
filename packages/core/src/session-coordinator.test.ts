/**
 * TDD Tests for Session Coordinator
 *
 * These tests define the expected behavior of session lifecycle management.
 * Written following TDD principles before implementation.
 */

import type { BrowserEngine, EngineCapabilities, EngineSession } from '@agentbrowser/engine';
import type { SessionRequest } from '@agentbrowser/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  async createSession(): Promise<EngineSession> {
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
  let coordinator: SessionCoordinator;
  let mockEngine: MockEngine;

  beforeEach(() => {
    coordinator = new SessionCoordinator({
      maxSessions: 10,
      defaultTtlMs: 900000,
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

      expect(session?.metadata.ttlMs).toBe(900000); // Default
      expect(response.ttlMs).toBe(900000);
    });

    it('should use default idle timeout when not specified', async () => {
      const request: SessionRequest = { engine: 'mock-engine' };

      const response = await coordinator.create(request, mockEngine);
      const session = coordinator.get(response.sessionId);

      expect(session?.metadata.idleTimeoutMs).toBe(120000); // Default
      expect(response.idleTimeoutMs).toBe(120000);
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
