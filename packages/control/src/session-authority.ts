import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { ControlError, type ControlTicket, SessionControl } from '@agentbrowser/core';
import type { EnginePage } from '@agentbrowser/engine';
import {
  type AgentMode,
  type ControlView,
  DEFAULT_AGENT_MODE,
  type RunCursor,
  agentModeProfile,
} from '@agentbrowser/protocol';

export type SessionPrincipal =
  | { actor: 'operator'; tenant?: string }
  | {
      actor: 'agent';
      tenant: string;
      sessionId: string;
      epoch: number;
      mode: AgentMode;
      bindingGeneration: string;
    };
type Entry = {
  control: SessionControl;
  incarnation: string;
  tenant: string;
  grant?: string | undefined;
  agent?: Extract<SessionPrincipal, { actor: 'agent' }> | undefined;
  signal: AbortSignal;
  abortListener: () => void;
  expiresAt?: number;
  onExpire?: () => void;
};
type Scope = { sessionId: string; entry: Entry; ticket: ControlTicket };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Credentials stay in the shared composition layer, separate from core state. */
export class SessionAuthority {
  private readonly entries = new Map<string, Entry>();
  private readonly grants = new Map<string, Extract<SessionPrincipal, { actor: 'agent' }>>();
  private readonly scope = new AsyncLocalStorage<Scope>();
  private readonly now: () => number;
  private readonly serviceGeneration = randomBytes(16).toString('base64url');

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => performance.now());
  }

  register(
    sessionId: string,
    tenant: string,
    signal: AbortSignal,
    options: { ttlMs?: number; onExpire?: () => void } = {}
  ): void {
    if (this.entries.has(sessionId))
      throw new ControlError('INVALID_REQUEST', 'Session is already registered');
    if (options.ttlMs !== undefined && (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1))
      throw new ControlError('INVALID_REQUEST', 'Invalid authority TTL');
    const entry: Entry = {
      control: new SessionControl(),
      incarnation: randomBytes(16).toString('base64url'),
      tenant,
      signal,
      abortListener: () => {
        if (this.entries.get(sessionId) === entry) this.remove(sessionId);
      },
      ...(options.ttlMs !== undefined ? { expiresAt: this.now() + options.ttlMs } : {}),
      ...(options.onExpire ? { onExpire: options.onExpire } : {}),
    };
    this.entries.set(sessionId, entry);
    signal.addEventListener('abort', entry.abortListener, { once: true });
    if (signal.aborted) this.remove(sessionId);
  }

  get(sessionId: string): SessionControl | undefined {
    return this.active(sessionId)?.control;
  }

  authenticate(token: string): Extract<SessionPrincipal, { actor: 'agent' }> | undefined {
    const principal = this.grants.get(digest(token));
    if (!principal) return undefined;
    const entry = this.active(principal.sessionId);
    if (!entry) return undefined;
    try {
      entry.control.authorizeAgent(principal.epoch);
      return { ...principal };
    } catch {
      return undefined;
    }
  }

  takeover(sessionId: string) {
    const entry = this.require(sessionId);
    this.revoke(entry);
    return entry.control.takeover();
  }

  delegate(sessionId: string, epoch: number, mode: AgentMode = DEFAULT_AGENT_MODE) {
    const entry = this.require(sessionId);
    const view = entry.control.delegate(epoch);
    this.revoke(entry);
    const token = randomBytes(32).toString('base64url');
    const principal = {
      actor: 'agent' as const,
      tenant: entry.tenant,
      sessionId,
      epoch: view.epoch,
      mode,
      bindingGeneration: randomBytes(16).toString('base64url'),
    };
    entry.grant = digest(token);
    entry.agent = principal;
    this.grants.set(entry.grant, principal);
    return { ...view, token, mode, cursor: this.cursor(principal) };
  }

  /** Safe scope key for harness memory. It conveys no authority or tenant identity. */
  status(sessionId: string): ControlView {
    const entry = this.require(sessionId);
    const view = entry.control.view();
    return {
      ...view,
      ...(entry.agent ? { cursor: this.cursor(entry.agent) } : {}),
    };
  }

  remove(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.signal.removeEventListener('abort', entry.abortListener);
    this.revoke(entry);
    entry.control.stop();
    this.entries.delete(sessionId);
  }

  private revoke(entry: Entry): void {
    if (entry.grant) this.grants.delete(entry.grant);
    entry.grant = undefined;
    entry.agent = undefined;
  }

  private cursor(principal: Extract<SessionPrincipal, { actor: 'agent' }>): RunCursor {
    return {
      version: 1,
      serviceGeneration: this.serviceGeneration,
      bindingGeneration: principal.bindingGeneration,
      sessionId: principal.sessionId,
      controlEpoch: principal.epoch,
      mode: principal.mode,
      profileRevision: agentModeProfile(principal.mode).revision,
    };
  }
  private active(sessionId: string): Entry | undefined {
    const entry = this.entries.get(sessionId);
    if (
      entry &&
      (entry.signal.aborted || (entry.expiresAt !== undefined && this.now() >= entry.expiresAt))
    ) {
      this.remove(sessionId);
      entry.onExpire?.();
      return undefined;
    }
    return entry;
  }
  private require(sessionId: string): Entry {
    const entry = this.active(sessionId);
    if (!entry) throw new ControlError('CONTROL_REVOKED', 'Controlled session is unavailable');
    return entry;
  }

  async run<T>(
    sessionId: string,
    principal: SessionPrincipal,
    operation: { id?: string; fingerprint?: string },
    fn: () => Promise<T>,
    failed: () => boolean | 'rejected' = () => false
  ): Promise<T | { replay: true; operation: unknown }> {
    this.assertPrincipal(sessionId, principal);
    const entry = this.require(sessionId);
    const ticket = entry.control.begin({
      actor: principal.actor,
      ...(principal.actor === 'agent' ? { epoch: principal.epoch } : {}),
      ...(operation.id
        ? { operationId: operation.id, fingerprint: operation.fingerprint ?? '' }
        : {}),
    });
    if ('replay' in ticket) return { replay: true, operation: ticket.replay };
    return this.scope.run({ sessionId, entry, ticket }, async () => {
      try {
        const result = await fn();
        if (this.require(sessionId) !== entry)
          throw new ControlError('CONTROL_REVOKED', 'Session owner changed');
        entry.control.check(ticket);
        const failure = failed();
        entry.control.finish(
          ticket,
          failure === 'rejected'
            ? 'failed'
            : failure
              ? ticket.didDispatch
                ? 'outcome_unknown'
                : 'failed'
              : 'completed'
        );
        return result;
      } catch (error) {
        entry.control.finish(ticket, ticket.didDispatch ? 'outcome_unknown' : 'failed');
        throw error;
      }
    });
  }

  assertPrincipal(sessionId: string, principal: SessionPrincipal): void {
    const entry = this.require(sessionId);
    if (
      principal.tenant !== entry.tenant ||
      (principal.actor === 'agent' && principal.sessionId !== sessionId)
    )
      throw new ControlError('CONTROL_REQUIRED', 'Session authority does not match');
    if (principal.actor === 'agent') entry.control.authorizeAgent(principal.epoch);
  }

  assert(sessionId: string, dispatch = false): void {
    const scope = this.scope.getStore();
    const entry =
      this.active(sessionId) ?? (scope?.sessionId === sessionId ? scope.entry : undefined);
    if (!entry) throw new ControlError('CONTROL_REVOKED', 'Controlled session is unavailable');
    if (!scope || scope.sessionId !== sessionId || scope.entry !== entry)
      throw new ControlError(
        'CONTROL_REQUIRED',
        'Controlled browser access requires an admitted principal'
      );
    if (dispatch) entry.control.dispatched(scope.ticket);
    else entry.control.check(scope.ticket);
  }

  /** Read-only dispatch classification for composition helpers in the admitted operation scope. */
  didDispatchInScope(sessionId: string): boolean {
    this.assert(sessionId);
    const scope = this.scope.getStore();
    if (!scope || scope.sessionId !== sessionId)
      throw new ControlError('CONTROL_REQUIRED', 'Missing operation authority');
    return scope.ticket.didDispatch;
  }

  outputGuard(sessionId: string): () => void {
    this.assert(sessionId);
    const scope = this.scope.getStore();
    if (!scope) throw new ControlError('CONTROL_REQUIRED', 'Missing output authority');
    return () => {
      if (this.active(sessionId) !== scope.entry)
        throw new ControlError('CONTROL_REVOKED', 'Session owner expired or changed');
      scope.entry.control.check(scope.ticket);
    };
  }

  currentEpoch(sessionId: string): number | undefined {
    return this.active(sessionId)?.control.view().epoch;
  }

  /** Stable for one registration; changes when a textual session ID is reused. */
  sessionIncarnation(sessionId: string): string {
    return this.require(sessionId).incarnation;
  }

  /** Trusted composition changes require idle human control and invalidate review. */
  configure<T>(sessionId: string, principal: SessionPrincipal, change: () => T): T {
    const entry = this.require(sessionId);
    if (principal.actor !== 'operator' || principal.tenant !== entry.tenant)
      throw new ControlError('CONTROL_REQUIRED', 'Operator authority does not match');
    const view = entry.control.view();
    if (view.busy) throw new ControlError('SESSION_BUSY', 'Session is busy');
    if (view.state !== 'HUMAN_ACTIVE' && view.state !== 'RESUME_REVIEW')
      throw new ControlError('CONTROL_REQUIRED', 'Human takeover is required');
    const result = change();
    this.takeover(sessionId);
    return result;
  }

  signal(sessionId: string): AbortSignal {
    return this.require(sessionId).signal;
  }
  isAgent(): boolean {
    return this.scope.getStore()?.ticket.actor === 'agent';
  }

  guardPage(sessionId: string, page: EnginePage): EnginePage {
    const owner = this.require(sessionId);
    const authority = this;
    return new Proxy(page, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        // Lifecycle event plumbing is service-owned, not caller-driven browser I/O.
        if (key === 'events' || key === 'getCachedUrl') return value.bind(target);
        return (...args: unknown[]) => {
          if (authority.active(sessionId) !== owner)
            throw new ControlError('CONTROL_REVOKED', 'Page belongs to a removed session owner');
          authority.assert(sessionId, key === 'act' || key === 'navigate' || key === 'close');
          return value.apply(target, args);
        };
      },
    });
  }
}
