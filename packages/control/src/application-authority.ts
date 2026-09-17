import { createHash, randomUUID } from 'node:crypto';
import { ControlError, type SessionControl } from '@agentbrowser/core';
import { CONTROL_OPERATION_ID } from '@agentbrowser/protocol';
import { canonicalJson } from './canonical-json.js';
import { SessionAuthority, type SessionPrincipal } from './session-authority.js';

export interface ApplicationScope {
  readonly sessionId: string;
  readonly sessionIncarnation: string;
  readonly tenant: string;
  readonly resource: string;
  readonly signal: AbortSignal;
  readonly operationId?: string;
  readonly expectedVersion?: number;
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
  return Object.freeze({
    mode: operation.mode,
    prepare(input: unknown) {
      const parsed = operation.parse(input);
      return (scope: ApplicationScope) => operation.execute(parsed, scope);
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

/** Opt-in trusted adapters. This port owns no browser, planner, network client or database. */
export class ApplicationAuthority {
  private readonly adapters = new Map<string, ApplicationAdapter>();
  private readonly bindings = new WeakMap<SessionControl, Binding>();

  constructor(
    private readonly authority: SessionAuthority,
    adapters: readonly ApplicationAdapter[] = []
  ) {
    for (const adapter of adapters) {
      if (!CONTROL_OPERATION_ID.test(adapter.id) || this.adapters.has(adapter.id))
        throw new ControlError('INVALID_REQUEST', 'Invalid or duplicate application adapter');
      this.adapters.set(adapter.id, {
        id: adapter.id,
        authorize: adapter.authorize.bind(adapter),
        receipt: adapter.receipt.bind(adapter),
        operations: Object.freeze({ ...adapter.operations }),
      });
    }
  }

  unbind(sessionId: string, principal: SessionPrincipal): void {
    this.authority.configure(sessionId, principal, () => {
      const control = this.authority.get(sessionId);
      if (control) this.bindings.delete(control);
    });
  }

  bind(sessionId: string, principal: SessionPrincipal, requested: ApplicationBinding): void {
    this.authority.configure(sessionId, principal, () => {
      const adapter = this.adapters.get(requested.adapter);
      if (
        !adapter ||
        !principal.tenant ||
        !CONTROL_OPERATION_ID.test(requested.resource) ||
        !adapter.authorize({ tenant: principal.tenant, resource: requested.resource })
      )
        throw new ControlError('CONTROL_REQUIRED', 'Application binding is not permitted');
      const control = this.authority.get(sessionId);
      if (!control) throw new ControlError('CONTROL_REVOKED', 'Session was removed');
      this.bindings.set(control, {
        adapter: adapter.id,
        resource: requested.resource,
        tenant: principal.tenant,
        generation: randomUUID(),
      });
    });
  }

  async discover(sessionId: string, principal: SessionPrincipal) {
    return this.authority.run(sessionId, principal, {}, async () => {
      const binding = this.binding(sessionId, false);
      if (!binding) return null;
      const adapter = this.adapter(binding.adapter);
      if (!adapter.authorize(this.scope(sessionId, binding)))
        throw new ControlError('CONTROL_REQUIRED', 'Application scope was revoked');
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
        if (!adapter.authorize(scope))
          throw new ControlError('CONTROL_REQUIRED', 'Application scope was revoked');
        const execute = operation.prepare(input);
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
    if (!CONTROL_OPERATION_ID.test(operationId))
      throw new ControlError('INVALID_REQUEST', 'Invalid receipt ID');
    return this.authority.run(sessionId, principal, {}, () =>
      this.readReceiptInScope(sessionId, operationId)
    );
  }

  /** Read-only composition inside an existing admission; never opens a second ticket. */
  async readReceiptInScope(sessionId: string, operationId: string, signal?: AbortSignal) {
    if (!CONTROL_OPERATION_ID.test(operationId))
      throw new ControlError('INVALID_REQUEST', 'Invalid receipt ID');
    const guard = this.authority.outputGuard(sessionId);
    const binding = this.binding(sessionId);
    const adapter = this.adapter(binding.adapter);
    const ownedScope = this.scope(sessionId, binding);
    const scope = signal
      ? Object.freeze({ ...ownedScope, signal: AbortSignal.any([ownedScope.signal, signal]) })
      : ownedScope;
    const checkAuthority = () => {
      guard();
      if (scope.signal.aborted)
        throw new ControlError('CONTROL_REVOKED', 'Application receipt read cancelled');
      if (this.binding(sessionId) !== binding || !adapter.authorize(scope))
        throw new ControlError('CONTROL_REQUIRED', 'Application scope was revoked');
      // Trusted authorization can synchronously revoke ownership or cancel the read.
      guard();
      if (scope.signal.aborted)
        throw new ControlError('CONTROL_REVOKED', 'Application receipt read cancelled');
    };
    checkAuthority();
    const receipt = await adapter.receipt(scope, operationId);
    checkAuthority();
    return receipt;
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
