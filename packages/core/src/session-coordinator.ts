/**
 * Session Coordinator - Manages session lifecycle and state
 *
 * Following TDD principles, this implements session lifecycle management
 * with comprehensive state tracking and cleanup verification.
 */

import type { BrowserEngine } from '@agentbrowser/engine';
import type { SessionRequest, SessionResponse } from '@agentbrowser/protocol';

/**
 * Session states
 */
export enum SessionState {
  CREATING = 'CREATING',
  READY = 'READY',
  ACTIVE = 'ACTIVE',
  CLOSING = 'CLOSING',
  CLOSED = 'CLOSED',
  EXPIRED = 'EXPIRED',
  POLICY_TERMINATED = 'POLICY_TERMINATED',
  ENGINE_CRASHED = 'ENGINE_CRASHED',
  QUOTA_TERMINATED = 'QUOTA_TERMINATED',
}

/**
 * Session metadata
 */
export interface SessionMetadata {
  id: string;
  state: SessionState;
  createdAt: number;
  expiresAt: number;
  lastActivityAt: number;
  ttlMs: number;
  idleTimeoutMs: number;
  engineName: string;
  pageCount: number;
}

/**
 * Session coordinator configuration
 */
export interface CoordinatorConfig {
  maxSessions?: number;
  defaultTtlMs?: number;
  defaultIdleTimeoutMs?: number;
  cleanupCheckIntervalMs?: number;
}

/**
 * Session coordinator
 *
 * Manages session lifecycle, state transitions, and cleanup.
 */
export class SessionCoordinator {
  private sessions: Map<string, SessionContext> = new Map();
  private config: Required<CoordinatorConfig>;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config: CoordinatorConfig = {}) {
    this.config = {
      maxSessions: config.maxSessions ?? 1000,
      defaultTtlMs: config.defaultTtlMs ?? 900000, // 15 minutes
      defaultIdleTimeoutMs: config.defaultIdleTimeoutMs ?? 120000, // 2 minutes
      cleanupCheckIntervalMs: config.cleanupCheckIntervalMs ?? 30000, // 30 seconds
    };

    // Start cleanup timer
    this.startCleanupTimer();
  }

  /**
   * Create a new session
   */
  async create(request: SessionRequest, engine: BrowserEngine): Promise<SessionResponse> {
    // Check session limit
    if (this.sessions.size >= this.config.maxSessions) {
      throw new Error('QUOTA_EXCEEDED: Maximum session limit reached');
    }

    // Generate session ID
    const sessionId = this.generateSessionId();

    // Create engine session
    const sessionOptions: import('@agentbrowser/engine').EngineSessionOptions = {};

    if (request.viewport !== undefined) {
      sessionOptions.viewport = request.viewport;
    }

    if (request.locale !== undefined) {
      sessionOptions.locale = request.locale;
    }

    if (request.timezoneId !== undefined) {
      sessionOptions.timezoneId = request.timezoneId;
    }

    if (request.headless !== undefined) {
      sessionOptions.headless = request.headless;
    } else {
      sessionOptions.headless = true;
    }

    const engineSession = await engine.createSession(sessionOptions);

    // Calculate expiration times
    const now = Date.now();
    const ttlMs = request.ttlMs ?? this.config.defaultTtlMs;
    const idleTimeoutMs = request.idleTimeoutMs ?? this.config.defaultIdleTimeoutMs;

    // Create session context
    const session: SessionContext = {
      id: sessionId,
      state: SessionState.READY,
      engine,
      engineSession,
      metadata: {
        id: sessionId,
        state: SessionState.READY,
        createdAt: now,
        expiresAt: now + ttlMs,
        lastActivityAt: now,
        ttlMs,
        idleTimeoutMs,
        engineName: engine.name,
        pageCount: 0,
      },
    };

    // Store session
    this.sessions.set(sessionId, session);

    return {
      sessionId,
      engine: {
        name: engine.name,
        version: engine.version,
        capabilities: await engine.capabilities(),
      },
      createdAt: new Date(now).toISOString(),
      ttlMs,
      idleTimeoutMs,
    };
  }

  /**
   * Get session by ID
   */
  get(sessionId: string): SessionContext | undefined {
    const session = this.sessions.get(sessionId);

    if (session) {
      // Check expiration and don't return expired sessions
      if (this.isSessionExpired(session)) {
        // Mark as expired and remove
        session.state = SessionState.EXPIRED;
        this.sessions.delete(sessionId);
        // Close engine session asynchronously without calling close()
        session.engineSession.close('expired').catch(() => {
          // Ignore close errors during expiration
        });
        return undefined;
      }
    }

    return session;
  }

  /**
   * Close session
   */
  async close(sessionId: string, reason?: string): Promise<void> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error('SESSION_NOT_FOUND');
    }

    // Mark as closing
    session.state = SessionState.CLOSING;

    try {
      // Close engine session
      await session.engineSession.close(reason);

      // Remove from tracking
      this.sessions.delete(sessionId);

      // Update state
      session.state = SessionState.CLOSED;
    } catch (error) {
      // Mark as crashed if close fails
      session.state = SessionState.ENGINE_CRASHED;
      throw error;
    }
  }

  /**
   * Update session activity
   */
  updateActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);

    if (session) {
      session.metadata.lastActivityAt = Date.now();

      // Transition to ACTIVE if in READY state
      if (session.state === SessionState.READY) {
        session.state = SessionState.ACTIVE;
      }
    }
  }

  /**
   * Get session count
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get all session metadata
   */
  getAllSessions(): SessionMetadata[] {
    return Array.from(this.sessions.values()).map((s) => s.metadata);
  }

  /**
   * Shutdown coordinator
   */
  async shutdown(): Promise<void> {
    // Stop cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    // Close all sessions
    const closePromises = Array.from(this.sessions.keys()).map((id) =>
      this.close(id, 'coordinator_shutdown')
    );

    await Promise.allSettled(closePromises);
  }

  /**
   * Start cleanup timer
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.runCleanup();
    }, this.config.cleanupCheckIntervalMs);
  }

  /**
   * Run cleanup pass
   */
  private runCleanup(): void {
    // Clean up expired sessions in a single pass
    for (const [id, session] of this.sessions.entries()) {
      if (this.isSessionExpired(session)) {
        session.state = SessionState.EXPIRED;
        // Remove from sessions map first
        this.sessions.delete(id);
        // Then close the engine session asynchronously without calling close()
        session.engineSession.close('expired').catch((error) => {
          console.error(`Failed to close expired session ${id}:`, error);
        });
      }
    }
  }

  /**
   * Check if session is expired
   */
  private isSessionExpired(session: SessionContext): boolean {
    const now = Date.now();

    // Check TTL expiration
    if (session.metadata.expiresAt <= now) {
      return true;
    }

    // Check idle timeout
    const idleTime = now - session.metadata.lastActivityAt;
    if (idleTime > session.metadata.idleTimeoutMs) {
      return true;
    }

    return false;
  }

  /**
   * Check if session is expired (legacy method for compatibility)
   */
  private checkExpiration(session: SessionContext): void {
    if (this.isSessionExpired(session)) {
      session.state = SessionState.EXPIRED;
      this.close(session.id, 'expired').catch(() => {
        // Ignore close errors during expiration
      });
    }
  }

  /**
   * Generate session ID
   */
  private generateSessionId(): string {
    // Generate UUID-like ID (simplified for MVP)
    return `ses_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

/**
 * Session context
 */
export interface SessionContext {
  id: string;
  state: SessionState;
  engine: BrowserEngine;
  engineSession: import('@agentbrowser/engine').EngineSession;
  metadata: SessionMetadata;
}
