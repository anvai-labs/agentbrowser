import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import {
  type ApprovalReviewBinding,
  ControlError,
  type ControlTicket,
  SessionControl,
} from '@agentbrowser/core';
import type { EnginePage } from '@agentbrowser/engine';
import {
  type AgentMode,
  CONTROL_OPERATION_ID,
  type ControlView,
  DEFAULT_AGENT_MODE,
  type OperationRecord,
  type RunCursor,
  agentModeProfile,
} from '@agentbrowser/protocol';
import { journalData, journalObject, parseJournalIntent } from './journal-record.js';
import type {
  JournalApplication,
  JournalCall,
  JournalIntent,
  JournalMutationOutcome,
  JournalRecord,
  OperationJournal,
} from './journal-types.js';
import {
  type OperationPublication,
  type SessionPublication,
  type TerminalStatus,
  publishWithin,
  snapshotPublication,
} from './publication.js';
export type {
  OperationPublication,
  PublicationContext,
  SessionPublication,
  SessionPublicationContext,
} from './publication.js';
import { deeplyFreezeSnapshot, synchronousResult } from './trusted-callback.js';

/** Trusted internal composition; never accepted from service or wire options. */
export interface ApplicationJournalOperation {
  readonly version: 1;
  readonly application: JournalApplication;
}

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
export type SessionAdmission =
  | Readonly<{ actor: 'operator'; tenant: string }>
  | Readonly<{ actor: 'agent'; tenant: string; mode: AgentMode }>;
/** Internal review context only; possession conveys no authority or payload freshness. */
export type SessionReviewBinding = ApprovalReviewBinding;
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
  configuring?: boolean;
};
type Scope = {
  sessionId: string;
  entry: Entry;
  ticket: ControlTicket;
  admission: SessionAdmission;
  open: boolean;
  pending: Set<Promise<unknown>>;
  pendingDispatches: number;
  guardingDispatch: boolean;
  dispatchGuardViolated: boolean;
  journal?: {
    readonly intent: JournalIntent;
    record?: JournalRecord;
    marker?: Promise<void>;
    failed: boolean;
  };
  /** Actual bounded output lifetime, never borrowed from a caller-supplied context. */
  publicationGuard: (() => void) | undefined;
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const journalUnavailable = () =>
  new ControlError('CONTROL_REQUIRED', 'Journal execution is not qualified or acknowledged');

/** Runtime brand and exact scope binding, without another capability registry. */
class CapturedApplicationDispatch {
  readonly #scope: Scope;
  readonly #guard: () => void;

  constructor(scope: Scope, guard: () => void) {
    this.#scope = scope;
    this.#guard = guard;
    Object.freeze(this);
  }

  static check(value: ApplicationDispatchQualification, scope: Scope): void {
    if (!value || typeof value !== 'object' || !(#scope in value) || value.#scope !== scope)
      throw journalUnavailable();
  }

  static invoke(value: ApplicationDispatchQualification, scope: Scope): void {
    CapturedApplicationDispatch.check(value, scope);
    try {
      if (synchronousResult(value.#guard()) !== undefined) throw journalUnavailable();
    } catch {
      throw journalUnavailable();
    }
  }
}
export type ApplicationDispatchQualification = CapturedApplicationDispatch;

/** Read caller-owned fields once before consulting mutable authority state. */
function snapshotPrincipal(principal: SessionPrincipal): SessionPrincipal {
  const actor = principal.actor;
  if (actor === 'operator') {
    const tenant = principal.tenant;
    return { actor, ...(tenant !== undefined ? { tenant } : {}) };
  }
  if (actor === 'agent')
    return {
      actor,
      tenant: principal.tenant,
      sessionId: principal.sessionId,
      epoch: principal.epoch,
      mode: principal.mode,
      bindingGeneration: principal.bindingGeneration,
    };
  throw new ControlError('CONTROL_REQUIRED', 'Session authority does not match');
}

/** Credentials stay in the shared composition layer, separate from core state. */
export class SessionAuthority {
  private readonly entries = new Map<string, Entry>();
  private readonly grants = new Map<string, Extract<SessionPrincipal, { actor: 'agent' }>>();
  private readonly scope = new AsyncLocalStorage<Scope>();
  private readonly now: () => number;
  private readonly journal: OperationJournal | undefined;
  private readonly serviceGeneration = randomBytes(16).toString('base64url');

  constructor(options: { now?: () => number; journal?: OperationJournal } = {}) {
    this.now = options.now ?? (() => performance.now());
    this.journal = options.journal;
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
    operation: { id?: string; fingerprint?: string; journal?: ApplicationJournalOperation },
    fn: () => Promise<T>,
    failed: () => boolean | 'rejected' = () => false,
    publicationOptions?: SessionPublication<T>,
    replayOptions?: OperationPublication,
    assertReplay?: () => void
  ): Promise<T | { replay: true; operation: unknown }> {
    const { id, fingerprint, journal: selection } = operation;
    const publication =
      publicationOptions === undefined ? undefined : snapshotPublication(publicationOptions);
    const replayPublication =
      replayOptions === undefined ? undefined : snapshotPublication(replayOptions);
    const candidate = Object.freeze(snapshotPrincipal(principal));
    const admitted = this.admit(sessionId, candidate);
    const { entry, admission } = admitted;
    let intent: JournalIntent | undefined;
    if (selection !== undefined) {
      try {
        if (!this.journal) throw journalUnavailable();
        const descriptor = journalObject(journalData(selection), ['version', 'application']);
        if (descriptor.version !== 1) throw journalUnavailable();
        intent = parseJournalIntent({
          key: {
            serviceGeneration: this.serviceGeneration,
            tenantId: admission.tenant,
            sessionIncarnation: entry.incarnation,
            epoch: entry.control.view().epoch,
            operationId: id,
          },
          actor: admission.actor,
          application: descriptor.application,
          liveFingerprint: { algorithm: 'application-operation:v1', digest: fingerprint },
        });
      } catch {
        throw journalUnavailable();
      }
    }
    const assertReplayOwner =
      replayPublication || assertReplay ? this.statusOwner(sessionId, candidate, entry) : undefined;
    const ticket = entry.control.begin({
      actor: admission.actor,
      acknowledgmentRequired: intent !== undefined,
      ...(admitted.epoch !== undefined ? { epoch: admitted.epoch } : {}),
      ...(id ? { operationId: id, fingerprint: fingerprint ?? '' } : {}),
    });
    if ('replay' in ticket) {
      if (assertReplay && assertReplayOwner) {
        try {
          this.scope.exit(() => {
            assertReplayOwner();
            if (synchronousResult(assertReplay()) !== undefined) throw journalUnavailable();
            assertReplayOwner();
          });
        } catch {
          throw new ControlError('CONTROL_REQUIRED', 'Operation replay is not permitted');
        }
      }
      const record =
        replayPublication && assertReplayOwner
          ? await this.publishStatus(ticket.replay, replayPublication, assertReplayOwner)
          : ticket.replay;
      return { replay: true, operation: record };
    }
    const scope: Scope = {
      sessionId,
      entry,
      ticket,
      admission,
      open: true,
      pending: new Set(),
      pendingDispatches: 0,
      guardingDispatch: false,
      dispatchGuardViolated: false,
      ...(intent
        ? {
            journal: {
              intent: deeplyFreezeSnapshot({
                ...intent,
                key: { ...intent.key, epoch: ticket.epoch },
              }),
              failed: false,
            },
          }
        : {}),
      publicationGuard: undefined,
    };
    return this.scope.run(scope, async () => {
      let status: TerminalStatus = 'failed';
      let result!: T;
      let executionError: unknown;
      let succeeded = false;
      try {
        if (scope.journal) await this.acknowledgeJournal(scope, 'intent');
        result = await fn();
        this.checkScopeOwner(scope);
        if (scope.journal) this.checkJournalScope(scope);
        const failure = scope.journal ? synchronousResult(failed()) : failed();
        if (scope.journal) this.checkJournalScope(scope);
        status =
          failure === 'rejected'
            ? 'failed'
            : failure
              ? ticket.didDispatch
                ? 'outcome_unknown'
                : 'failed'
              : 'completed';
        succeeded = true;
      } catch (error) {
        status = ticket.didDispatch ? 'outcome_unknown' : 'failed';
        executionError = error;
      } finally {
        // Completion of the work callback ends permission to admit more work.
        scope.open = false;
        if (scope.pendingDispatches > 0) status = 'outcome_unknown';
      }
      const finalize = () => {
        try {
          this.checkScopeOwner(scope);
          if (scope.journal?.failed) throw journalUnavailable();
        } catch {
          status = ticket.didDispatch ? 'outcome_unknown' : 'failed';
        }
        entry.control.finalize(ticket, status);
      };
      const finish = () => {
        finalize();
        // Never release another incarnation's ticket.
        entry.control.finish(ticket, status);
      };
      if (scope.journal) {
        try {
          // The bounded marker outcome may fail while its raw I/O is still pending.
          // Never wait for that abandoned I/O before returning a refusal.
          await scope.journal.marker?.catch(() => undefined);
          if (this.journal?.health === 'open' && scope.pending.size > 0)
            await Promise.allSettled([...scope.pending]);
          if (status === 'completed' && !ticket.didDispatch) {
            status = 'failed';
            succeeded = false;
            executionError = journalUnavailable();
          }
          finalize();
          await this.acknowledgeJournal(scope, 'terminal', status);
          if (!succeeded) throw executionError;
          if (status === 'outcome_unknown') throw journalUnavailable();
          this.checkScopeOwner(scope);
          if (publication) await this.publish(scope, result, status, publication);
          return result;
        } finally {
          // Terminal timeout cannot free a store transaction or a different owner.
          const release = () => entry.control.finish(ticket, status);
          if (scope.pending.size === 0) release();
          else
            void Promise.allSettled([...scope.pending])
              .then(release)
              .catch(() => undefined);
        }
      }
      if (!publication) {
        if (scope.pending.size === 0) finish();
        else
          void Promise.allSettled([...scope.pending])
            .then(finish)
            .catch(() => undefined);
        if (!succeeded) throw executionError;
        return result;
      }
      try {
        if (scope.pending.size > 0) await Promise.allSettled([...scope.pending]);
        finalize();
        if (!succeeded) throw executionError;
        await this.publish(scope, result, status, publication);
        return result;
      } finally {
        // Publication errors must not reclassify already-finalized execution.
        entry.control.finish(ticket, status);
      }
    });
  }

  private checkScopeOwner(scope: Scope): void {
    if (this.active(scope.sessionId) !== scope.entry)
      throw new ControlError('CONTROL_REVOKED', 'Session owner changed');
    scope.entry.control.check(scope.ticket);
  }

  private checkJournalScope(scope: Scope): void {
    if (!scope.open || scope.journal?.failed || this.journal?.health !== 'open')
      throw journalUnavailable();
    this.checkScopeOwner(scope);
  }

  /** Storage settlement, not bounded caller waiting, owns the existing scope's drain. */
  private retainJournalCall<T>(scope: Scope, call: JournalCall<T>): JournalCall<T> {
    this.retainTask(scope, call.settled);
    return call;
  }

  private async acknowledgeJournal(
    scope: Scope,
    phase: 'intent' | 'dispatch' | 'terminal',
    terminalStatus?: TerminalStatus
  ): Promise<void> {
    const state = scope.journal;
    if (!state || !this.journal) throw journalUnavailable();
    try {
      // Terminal persistence is bookkeeping for the captured record, including
      // revoked owners. It grants no effect or output authority.
      if (phase === 'terminal') {
        if (this.journal.health !== 'open' || !state.record || !terminalStatus)
          throw journalUnavailable();
      } else this.checkJournalScope(scope);
      let call: JournalCall<JournalMutationOutcome>;
      if (phase === 'intent') {
        call = this.journal.reserveIntent(state.intent, scope.entry.signal);
      } else if (phase === 'terminal') {
        if (!state.record || !terminalStatus) throw journalUnavailable();
        call = this.journal.commitTerminal({
          identity: state.record.identity,
          expectedRevision: state.record.revision,
          dispatched: state.record.dispatched,
          terminal: { status: terminalStatus, evidenceRefIds: [] },
        });
      } else {
        if (!state.record) throw journalUnavailable();
        call = this.journal.markDispatch(
          { identity: state.record.identity, expectedRevision: 1 },
          scope.entry.signal
        );
      }
      const expectedRevision =
        phase === 'intent' ? 1 : phase === 'dispatch' ? 2 : (state.record?.revision ?? 0) + 1;
      const outcome = await this.retainJournalCall(scope, call);
      if (
        outcome.kind !== 'acknowledged' ||
        outcome.disposition !== 'applied' ||
        outcome.record.revision !== expectedRevision
      )
        throw journalUnavailable();
      state.record = outcome.record;
      scope.entry.control.acknowledge(scope.ticket, {
        status: outcome.record.terminal?.status ?? 'in_flight',
        dispatched: outcome.record.dispatched,
      });
      if (phase !== 'terminal') this.checkJournalScope(scope);
    } catch {
      state.failed = true;
      throw journalUnavailable();
    }
  }

  private async publish<T>(
    scope: Scope,
    result: T,
    status: TerminalStatus,
    publication: SessionPublication<T>
  ): Promise<void> {
    try {
      await publishWithin(
        publication,
        () => this.checkScopeOwner(scope),
        this.now,
        (context) => {
          scope.publicationGuard = context.assertCurrent;
          return publication.publish(result, Object.freeze({ ...context, status }));
        }
      );
    } finally {
      // Clear before release even when a non-cooperative publisher is still pending.
      scope.publicationGuard = undefined;
    }
  }

  /** Publish an explicit status snapshot without acquiring or borrowing an execution ticket. */
  async publishOperation(
    sessionId: string,
    principal: SessionPrincipal,
    operationId: string,
    options: OperationPublication
  ) {
    const publication = snapshotPublication(options);
    const candidate = Object.freeze(snapshotPrincipal(principal));
    if (typeof operationId !== 'string' || !CONTROL_OPERATION_ID.test(operationId))
      throw new ControlError('INVALID_REQUEST', 'Invalid operation ID');
    const { entry, admission, epoch: agentEpoch } = this.admit(sessionId, candidate);
    const assertOwner = this.statusOwner(sessionId, candidate, entry);
    assertOwner();
    const record = entry.control.publicationOperation(operationId);
    assertOwner();
    if (!record) return undefined;
    if (admission.actor === 'agent' && record.epoch !== agentEpoch)
      throw new ControlError('CONTROL_REQUIRED', 'Operation belongs to another control generation');
    return this.publishStatus(record, publication, assertOwner);
  }

  private statusOwner(sessionId: string, candidate: SessionPrincipal, entry: Entry) {
    const epoch = entry.control.view().epoch;
    const review = entry.control.reviewVersion();
    return () => {
      const current = this.admit(sessionId, candidate);
      const view = entry.control.view();
      if (
        current.entry !== entry ||
        entry.configuring ||
        view.state === 'STOPPED' ||
        view.epoch !== epoch ||
        entry.control.reviewVersion() !== review
      )
        throw new ControlError('CONTROL_REVOKED', 'Operation status authority changed');
    };
  }

  private publishStatus(
    record: OperationRecord,
    publication: OperationPublication,
    assertOwner: () => void
  ) {
    const snapshot = Object.freeze(record);
    // A nested lookup must not lend its caller's open execution scope to the publisher.
    return this.scope.exit(async () => {
      await publishWithin(publication, assertOwner, this.now, (context) =>
        publication.publish(snapshot, context)
      );
      return snapshot;
    });
  }

  /** Retain observations through drain without retroactively failing completed execution. */
  trackReadInScope<T>(sessionId: string, callback: () => T | PromiseLike<T>): Promise<T> {
    return this.trackInScope(sessionId, callback, false);
  }

  /** Exact-scope capability for a trusted application owner's synchronous final pins. */
  captureApplicationDispatchInScope(
    sessionId: string,
    assertCurrent: () => void
  ): ApplicationDispatchQualification {
    this.assert(sessionId);
    const scope = this.scope.getStore();
    if (!scope?.journal?.intent.application || typeof assertCurrent !== 'function')
      throw journalUnavailable();
    this.checkJournalScope(scope);
    return new CapturedApplicationDispatch(scope, assertCurrent);
  }

  /** One effect boundary and drain owner for ephemeral and qualified journal work. */
  dispatchInScope<T>(
    sessionId: string,
    callback: () => T | PromiseLike<T>,
    qualification?: ApplicationDispatchQualification
  ): Promise<T> {
    return this.trackInScope(sessionId, callback, true, qualification);
  }

  private retainTask(scope: Scope, task: Promise<unknown>, onSettled?: () => void): void {
    scope.pending.add(task);
    const settled = () => {
      scope.pending.delete(task);
      onSettled?.();
    };
    // Both branches: task tracking must never introduce an unhandled rejection.
    void task.then(settled, settled);
  }

  private checkDispatchGuardBoundary(scope: Scope): void {
    if (scope.guardingDispatch) scope.dispatchGuardViolated = true;
    if (scope.dispatchGuardViolated) throw journalUnavailable();
  }

  private trackInScope<T>(
    sessionId: string,
    callback: () => T | PromiseLike<T>,
    dispatch: boolean,
    qualification?: ApplicationDispatchQualification
  ): Promise<T> {
    this.assert(sessionId);
    const scope = this.scope.getStore();
    if (!scope) throw new ControlError('CONTROL_REQUIRED', 'Missing operation authority');
    if (dispatch) {
      this.checkDispatchGuardBoundary(scope);
      if (scope.journal && !qualification) throw journalUnavailable();
      if (qualification) CapturedApplicationDispatch.check(qualification, scope);
      if (scope.journal) this.checkJournalScope(scope);
    }
    let dispatched = false;
    const invoke = () => {
      this.assert(sessionId);
      if (dispatch) {
        this.checkDispatchGuardBoundary(scope);
        if (scope.journal) this.checkJournalScope(scope);
        if (qualification) {
          scope.guardingDispatch = true;
          try {
            CapturedApplicationDispatch.invoke(qualification, scope);
          } finally {
            scope.guardingDispatch = false;
          }
        }
        this.checkDispatchGuardBoundary(scope);
        if (scope.journal) this.checkJournalScope(scope);
        this.assert(sessionId);
        scope.entry.control.dispatched(scope.ticket);
        scope.pendingDispatches++;
        dispatched = true;
      }
      return callback();
    };
    let start: () => void = () => {};
    const task = new Promise<T>((resolve, reject) => {
      start = () => {
        try {
          if (dispatch && scope.journal) {
            scope.journal.marker ??= this.acknowledgeJournal(scope, 'dispatch');
            resolve(
              scope.journal.marker.then(invoke).catch((error) => {
                // Before-effect failure seals further journal work. An effect's own
                // rejection retains the existing handled-error execution semantics.
                if (!dispatched && scope.journal) scope.journal.failed = true;
                throw error;
              })
            );
          } else {
            resolve(invoke());
          }
        } catch (error) {
          if (!dispatched && scope.journal) scope.journal.failed = true;
          reject(error);
        }
      };
    });
    this.retainTask(scope, task, () => {
      if (dispatched) scope.pendingDispatches--;
    });
    // Register before invocation while preserving the caller's synchronous admission checks.
    start();
    return task;
  }

  assertPrincipal(sessionId: string, principal: SessionPrincipal): void {
    this.admit(sessionId, principal);
  }

  private admit(
    sessionId: string,
    principal: SessionPrincipal
  ): { entry: Entry; admission: SessionAdmission; epoch?: number } {
    const candidate = snapshotPrincipal(principal);
    const entry = this.require(sessionId);
    if (candidate.actor === 'operator') {
      if (candidate.tenant !== entry.tenant)
        throw new ControlError('CONTROL_REQUIRED', 'Session authority does not match');
      return {
        entry,
        admission: Object.freeze({ actor: 'operator', tenant: entry.tenant }),
      };
    }
    if (candidate.actor === 'agent') {
      const agent = entry.agent;
      if (
        !agent ||
        candidate.sessionId !== sessionId ||
        candidate.sessionId !== agent.sessionId ||
        candidate.tenant !== entry.tenant ||
        candidate.tenant !== agent.tenant ||
        candidate.epoch !== agent.epoch ||
        candidate.mode !== agent.mode ||
        candidate.bindingGeneration !== agent.bindingGeneration
      )
        throw new ControlError('CONTROL_REQUIRED', 'Session authority does not match');
      entry.control.authorizeAgent(agent.epoch);
      return {
        entry,
        admission: Object.freeze({ actor: 'agent', tenant: entry.tenant, mode: agent.mode }),
        epoch: agent.epoch,
      };
    }
    throw new ControlError('CONTROL_REQUIRED', 'Session authority does not match');
  }

  assert(sessionId: string, dispatch = false): void {
    const scope = this.scope.getStore();
    const entry =
      this.active(sessionId) ?? (scope?.sessionId === sessionId ? scope.entry : undefined);
    if (!entry) throw new ControlError('CONTROL_REVOKED', 'Controlled session is unavailable');
    if (!scope || !scope.open || scope.sessionId !== sessionId || scope.entry !== entry)
      throw new ControlError(
        'CONTROL_REQUIRED',
        'Controlled browser access requires an admitted principal'
      );
    if (dispatch) {
      this.checkDispatchGuardBoundary(scope);
      if (scope.journal) throw journalUnavailable();
      entry.control.dispatched(scope.ticket);
    } else entry.control.check(scope.ticket);
  }

  /** Read-only dispatch classification for composition helpers in the admitted operation scope. */
  didDispatchInScope(sessionId: string): boolean {
    this.assert(sessionId);
    const scope = this.scope.getStore();
    if (!scope || scope.sessionId !== sessionId)
      throw new ControlError('CONTROL_REQUIRED', 'Missing operation authority');
    return scope.ticket.didDispatch;
  }

  /** Immutable identity captured from trusted authority state when this ticket was admitted. */
  admissionInScope(sessionId: string): SessionAdmission {
    this.assert(sessionId);
    const scope = this.scope.getStore();
    if (!scope || scope.sessionId !== sessionId)
      throw new ControlError('CONTROL_REQUIRED', 'Missing operation authority');
    return scope.admission;
  }

  outputGuard(sessionId: string): () => void {
    this.assert(sessionId);
    const scope = this.scope.getStore();
    if (!scope) throw new ControlError('CONTROL_REQUIRED', 'Missing output authority');
    return () => {
      if (!scope.open)
        throw new ControlError('CONTROL_REVOKED', 'Session owner expired or changed');
      this.checkScopeOwner(scope);
    };
  }

  /** Capture during execution; check only inside this exact run's bounded publication. */
  publicationGuardInScope(sessionId: string): () => void {
    this.assert(sessionId);
    const scope = this.scope.getStore();
    if (!scope) throw new ControlError('CONTROL_REQUIRED', 'Missing publication owner');
    return () => {
      if (!scope.publicationGuard)
        throw new ControlError('CONTROL_REVOKED', 'Publication is not active');
      scope.publicationGuard();
    };
  }

  /** Review identity and output pins; conveys no read, dispatch or consent authority. */
  captureReviewPublicationInScope(sessionId: string) {
    const binding = this.reviewBindingInScope(sessionId);
    const scope = this.scope.getStore();
    if (!scope) throw new ControlError('CONTROL_REQUIRED', 'Missing review owner');
    const publication = this.publicationGuardInScope(sessionId);
    let revoked = false;
    return Object.freeze({
      binding,
      assertCurrent: () => {
        if (revoked) throw new ControlError('CONTROL_REVOKED', 'Review publication revoked');
        try {
          publication();
          if (this.reviewBinding(scope).reviewVersion !== binding.reviewVersion)
            throw new ControlError('CONTROL_REVOKED', 'Review authority changed');
        } catch (error) {
          revoked = true;
          throw error;
        }
      },
    });
  }

  currentEpoch(sessionId: string): number | undefined {
    return this.active(sessionId)?.control.view().epoch;
  }

  /** Stable for one registration; changes when a textual session ID is reused. */
  sessionIncarnation(sessionId: string): string {
    return this.require(sessionId).incarnation;
  }

  /** Capture only from a live operator scope, never from a caller-supplied actor label. */
  reviewBindingInScope(sessionId: string): SessionReviewBinding {
    this.assert(sessionId);
    const scope = this.scope.getStore();
    if (!scope) throw new ControlError('CONTROL_REQUIRED', 'Missing review owner');
    return this.reviewBinding(scope);
  }

  /** Shared owner projection; execution and publication supply distinct lifetime checks. */
  private reviewBinding(scope: Scope): SessionReviewBinding {
    this.checkScopeOwner(scope);
    if (
      scope.admission.actor !== 'operator' ||
      scope.entry.configuring ||
      scope.entry.control.view().state !== 'HUMAN_ACTIVE'
    )
      throw new ControlError('CONTROL_REQUIRED', 'Stable operator control is required for review');
    return Object.freeze({
      tenant: scope.admission.tenant,
      sessionId: scope.sessionId,
      sessionIncarnation: scope.entry.incarnation,
      epoch: scope.ticket.epoch,
      reviewVersion: scope.entry.control.reviewVersion(),
    });
  }

  /** Trusted composition changes require idle human control and invalidate review. */
  configure<T>(sessionId: string, principal: SessionPrincipal, change: () => T): T {
    const { entry, admission } = this.admit(sessionId, principal);
    if (admission.actor !== 'operator')
      throw new ControlError('CONTROL_REQUIRED', 'Operator authority does not match');
    const view = entry.control.view();
    if (view.busy) throw new ControlError('SESSION_BUSY', 'Session is busy');
    if (view.state !== 'HUMAN_ACTIVE' && view.state !== 'RESUME_REVIEW')
      throw new ControlError('CONTROL_REQUIRED', 'Human takeover is required');
    const configuring = entry.configuring ?? false;
    entry.configuring = true;
    entry.control.invalidateReview();
    try {
      const result = synchronousResult(change());
      if (this.require(sessionId) !== entry)
        throw new ControlError('CONTROL_REVOKED', 'Session owner changed during configuration');
      return result;
    } finally {
      entry.configuring = configuring;
      // A callback can throw after mutation, reenter or replace the textual session ID.
      // Always invalidate/revoke the captured owner; never touch its replacement.
      this.revoke(entry);
      entry.control.takeover();
    }
  }

  signal(sessionId: string): AbortSignal {
    return this.require(sessionId).signal;
  }
  isAgent(): boolean {
    const scope = this.scope.getStore();
    if (!scope || !scope.open || scope.ticket.actor !== 'agent') return false;
    try {
      this.assert(scope.sessionId);
      return true;
    } catch {
      return false;
    }
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
          if (key === 'act' || key === 'navigate' || key === 'close')
            return authority.dispatchInScope(sessionId, () => value.apply(target, args));
          authority.assert(sessionId);
          return value.apply(target, args);
        };
      },
    });
  }
}
