import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { ControlError, type ControlTicket, SessionControl } from '@agentbrowser/core';
import type { EnginePage } from '@agentbrowser/engine';

export type SessionPrincipal =
  | { actor: 'operator'; tenant?: string }
  | { actor: 'agent'; tenant: string; sessionId: string; epoch: number };
type Entry = {
  control: SessionControl;
  tenant: string;
  grant?: string | undefined;
  signal: AbortSignal;
};
type Scope = { sessionId: string; entry: Entry; ticket: ControlTicket };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Credentials stay in the shared composition layer, separate from core state. */
export class SessionAuthority {
  private readonly entries = new Map<string, Entry>();
  private readonly grants = new Map<string, Extract<SessionPrincipal, { actor: 'agent' }>>();
  private readonly scope = new AsyncLocalStorage<Scope>();

  register(sessionId: string, tenant: string, signal: AbortSignal): void {
    const entry: Entry = { control: new SessionControl(), tenant, signal };
    this.entries.set(sessionId, entry);
    signal.addEventListener('abort', () => this.remove(sessionId), { once: true });
    if (signal.aborted) this.remove(sessionId);
  }

  get(sessionId: string): SessionControl | undefined {
    return this.entries.get(sessionId)?.control;
  }

  authenticate(token: string): Extract<SessionPrincipal, { actor: 'agent' }> | undefined {
    const principal = this.grants.get(digest(token));
    if (!principal) return undefined;
    const entry = this.entries.get(principal.sessionId);
    if (!entry || entry.signal.aborted) return undefined;
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

  delegate(sessionId: string, epoch: number) {
    const entry = this.require(sessionId);
    const view = entry.control.delegate(epoch);
    this.revoke(entry);
    const token = randomBytes(32).toString('base64url');
    entry.grant = digest(token);
    this.grants.set(entry.grant, {
      actor: 'agent',
      tenant: entry.tenant,
      sessionId,
      epoch: view.epoch,
    });
    return { ...view, token };
  }

  remove(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.revoke(entry);
    entry.control.stop();
    this.entries.delete(sessionId);
  }

  private revoke(entry: Entry): void {
    if (entry.grant) this.grants.delete(entry.grant);
    entry.grant = undefined;
  }
  private require(sessionId: string): Entry {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.signal.aborted)
      throw new ControlError('CONTROL_REVOKED', 'Controlled session is unavailable');
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
      this.entries.get(sessionId) ?? (scope?.sessionId === sessionId ? scope.entry : undefined);
    if (!entry) return;
    if (!scope || scope.sessionId !== sessionId || scope.entry !== entry)
      throw new ControlError(
        'CONTROL_REQUIRED',
        'Controlled browser access requires an admitted principal'
      );
    if (dispatch) entry.control.dispatched(scope.ticket);
    else entry.control.check(scope.ticket);
  }

  outputGuard(sessionId: string): () => void {
    this.assert(sessionId);
    const scope = this.scope.getStore();
    if (!scope) throw new ControlError('CONTROL_REQUIRED', 'Missing output authority');
    return () => scope.entry.control.check(scope.ticket);
  }

  currentEpoch(sessionId: string): number | undefined {
    return this.entries.get(sessionId)?.control.view().epoch;
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
    if (!this.entries.has(sessionId)) return page;
    const authority = this;
    return new Proxy(page, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        // Lifecycle event plumbing is service-owned, not caller-driven browser I/O.
        if (key === 'events' || key === 'getCachedUrl') return value.bind(target);
        return (...args: unknown[]) => {
          authority.assert(sessionId, key === 'act' || key === 'navigate' || key === 'close');
          return value.apply(target, args);
        };
      },
    });
  }
}
