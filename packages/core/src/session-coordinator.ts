/**
 * Session Coordinator - Manages session lifecycle and state
 *
 * Following TDD principles, this implements session lifecycle management
 * with comprehensive state tracking and cleanup verification.
 */

import { type BrowserEngine, EngineError } from '@agentbrowser/engine';
import type { SessionRequest, SessionResponse } from '@agentbrowser/protocol';
import {
  type SessionCloseCause,
  type SessionDiagnostics,
  type SessionLease,
  type SessionTerminalView,
  captureSessionDiagnostics,
} from '@agentbrowser/protocol';
import type { StructuredLogger } from './logger.js';

const MAX_SESSION_TIME = 8_640_000_000_000_000;
const MAX_TERMINAL_RETENTION_MS = Number.MAX_SAFE_INTEGER - MAX_SESSION_TIME;

type ProducedSessionCloseCause = Exclude<SessionCloseCause, 'engine_crash'>;

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
  /** Bounded, ephemeral post-close diagnostic retention. */
  terminalRetentionMs?: number;
  maxTerminalRecords?: number;
  maxTerminalRecordsPerTenant?: number;
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
  private readonly pendingSessionIds = new Set<string>();
  private readonly terminalSessions = new Map<string, TerminalSessionRecord>();
  private readonly pendingCloses = new WeakMap<SessionContext, Promise<void>>();
  private config: Required<Omit<CoordinatorConfig, 'logger' | 'now'>>;
  private readonly logger: StructuredLogger | undefined;
  private cleanupTimer?: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(config: CoordinatorConfig = {}) {
    const maxSessions = config.maxSessions ?? 1000;
    const maxTerminalRecords = config.maxTerminalRecords ?? Math.min(maxSessions, 1000);
    const tenantTerminalCeiling = Math.min(100, Math.max(1, Math.floor(maxTerminalRecords / 4)));
    this.config = {
      maxSessions,
      // 3.5 hours: spans a real working block (morning→lunch, lunch→evening)
      // across long multi-step forms that keep no server-side drafts, where
      // expiry means full re-entry. This bounds total lifetime; unattended
      // pauses are still reaped by idleTimeoutMs, which clients must raise
      // for human-in-the-loop waits (default 10 min, per-session max 1 h).
      defaultTtlMs: config.defaultTtlMs ?? 12600000,
      defaultIdleTimeoutMs: config.defaultIdleTimeoutMs ?? 600000, // 10 minutes
      cleanupCheckIntervalMs: config.cleanupCheckIntervalMs ?? 30000, // 30 seconds
      terminalRetentionMs: config.terminalRetentionMs ?? 300_000,
      maxTerminalRecords,
      maxTerminalRecordsPerTenant: config.maxTerminalRecordsPerTenant ?? tenantTerminalCeiling,
    };
    for (const [name, value] of Object.entries({
      maxSessions: this.config.maxSessions,
      terminalRetentionMs: this.config.terminalRetentionMs,
      maxTerminalRecords: this.config.maxTerminalRecords,
      maxTerminalRecordsPerTenant: this.config.maxTerminalRecordsPerTenant,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
    }
    if (this.config.terminalRetentionMs > MAX_TERMINAL_RETENTION_MS)
      throw new Error('Invalid terminalRetentionMs');
    if (this.config.maxTerminalRecords > Math.min(this.config.maxSessions, 1000))
      throw new Error('Invalid maxTerminalRecords');
    if (this.config.maxTerminalRecordsPerTenant > tenantTerminalCeiling)
      throw new Error('Invalid maxTerminalRecordsPerTenant');
    this.logger = config.logger;
    const clock = config.now ?? (() => Date.now());
    this.now = () => {
      const value = clock();
      if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SESSION_TIME)
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
    if (this.sessions.size + this.pendingSessionIds.size >= this.config.maxSessions) {
      throw new Error('QUOTA_EXCEEDED: Maximum session limit reached');
    }

    // Refuse to overwrite any live allocation. Captured context identity still
    // fences asynchronous callbacks after a textual ID is legitimately reused.
    let sessionId = '';
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = this.generateSessionId();
      if (!this.sessions.has(candidate) && !this.pendingSessionIds.has(candidate)) {
        sessionId = candidate;
        break;
      }
    }
    if (!sessionId) throw new Error('SESSION_ID_EXHAUSTED');
    this.pendingSessionIds.add(sessionId);

    try {
      // Create engine session
      const sessionOptions: import('@agentbrowser/engine').EngineSessionOptions = {};
      if (request.cdpAttach === true) sessionOptions.cdpAttach = true;
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
      } else if (request.cdpAttach !== true) {
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

      // Reservation should make this impossible for production creators. Keep
      // the store boundary fail-closed against any other internal writer.
      if (this.sessions.has(sessionId)) {
        await engineSession.close('session_id_collision').catch(() => {});
        throw new Error('SESSION_ID_COLLISION');
      }
      // Capture the persistent signal once. Listener lifetime follows the
      // existing allocation cancellation owner, never the retained record.
      let lifecycleFailure: EngineError | undefined;
      try {
        const disconnected = engineSession.disconnected;
        if (disconnected !== undefined) {
          const onDisconnected = () => {
            void this.terminateDisconnectedIfCurrent(session);
          };
          const remove = () => disconnected.removeEventListener('abort', onDisconnected);
          session.signal.addEventListener('abort', remove, { once: true });
          disconnected.addEventListener('abort', onDisconnected, { once: true });
          // addEventListener does not replay an earlier abort. There is no
          // await between this check and live-map publication below.
          if (disconnected.aborted)
            lifecycleFailure = new EngineError('ENGINE_CRASHED', 'Engine session disconnected');
        }
      } catch {
        lifecycleFailure = new EngineError('ENGINE_CRASHED', 'Engine lifecycle signal unavailable');
      }
      if (lifecycleFailure) {
        session.cancellation.abort(lifecycleFailure);
        await engineSession.close('lifecycle_unavailable').catch(() => {});
        throw lifecycleFailure;
      }
      this.terminalSessions.delete(sessionId);
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
    } finally {
      this.pendingSessionIds.delete(sessionId);
    }
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
    const current = this.sessions.get(context.id);
    if (current !== context) return false;
    await this.terminateContext(current, SessionState.CLOSED, reason, 'unknown', false);
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
    return {
      context,
      lease: this.leaseAt(context, sampledAt),
    };
  }

  private getAt(sessionId: string, now: number): SessionContext | undefined {
    const session = this.sessions.get(sessionId);
    const cause = session ? this.expirationCauseAt(session, now) : undefined;
    if (session && cause) {
      this.expire(session, cause, now, false);
      return undefined;
    }
    return session;
  }

  /** Bounded terminal lookup; it does not refresh retention or session activity. */
  inspectTerminal(sessionId: string): SessionTerminalInspection | undefined {
    const now = this.now();
    this.pruneTerminal(now);
    const record = this.terminalSessions.get(sessionId);
    if (!record || now >= record.retainUntil) return undefined;
    return Object.freeze({
      ...(record.ownerTenant !== undefined ? { ownerTenant: record.ownerTenant } : {}),
      view: record.view,
    });
  }

  /** Remove before cancellation callbacks; the original close owner keeps pending teardown. */
  private expire(
    session: SessionContext & { cancellation: AbortController },
    cause: 'ttl_expired' | 'idle_expired',
    endedAt: number,
    logFailure: boolean
  ): void {
    if (this.sessions.get(session.id) !== session) return;
    const alreadyClosing = session.state === SessionState.CLOSING;
    this.captureTerminal(session, cause, endedAt);
    this.setState(session, SessionState.EXPIRED);
    this.sessions.delete(session.id);
    this.recordTerminal(session);
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

    const pending = this.pendingCloses.get(session);
    if (pending) return pending;
    let resolveOwner!: () => void;
    let rejectOwner!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveOwner = resolve;
      rejectOwner = reject;
    });
    this.pendingCloses.set(session, completion);
    this.closeContext(session, reason).then(resolveOwner, rejectOwner);
    try {
      await completion;
    } finally {
      if (this.pendingCloses.get(session) === completion) this.pendingCloses.delete(session);
    }
  }

  private async closeContext(
    session: SessionContext & { cancellation: AbortController },
    reason?: string
  ): Promise<void> {
    // Terminal diagnostics never block teardown when a trusted clock fails.
    try {
      this.captureTerminal(session, 'explicit_close', this.now());
    } catch {
      // Continue cancellation and engine cleanup without inventing a timestamp.
    }

    // Mark as closing
    this.setState(session, SessionState.CLOSING);
    session.cancellation.abort(new EngineError('SESSION_NOT_FOUND', 'Session closed'));

    try {
      // Close engine session
      await session.engineSession.close(reason);

      // Remove from tracking
      const current = this.sessions.get(session.id) === session;
      if (current) this.sessions.delete(session.id);

      // Update state
      this.setState(session, SessionState.CLOSED);
      if (current) this.recordTerminal(session);
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

    await this.terminateContext(session, state, reason, abnormalCloseCause(state), true);
  }

  /** Terminate only the captured allocation, never a later session that reuses its text ID. */
  async terminateIfCurrent(
    session: SessionContext,
    state: SessionState,
    reason: string
  ): Promise<boolean> {
    const current = this.sessions.get(session.id);
    if (current !== session) return false;
    await this.terminateContext(current, state, reason, abnormalCloseCause(state), true);
    return true;
  }

  /** Only the captured adapter signal can produce this observed cause. */
  private async terminateDisconnectedIfCurrent(context: SessionContext): Promise<void> {
    const current = this.sessions.get(context.id);
    if (current !== context) return;
    await this.terminateContext(
      current,
      SessionState.ENGINE_CRASHED,
      'engine_disconnected',
      'engine_disconnected',
      true
    );
  }

  private async terminateContext(
    session: SessionContext & { cancellation: AbortController },
    state: SessionState,
    reason: string,
    closeCause: ProducedSessionCloseCause,
    retain: boolean
  ): Promise<void> {
    if (this.sessions.get(session.id) !== session) return;

    const alreadyClosing = session.state === SessionState.CLOSING;
    if (retain) {
      try {
        this.captureTerminal(session, closeCause, this.now());
      } catch {
        // Teardown remains authoritative even when diagnostic sampling fails.
      }
    }
    this.setState(session, state);
    this.sessions.delete(session.id);
    if (retain) this.recordTerminal(session);
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
    const closePromises = Array.from(this.sessions.values()).map(async (context) => {
      const pending = this.pendingCloses.get(context);
      if (pending) await pending.catch(() => undefined);
      if (this.sessions.get(context.id) !== context) return;
      await this.terminateContext(
        context,
        SessionState.CLOSED,
        'coordinator_shutdown',
        'unknown',
        false
      );
    });

    await Promise.allSettled(closePromises);
    this.terminalSessions.clear();
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
      const cause = this.expirationCauseAt(session, now);
      if (cause) this.expire(session, cause, now, true);
    }
    this.pruneTerminal(now);
  }

  /** Keep live context and listed metadata consistent before cancellation callbacks run. */
  private setState(session: SessionContext, state: SessionState): void {
    session.state = state;
    session.metadata.state = state;
  }

  /**
   * Check if session is expired
   */
  private expirationCauseAt(
    session: SessionContext,
    now: number
  ): 'ttl_expired' | 'idle_expired' | undefined {
    // Check TTL expiration
    if (session.metadata.expiresAt <= now) {
      return 'ttl_expired';
    }

    // Check idle timeout
    const idleTime = now - session.metadata.lastActivityAt;
    if (idleTime > session.metadata.idleTimeoutMs) {
      return 'idle_expired';
    }

    return undefined;
  }

  private leaseAt(session: SessionContext, sampledAt: number): SessionLease {
    const { expiresAt, lastActivityAt, idleTimeoutMs } = session.metadata;
    const idleExpiresAt = lastActivityAt + idleTimeoutMs;
    if (
      ![sampledAt, expiresAt, lastActivityAt, idleExpiresAt].every(
        (value) => Number.isSafeInteger(value) && value >= 0
      )
    )
      throw new Error('Invalid session lifetime');
    return Object.freeze({ sampledAt, expiresAt, lastActivityAt, idleExpiresAt });
  }

  private captureTerminal(
    session: SessionContext,
    closeCause: ProducedSessionCloseCause,
    endedAt: number
  ): void {
    if (session.terminal !== undefined) return;
    session.terminal = Object.freeze({
      closeCause,
      endedAt,
      lease: this.leaseAt(session, endedAt),
    });
  }

  private recordTerminal(session: SessionContext): void {
    const terminal = session.terminal;
    if (!terminal) return;
    const terminalState = terminalStateOf(session.state, terminal.closeCause);
    if (!terminalState) return;
    const retainUntil = terminal.endedAt + this.config.terminalRetentionMs;
    if (!Number.isSafeInteger(retainUntil)) return;
    this.pruneTerminal(terminal.endedAt);
    const view: SessionTerminalView = Object.freeze({
      closeCause: terminal.closeCause,
      endedAt: terminal.endedAt,
      state: terminalState,
      leaseRemainingMs: 0,
      lease: terminal.lease,
    });
    const ownerTenant = boundedTerminalTenant(session.metadata.tenantId);
    this.terminalSessions.delete(session.id);
    this.terminalSessions.set(
      session.id,
      Object.freeze({
        sessionId: session.id,
        ...(ownerTenant !== undefined ? { ownerTenant } : {}),
        retainUntil,
        view,
      })
    );
    this.enforceTerminalCaps(ownerTenant);
  }

  private pruneTerminal(now: number): void {
    for (const [id, record] of this.terminalSessions) {
      if (now >= record.retainUntil) this.terminalSessions.delete(id);
    }
  }

  private enforceTerminalCaps(ownerTenant: string | undefined): void {
    const sameTenant = [...this.terminalSessions.entries()].filter(
      ([, record]) => record.ownerTenant === ownerTenant
    );
    while (sameTenant.length > this.config.maxTerminalRecordsPerTenant) {
      const oldest = sameTenant.shift();
      if (oldest) this.terminalSessions.delete(oldest[0]);
    }
    while (this.terminalSessions.size > this.config.maxTerminalRecords) {
      const oldest = this.terminalSessions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.terminalSessions.delete(oldest);
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
  /** First terminal trigger, retained on failed-close live contexts. */
  terminal?: Readonly<{
    closeCause: ProducedSessionCloseCause;
    endedAt: number;
    lease: SessionLease;
  }>;
  /**
   * Listener ownership (D2): the coordinator owns only the typed session
   * disconnect listener, removed by this allocation's cancellation signal.
   * Page-event listeners belong to their consumers (e.g. the API per-page
   * pump), which must bind cleanup to page/session teardown.
   */
}

interface TerminalSessionRecord {
  readonly sessionId: string;
  readonly ownerTenant?: string;
  readonly retainUntil: number;
  readonly view: SessionTerminalView;
}

export interface SessionTerminalInspection {
  readonly ownerTenant?: string;
  readonly view: SessionTerminalView;
}

function terminalStateOf(
  state: SessionState,
  closeCause: ProducedSessionCloseCause
): SessionTerminalView['state'] | undefined {
  if (closeCause === 'explicit_close') return 'closed';
  if (closeCause === 'ttl_expired' || closeCause === 'idle_expired') return 'expired';
  if (closeCause === 'policy_terminated') return 'policy_terminated';
  if (closeCause === 'engine_disconnected') return 'engine_disconnected';
  switch (state) {
    case SessionState.CLOSED:
      return 'closed';
    case SessionState.EXPIRED:
      return 'expired';
    case SessionState.POLICY_TERMINATED:
      return 'policy_terminated';
    case SessionState.ENGINE_CRASHED:
      return 'engine_crashed';
    case SessionState.QUOTA_TERMINATED:
      return 'quota_terminated';
    default:
      return undefined;
  }
}

function boundedTerminalTenant(value: string | undefined): string | undefined {
  return value !== undefined && value.length >= 1 && value.length <= 64 ? value : undefined;
}

function abnormalCloseCause(state: SessionState): ProducedSessionCloseCause {
  return state === SessionState.POLICY_TERMINATED ? 'policy_terminated' : 'unknown';
}
