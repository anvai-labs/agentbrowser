import { createHash, randomUUID } from 'node:crypto';
import { ControlError, type SessionControl } from '@agentbrowser/core';
import {
  CONTROL_OPERATION_ID,
  VERIFICATION_SNAPSHOT_LIMITS,
  snapshotJsonData,
  validateApplicationOperationDescriptors,
} from '@agentbrowser/protocol';
import { canonicalJson } from './canonical-json.js';
import {
  type SessionAdmission,
  SessionAuthority,
  type SessionPrincipal,
} from './session-authority.js';
import { synchronousResult } from './trusted-callback.js';

export interface ApplicationScope {
  readonly sessionId: string;
  readonly sessionIncarnation: string;
  readonly tenant: string;
  readonly resource: string;
  readonly signal: AbortSignal;
  readonly operationId?: string;
  readonly expectedVersion?: number;
}
/** Authority-owned identity for trusted receipt composition; not a wire capability. */
export interface PreparedApplicationReceiptReader {
  readonly identity: Readonly<{
    admission: SessionAdmission;
    adapter: string;
    resource: string;
    sessionId: string;
    sessionIncarnation: string;
  }>;
  assertAuthority(): void;
  read(operationId: string, signal?: AbortSignal): Promise<unknown>;
}

/** Trusted application data composed inside one existing admission. */
export interface PreparedApplicationRead {
  readonly identity: PreparedApplicationReceiptReader['identity'] & Readonly<{ operation: string }>;
  assertAuthority(): void;
  read(signal?: AbortSignal): Promise<unknown>;
}

/**
 * Descriptor inspection rejects symbols, hidden properties and extra array keys
 * that canonicalJson intentionally does not serialize. Canonical serialization
 * then enforces finite JSON and its existing exact 64 KiB output budget.
 */
function snapshotReadData(input: unknown): unknown {
  return JSON.parse(canonicalJson(snapshotJsonData(input, VERIFICATION_SNAPSHOT_LIMITS)));
}

function assertReceiptId(operationId: string): void {
  if (typeof operationId !== 'string' || !CONTROL_OPERATION_ID.test(operationId))
    throw new ControlError('INVALID_REQUEST', 'Invalid receipt ID');
}

export type ApplicationResult<T = unknown> =
  | { status: 'read' | 'committed'; value: T }
  | { status: 'rejected'; reason: string };

export interface ApplicationOperation {
  readonly mode: 'read' | 'write';
  prepare(input: unknown): (scope: ApplicationScope) => Promise<ApplicationResult>;
}

/** Type-check adapter input/output while keeping validation inside admission. */
export function defineApplicationOperation<Input, Output>(operation: {
  mode: 'read' | 'write';
  parse(input: unknown): Input;
  execute(input: Input, scope: ApplicationScope): Promise<ApplicationResult<Output>>;
}): ApplicationOperation {
  const mode = operation.mode;
  const parse = operation.parse.bind(operation);
  const execute = operation.execute.bind(operation);
  return Object.freeze({
    mode,
    prepare(input: unknown) {
      const parsed = parse(input);
      return (scope: ApplicationScope) => execute(parsed, scope);
    },
  });
}

export interface ApplicationAdapter {
  readonly id: string;
  authorize(scope: { tenant: string; resource: string }): boolean;
  readonly operations: Readonly<Record<string, ApplicationOperation>>;
  receipt(scope: ApplicationScope, operationId: string): Promise<unknown>;
}
export interface ApplicationBinding {
  adapter: string;
  resource: string;
}
export interface ApplicationRequest {
  operation: string;
  input: unknown;
  operationId?: string;
  expectedVersion?: number;
}
type Binding = ApplicationBinding & { generation: string; tenant: string };

/** All application policy boundaries share strict synchronous, non-disclosing denial. */
function assertApplicationAuthorized(
  adapter: ApplicationAdapter,
  scope: { tenant: string; resource: string }
): void {
  try {
    if (synchronousResult(adapter.authorize(scope)) === true) return;
  } catch {
    // Callback exceptions and malformed results are policy denial, never private diagnostics.
  }
  throw new ControlError('CONTROL_REQUIRED', 'Application scope is not permitted');
}

/** Opt-in trusted adapters. This port owns no browser, planner, network client or database. */
export class ApplicationAuthority {
  private readonly adapters = new Map<string, ApplicationAdapter>();
  private readonly bindings = new WeakMap<SessionControl, Binding>();

  constructor(
    private readonly authority: SessionAuthority,
    adapters: readonly ApplicationAdapter[] = []
  ) {
    for (const adapter of adapters) {
      try {
        const id = adapter.id;
        const authorize = adapter.authorize;
        const receipt = adapter.receipt;
        const declared = adapter.operations;
        if (
          typeof id !== 'string' ||
          !CONTROL_OPERATION_ID.test(id) ||
          this.adapters.has(id) ||
          typeof authorize !== 'function' ||
          typeof receipt !== 'function' ||
          !declared ||
          typeof declared !== 'object' ||
          Array.isArray(declared)
        )
          throw new Error();
        const operations = Object.entries(declared).map(([name, operation]) => {
          const mode = operation.mode;
          const prepare = operation.prepare;
          if (typeof prepare !== 'function') throw new Error();
          return [name, Object.freeze({ mode, prepare: prepare.bind(operation) })] as const;
        });
        if (
          !validateApplicationOperationDescriptors(
            operations.map(([name, operation]) => ({ name, mode: operation.mode }))
          ).ok
        )
          throw new Error();
        this.adapters.set(
          id,
          Object.freeze({
            id,
            authorize: authorize.bind(adapter),
            receipt: receipt.bind(adapter),
            operations: Object.freeze(Object.fromEntries(operations)),
          })
        );
      } catch {
        throw new ControlError('INVALID_REQUEST', 'Invalid or duplicate application adapter');
      }
    }
  }

  unbind(sessionId: string, principal: SessionPrincipal): void {
    this.authority.configure(sessionId, principal, () => {
      const control = this.authority.get(sessionId);
      if (control) this.bindings.delete(control);
    });
  }

  bind(sessionId: string, principal: SessionPrincipal, requested: ApplicationBinding): void {
    if (principal.actor !== 'operator')
      throw new ControlError('CONTROL_REQUIRED', 'Operator authority does not match');
    const requestedTenant = principal.tenant;
    const owner: SessionPrincipal = {
      actor: 'operator',
      ...(requestedTenant !== undefined ? { tenant: requestedTenant } : {}),
    };
    const adapterId = requested.adapter;
    const resource = requested.resource;
    this.authority.configure(sessionId, owner, () => {
      const adapter = this.adapters.get(adapterId);
      const tenant = owner.tenant;
      if (
        !adapter ||
        !tenant ||
        typeof resource !== 'string' ||
        !CONTROL_OPERATION_ID.test(resource)
      )
        throw new ControlError('CONTROL_REQUIRED', 'Application binding is not permitted');
      const control = this.authority.get(sessionId);
      if (!control) throw new ControlError('CONTROL_REVOKED', 'Session was removed');
      const epoch = control.view().epoch;
      const previous = this.bindings.get(control);
      assertApplicationAuthorized(adapter, Object.freeze({ tenant, resource }));
      const view = control.view();
      if (
        this.authority.get(sessionId) !== control ||
        view.epoch !== epoch ||
        view.busy ||
        (view.state !== 'HUMAN_ACTIVE' && view.state !== 'RESUME_REVIEW') ||
        this.bindings.get(control) !== previous
      )
        throw new ControlError('CONTROL_REVOKED', 'Application binding authority changed');
      this.bindings.set(control, {
        adapter: adapter.id,
        resource,
        tenant,
        generation: randomUUID(),
      });
    });
  }

  async discover(sessionId: string, principal: SessionPrincipal) {
    return this.authority.run(sessionId, principal, {}, async () => {
      const binding = this.binding(sessionId, false);
      if (!binding) return null;
      const adapter = this.adapter(binding.adapter);
      assertApplicationAuthorized(adapter, this.scope(sessionId, binding));
      this.authority.assert(sessionId);
      return {
        adapter: binding.adapter,
        resource: binding.resource,
        operations: Object.entries(adapter.operations).map(([name, op]) => ({
          name,
          mode: op.mode,
        })),
      };
    });
  }

  async execute(sessionId: string, principal: SessionPrincipal, request: ApplicationRequest) {
    this.authority.assertPrincipal(sessionId, principal);
    const binding = this.binding(sessionId);
    const adapter = this.adapter(binding.adapter);
    const operation = Object.hasOwn(adapter.operations, request.operation)
      ? adapter.operations[request.operation]
      : undefined;
    if (!operation) throw new ControlError('INVALID_REQUEST', 'Unknown application operation');
    const write = operation.mode === 'write';
    if (
      write &&
      (!request.operationId ||
        !CONTROL_OPERATION_ID.test(request.operationId) ||
        typeof request.expectedVersion !== 'number' ||
        !Number.isSafeInteger(request.expectedVersion) ||
        request.expectedVersion < 0)
    )
      throw new ControlError(
        'INVALID_REQUEST',
        'Writes require an operation ID and expected version'
      );
    if (!write && (request.operationId !== undefined || request.expectedVersion !== undefined))
      throw new ControlError('INVALID_REQUEST', 'Read operations do not accept write identities');
    const serialized = canonicalJson(request.input);
    const input: unknown = JSON.parse(serialized);
    const fingerprint = write
      ? createHash('sha256')
          .update('application-operation:v1\0')
          .update(
            canonicalJson({
              ...binding,
              operation: request.operation,
              expectedVersion: request.expectedVersion,
            })
          )
          .update('\0')
          .update(serialized)
          .digest('hex')
      : undefined;
    let rejected = false;
    return this.authority.run(
      sessionId,
      principal,
      write && request.operationId && fingerprint ? { id: request.operationId, fingerprint } : {},
      async () => {
        const scope = this.scope(sessionId, binding, request);
        assertApplicationAuthorized(adapter, scope);
        this.authority.assert(sessionId);
        const execute = synchronousResult(operation.prepare(input));
        if (typeof execute !== 'function')
          throw new ControlError('INVALID_REQUEST', 'Invalid application preparation');
        assertApplicationAuthorized(adapter, scope);
        this.authority.assert(sessionId, write);
        const result = await execute(scope);
        rejected = result.status === 'rejected';
        if (!rejected && result.status !== (write ? 'committed' : 'read'))
          throw new Error('Application adapter returned an invalid result kind');
        return result;
      },
      () => (rejected ? 'rejected' : false)
    );
  }

  async lookupReceipt(sessionId: string, principal: SessionPrincipal, operationId: string) {
    assertReceiptId(operationId);
    return this.authority.run(sessionId, principal, {}, () =>
      this.readReceiptInScope(sessionId, operationId)
    );
  }

  /** Read-only composition inside an existing admission; never opens a second ticket. */
  async readReceiptInScope(sessionId: string, operationId: string, signal?: AbortSignal) {
    assertReceiptId(operationId);
    return this.prepareReceiptReadInScope(sessionId).read(operationId, signal);
  }

  /** Capture and validate a receipt binding before a caller dispatches its existing executor. */
  prepareReceiptReadInScope(sessionId: string): PreparedApplicationReceiptReader {
    const owner = this.captureReadInScope(sessionId);
    return Object.freeze({
      identity: owner.identity,
      assertAuthority: () => owner.assertAuthority(),
      read: async (operationId: string, signal?: AbortSignal) => {
        assertReceiptId(operationId);
        return owner.track((scope) => owner.adapter.receipt(scope, operationId), signal);
      },
    });
  }

  prepareReadInScope(
    sessionId: string,
    request: { operation: string; input: unknown }
  ): PreparedApplicationRead {
    // Capture the owner BEFORE inspecting any caller-controlled object or proxy.
    const owner = this.captureReadInScope(sessionId);
    let snapshot: unknown;
    try {
      snapshot = snapshotReadData(request);
    } catch {
      owner.assertAuthority();
      throw new ControlError('INVALID_REQUEST', 'Invalid application read request');
    }
    owner.assertAuthority();
    if (
      !snapshot ||
      typeof snapshot !== 'object' ||
      Array.isArray(snapshot) ||
      Object.keys(snapshot).length !== 2 ||
      !Object.hasOwn(snapshot, 'operation') ||
      !Object.hasOwn(snapshot, 'input')
    )
      throw new ControlError('INVALID_REQUEST', 'Invalid application read request');
    const pinned = snapshot as { operation: unknown; input: unknown };
    if (
      typeof pinned.operation !== 'string' ||
      !Object.hasOwn(owner.adapter.operations, pinned.operation)
    )
      throw new ControlError('INVALID_REQUEST', 'Invalid application read request');
    const operation = owner.adapter.operations[pinned.operation];
    if (!operation || operation.mode !== 'read')
      throw new ControlError('INVALID_REQUEST', 'Invalid application read request');
    const serialized = canonicalJson(pinned.input);
    owner.assertAuthority();
    return Object.freeze({
      identity: Object.freeze({ ...owner.identity, operation: pinned.operation }),
      assertAuthority: () => owner.assertAuthority(),
      read: async (signal?: AbortSignal) => {
        return owner.track(async (scope) => {
          const check = () => owner.assertAuthority(scope);
          let execute: ReturnType<ApplicationOperation['prepare']>;
          try {
            execute = synchronousResult(operation.prepare(JSON.parse(serialized)));
          } catch {
            check();
            throw new ControlError('INVALID_REQUEST', 'Application read callback failed');
          }
          check();
          if (typeof execute !== 'function')
            throw new ControlError('INVALID_REQUEST', 'Application read callback failed');
          let result: unknown;
          try {
            result = await execute(scope);
          } catch {
            check();
            throw new ControlError('INVALID_REQUEST', 'Application read callback failed');
          }
          check();
          let detached: unknown;
          try {
            detached = snapshotReadData(result);
          } catch {
            check();
            throw new ControlError('INVALID_REQUEST', 'Invalid application read result');
          }
          check();
          if (
            !detached ||
            typeof detached !== 'object' ||
            Array.isArray(detached) ||
            Object.keys(detached).length !== 2 ||
            !Object.hasOwn(detached, 'status') ||
            !Object.hasOwn(detached, 'value') ||
            (detached as { status: unknown }).status !== 'read'
          )
            throw new ControlError('INVALID_REQUEST', 'Invalid application read result');
          return (detached as { value: unknown }).value;
        }, signal);
      },
    });
  }

  /** Shared admission, binding, authorization and drain owner for prepared reads. */
  private captureReadInScope(sessionId: string) {
    const guard = this.authority.outputGuard(sessionId);
    const admission = this.authority.admissionInScope(sessionId);
    const binding = this.binding(sessionId);
    const adapter = this.adapter(binding.adapter);
    const ownedScope = this.scope(sessionId, binding);
    let revoked = false;
    const checkAuthority = (scope: ApplicationScope = ownedScope) => {
      if (revoked) throw new ControlError('CONTROL_REVOKED', 'Application receipt reader revoked');
      try {
        const checkAdmission = () => {
          guard();
          if (this.authority.admissionInScope(sessionId) !== admission)
            throw new ControlError('CONTROL_REQUIRED', 'Application receipt admission changed');
          if (scope.signal.aborted)
            throw new ControlError('CONTROL_REVOKED', 'Application receipt read cancelled');
          if (this.binding(sessionId) !== binding)
            throw new ControlError('CONTROL_REQUIRED', 'Application scope was revoked');
        };
        checkAdmission();
        assertApplicationAuthorized(adapter, scope);
        // Trusted callbacks can synchronously replace authority, bindings, or cancel the read.
        checkAdmission();
      } catch (error) {
        // A failed prepared capability cannot revive after a later permission regrant.
        revoked = true;
        throw error;
      }
    };
    checkAuthority();
    return {
      adapter,
      identity: Object.freeze({
        admission,
        adapter: binding.adapter,
        resource: binding.resource,
        sessionId,
        sessionIncarnation: ownedScope.sessionIncarnation,
      }),
      assertAuthority: checkAuthority,
      track: <T>(
        callback: (scope: ApplicationScope) => Promise<T>,
        signal?: AbortSignal
      ): Promise<T> => {
        const scope = signal
          ? Object.freeze({ ...ownedScope, signal: AbortSignal.any([ownedScope.signal, signal]) })
          : ownedScope;
        return this.authority.trackReadInScope(sessionId, async () => {
          checkAuthority(scope);
          const result = await callback(scope);
          checkAuthority(scope);
          return result;
        });
      },
    };
  }

  private scope(
    sessionId: string,
    binding: Binding,
    request?: ApplicationRequest
  ): ApplicationScope {
    return Object.freeze({
      sessionId,
      sessionIncarnation: this.authority.sessionIncarnation(sessionId),
      tenant: binding.tenant,
      resource: binding.resource,
      signal: this.authority.signal(sessionId),
      ...(request?.operationId !== undefined ? { operationId: request.operationId } : {}),
      ...(request?.expectedVersion !== undefined
        ? { expectedVersion: request.expectedVersion }
        : {}),
    });
  }
  private adapter(id: string): ApplicationAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new ControlError('CONTROL_REQUIRED', 'Application adapter unavailable');
    return adapter;
  }
  private binding(sessionId: string): Binding;
  private binding(sessionId: string, required: false): Binding | undefined;
  private binding(sessionId: string, required = true): Binding | undefined {
    const control = this.authority.get(sessionId);
    const binding = control && this.bindings.get(control);
    if (!binding && required) throw new ControlError('CONTROL_REQUIRED', 'No application binding');
    return binding;
  }
}

/** Independent in-process session composition; authentication belongs to its host. */
export class ApplicationSessions {
  readonly authority: SessionAuthority;
  private readonly sessions = new Map<
    string,
    { tenant: string; abort: AbortController; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly maxSessions: number;
  constructor(options: { maxSessions?: number; now?: () => number } = {}) {
    this.authority = new SessionAuthority(options);
    this.maxSessions = options.maxSessions ?? 100;
    if (!Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1 || this.maxSessions > 10000)
      throw new ControlError('INVALID_REQUEST', 'Invalid application session capacity');
  }
  create(principal: SessionPrincipal, options: { ttlMs?: number } = {}) {
    if (principal.actor !== 'operator' || !principal.tenant)
      throw new ControlError('CONTROL_REQUIRED', 'Authenticated operator required');
    const ttlMs = options.ttlMs ?? 30 * 60 * 1000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 12600000)
      throw new ControlError('INVALID_REQUEST', 'Invalid application session TTL');
    // Timers may be delayed by a busy event loop. Check deadlines before
    // declaring capacity exhausted, without scanning on every admission.
    if (this.sessions.size >= this.maxSessions)
      for (const id of this.sessions.keys()) if (!this.authority.get(id)) this.remove(id);
    if (this.sessions.size >= this.maxSessions)
      throw new ControlError('QUOTA_EXCEEDED', 'Application session capacity reached');
    const sessionId = randomUUID();
    const abort = new AbortController();
    const timer = setTimeout(() => this.remove(sessionId), ttlMs);
    timer.unref();
    this.sessions.set(sessionId, { tenant: principal.tenant, abort, timer });
    this.authority.register(sessionId, principal.tenant, abort.signal, {
      ttlMs,
      onExpire: () => this.remove(sessionId),
    });
    return { sessionId, ttlMs };
  }
  close(sessionId: string, principal: SessionPrincipal): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || principal.actor !== 'operator' || principal.tenant !== entry.tenant)
      throw new ControlError('CONTROL_REQUIRED', 'Application session authority does not match');
    this.remove(sessionId);
  }
  dispose(): void {
    for (const id of this.sessions.keys()) this.remove(id);
  }
  private remove(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.abort.abort();
    this.sessions.delete(sessionId);
  }
}
