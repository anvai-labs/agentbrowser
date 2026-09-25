/**
 * Session Coordinator - Manages session lifecycle and state
 *
 * Following TDD principles, this implements session lifecycle management
 * with comprehensive state tracking and cleanup verification.
 */

import { type BrowserEngine, EngineError } from '@agentbrowser/engine';
import type { SessionRequest, SessionResponse } from '@agentbrowser/protocol';
import {
  type SessionDiagnostics,
  type SessionLease,
  captureSessionDiagnostics,
} from '@agentbrowser/protocol';
import type { StructuredLogger } from './logger.js';

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
  /** Owning tenant, for scoping and per-tenant quotas. */
  tenantId?: string;
}

/**
 * Session coordinator configuration
 */
export interface CoordinatorConfig {
  /** Trusted lifetime clock; shared by expiration and sampled inspection. */
  now?: () => number;
  maxSessions?: number;
  defaultTtlMs?: number;
  defaultIdleTimeoutMs?: number;
  cleanupCheckIntervalMs?: number;
  /**
   * Structured log for the background cleanup path (hygiene G2): absent
   * means silent-if-uninjected, matching the service's own convention for
   * optional telemetry - there is deliberately no console fallback. Kept
   * out of the `Required<CoordinatorConfig>` defaulting below (optional
   * telemetry, not a defaultable numeric setting).
   */
  logger?: StructuredLogger;
}

/**
 * Session coordinator
 *
 * Manages session lifecycle, state transitions, and cleanup.
 */
export class SessionCoordinator {
  private sessions = new Map<string, SessionContext & { cancellation: AbortController }>();
  private config: Required<Omit<CoordinatorConfig, 'logger' | 'now'>>;
  private readonly logger: StructuredLogger | undefined;
  private cleanupTimer?: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(config: CoordinatorConfig = {}) {
    this.config = {
      maxSessions: config.maxSessions ?? 1000,
      // 3.5 hours: spans a real working block (morning→lunch, lunch→evening)
      // across long multi-step forms that keep no server-side drafts, where
      // expiry means full re-entry. This bounds total lifetime; unattended
      // pauses are still reaped by idleTimeoutMs, which clients must raise
      // for human-in-the-loop waits (default 10 min, per-session max 1 h).
      defaultTtlMs: config.defaultTtlMs ?? 12600000,
      defaultIdleTimeoutMs: config.defaultIdleTimeoutMs ?? 600000, // 10 minutes
      cleanupCheckIntervalMs: config.cleanupCheckIntervalMs ?? 30000, // 30 seconds
    };
    this.logger = config.logger;
    const clock = config.now ?? (() => Date.now());
    this.now = () => {
      const value = clock();
      if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000)
        throw new Error('Invalid session clock');
      return value;
    };

    // Start cleanup timer
    this.startCleanupTimer();
  }

  /**
   * Create a new session
   */
  async create(
    request: CoordinatedSessionRequest,
    engine: BrowserEngine
  ): Promise<SessionResponse> {
    return (await this.createOwned(request, engine)).response;
  }

  /** Internal allocation identity travels with its response across the await boundary. */
  async createOwned(
    request: CoordinatedSessionRequest,
    engine: BrowserEngine
  ): Promise<{ response: SessionResponse; context: SessionContext }> {
    // Check session limit
    if (this.sessions.size >= this.config.maxSessions) {
      throw new Error('QUOTA_EXCEEDED: Maximum session limit reached');
    }

    // Generate session ID
    const sessionId = this.generateSessionId();

    // Create engine session
    const sessionOptions: import('@agentbrowser/engine').EngineSessionOptions = {};
    if (request.downloadPolicy !== undefined)
      sessionOptions.downloadPolicy = request.downloadPolicy;

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

    // Per-session egress policy rides through to the engine untouched.
    if (request.requestPolicy !== undefined) {
      sessionOptions.requestPolicy = request.requestPolicy;
    }

    // ADR-019: off by default; explicit per-session opt-out of the
    // service-worker block that a request policy otherwise imposes.
    if (request.allowServiceWorkers !== undefined) {
      sessionOptions.allowServiceWorkers = request.allowServiceWorkers;
    }

    // Per-session override of the whole-page ariaSnapshot budget observe()
    // uses before degrading to a DOM-tag-only fallback; already part of
    // SessionRequest (unlike allowServiceWorkers), so no extra intersection
    // typing is needed above.
    if (request.snapshotTimeoutMs !== undefined) {
      sessionOptions.snapshotTimeoutMs = request.snapshotTimeoutMs;
    }

    // Seed cookies ride through to the engine (reuse an authenticated session).
    if (request.cookies !== undefined) {
      sessionOptions.cookies = request.cookies as NonNullable<
        import('@agentbrowser/engine').EngineSessionOptions['cookies']
      >;
    }

    const engineIdentity = Object.freeze({ name: engine.name, version: engine.version });
    // Resolve fallible adapter metadata before allocating/registering a session.
    const capabilities = await engine.capabilities();
    const engineSession = await engine.createSession(sessionOptions);
    let diagnostics: SessionDiagnostics | undefined;
    try {
      diagnostics = captureSessionDiagnostics(engineSession.diagnostics);
    } catch {
      // Optional adapter getters may throw; never surface raw adapter details.
    }

    // Calculate expiration times
    let now: number;
    const ttlMs = request.ttlMs ?? this.config.defaultTtlMs;
    const idleTimeoutMs = request.idleTimeoutMs ?? this.config.defaultIdleTimeoutMs;
    try {
      now = this.now();
      if (
        ![ttlMs, idleTimeoutMs, now + ttlMs, now + idleTimeoutMs].every(
          (value) => Number.isSafeInteger(value) && value >= 0
        )
      )
        throw new Error('Invalid session lifetime');
    } catch (error) {
      await engineSession.close('invalid_lifetime').catch(() => {});
      throw error;
    }

    // Create session context
    const cancellation = new AbortController();
    const session = {
      cancellation,
      signal: cancellation.signal,
      id: sessionId,
      state: SessionState.READY,
      engine,
      engineSession,
      engineIdentity,
      ...(diagnostics !== undefined ? { diagnostics } : {}),
      metadata: {
        id: sessionId,
        state: SessionState.READY,
        createdAt: now,
        expiresAt: now + ttlMs,
        lastActivityAt: now,
        ttlMs,
        idleTimeoutMs,
        engineName: engineIdentity.name,
        pageCount: 0,
        ...(request.tenantId !== undefined ? { tenantId: request.tenantId } : {}),
      },
    };

    // Store session
    this.sessions.set(sessionId, session);

    return {
      context: session,
      response: {
        sessionId,
        engine: { ...engineIdentity, capabilities },
        createdAt: new Date(now).toISOString(),
        ttlMs,
        idleTimeoutMs,
      },
    };
  }

  /**
   * TD-BROWSER-6: scoped cookie export (ADR-005) — the read half of the
   * credential handoff loop: log in once, then seed future sessions via the
   * create request's `cookies`.
   */
  async cookies(sessionId: string): Promise<import('@agentbrowser/engine').NormalizedCookie[]> {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error('SESSION_NOT_FOUND');
    }
    return session.engineSession.cookies();
  }

  /**
   * Get session by ID
   */
  get(sessionId: string): SessionContext | undefined {
    return this.getAt(sessionId, this.now());
  }

  /** Capture identity for trusted teardown composition only; NOT a liveness/auth read. */
  captureForCleanup(sessionId: string): SessionContext | undefined {
    return this.sessions.get(sessionId);
  }

  /** Remove only the captured allocation; terminate owns cancellation and best-effort close. */
  async discardIfCurrent(context: SessionContext, reason: string): Promise<boolean> {
    if (this.sessions.get(context.id) !== context) return false;
    await this.terminate(context.id, SessionState.CLOSED, reason);
    return true;
  }

  /** Inspect without refreshing activity; closing/failed contexts have no active lease. */
  inspect(sessionId: string): SessionInspection | undefined {
    return this.inspectAt(sessionId, this.now());
  }

  inspectAll(tenantId?: string): SessionInspection[] {
    const sampledAt = this.now();
    const result: SessionInspection[] = [];
    for (const session of this.sessions.values()) {
      if (tenantId !== undefined && session.metadata.tenantId !== tenantId) continue;
      const inspected = this.inspectAt(session.id, sampledAt);
      if (inspected) result.push(inspected);
    }
    return result;
  }

  private inspectAt(sessionId: string, sampledAt: number): SessionInspection | undefined {
    const context = this.getAt(sessionId, sampledAt);
    if (!context) return undefined;
    if (
      context.signal.aborted ||
      ![SessionState.READY, SessionState.ACTIVE].includes(context.state)
    )
      return { context };
    const { expiresAt, lastActivityAt, idleTimeoutMs } = context.metadata;
    const idleExpiresAt = lastActivityAt + idleTimeoutMs;
    if (
      ![expiresAt, lastActivityAt, idleExpiresAt].every(
        (value) => Number.isSafeInteger(value) && value >= 0
      )
    )
      throw new Error('Invalid session lifetime');
    return {
      context,
      lease: Object.freeze({ sampledAt, expiresAt, lastActivityAt, idleExpiresAt }),
    };
  }

  private getAt(sessionId: string, now: number): SessionContext | undefined {
    const session = this.sessions.get(sessionId);
    if (session && this.isSessionExpired(session, now)) {
      this.expire(session, false);
      return undefined;
    }
    return session;
  }

  /** Remove before cancellation callbacks; the original close owner keeps pending teardown. */
  private expire(
    session: SessionContext & { cancellation: AbortController },
    logFailure: boolean
  ): void {
    if (this.sessions.get(session.id) !== session) return;
    const alreadyClosing = session.state === SessionState.CLOSING;
    this.setState(session, SessionState.EXPIRED);
    this.sessions.delete(session.id);
    session.cancellation.abort(new EngineError('SESSION_EXPIRED', 'Session expired'));
    if (alreadyClosing) return;
    session.engineSession.close('expired').catch((error) => {
      if (logFailure)
        this.logger?.error('session.cleanup-close-failed', {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
    });
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
    this.setState(session, SessionState.CLOSING);
    session.cancellation.abort(new EngineError('SESSION_NOT_FOUND', 'Session closed'));

    try {
      // Close engine session
      await session.engineSession.close(reason);

      // Remove from tracking
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);

      // Update state
      this.setState(session, SessionState.CLOSED);
    } catch (error) {
      // Mark as crashed if close fails
      this.setState(session, SessionState.ENGINE_CRASHED);
      throw error;
    }
  }

  /**
   * Terminate a session abnormally (crash, policy violation). The engine
   * session is closed best-effort: a dead engine must not block cleanup.
   */
  async terminate(sessionId: string, state: SessionState, reason: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('SESSION_NOT_FOUND');
    }

    const alreadyClosing = session.state === SessionState.CLOSING;
    this.setState(session, state);
    this.sessions.delete(sessionId);
    session.cancellation.abort(
      new EngineError(
        state === SessionState.ENGINE_CRASHED ? 'ENGINE_CRASHED' : 'SESSION_NOT_FOUND',
        'Session terminated'
      )
    );

    if (alreadyClosing) return;
    try {
      await session.engineSession.close(`terminated:${reason}`);
    } catch {
      // The engine is likely the thing that died; cleanup proceeds.
    }
  }

  /**
   * Update session activity
   */
  updateActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);

    if (session) {
      const now = this.now();
      if (!Number.isSafeInteger(now + session.metadata.idleTimeoutMs))
        throw new Error('Invalid session lifetime');
      session.metadata.lastActivityAt = now;

      // Transition to ACTIVE if in READY state
      if (session.state === SessionState.READY) {
        this.setState(session, SessionState.ACTIVE);
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
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (this.isSessionExpired(session, now)) this.expire(session, true);
    }
  }

  /** Keep live context and listed metadata consistent before cancellation callbacks run. */
  private setState(session: SessionContext, state: SessionState): void {
    session.state = state;
    session.metadata.state = state;
  }

  /**
   * Check if session is expired
   */
  private isSessionExpired(session: SessionContext, now: number): boolean {
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
export type CoordinatedSessionRequest = SessionRequest & {
  requestPolicy?: import('@agentbrowser/engine').RequestPolicy;
  downloadPolicy?: import('@agentbrowser/engine').EngineSessionOptions['downloadPolicy'];
  allowServiceWorkers?: import('@agentbrowser/engine').EngineSessionOptions['allowServiceWorkers'];
};

export interface SessionInspection {
  context: SessionContext;
  lease?: SessionLease;
}

export interface SessionContext {
  readonly engineIdentity: Readonly<{ name: string; version: string }>;
  readonly diagnostics?: SessionDiagnostics;
  /** Consumer cancellation occurs synchronously before asynchronous engine teardown. */
  readonly signal: AbortSignal;
  id: string;
  state: SessionState;
  engine: BrowserEngine;
  engineSession: import('@agentbrowser/engine').EngineSession;
  metadata: SessionMetadata;
  /**
   * Listener ownership (D2): engine event listeners are attached by the
   * CONSUMER that needs them (e.g. the API service's per-page pump), not by
   * this coordinator - close() releases the session's engine resources but
   * does not (and cannot) deregister consumer-side listeners; consumers must
   * tie their listeners to the page/session teardown they observe.
   */
}
