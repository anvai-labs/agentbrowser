import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, Socket, isIP } from 'node:net';
import { EngineError, type ProtocolErrorCode, type RequestPolicy } from '@agentbrowser/engine';
import { ErrorCode } from '@agentbrowser/protocol';

// Internal TCP ownership primitive. Intentionally not re-exported by api/index.
// No browser, HTTP, TLS, redirects, proxy or session integration lives here.
const MAX_TIMER_MS = 2_147_483_647;
const codes = new Set<string>(Object.values(ErrorCode));
type Stage = 'admission' | 'policy' | 'dns' | 'addressPolicy' | 'tcp' | 'lease';
type Endpoint = Readonly<{ address: string; family: 4 | 6; port: number }>;
export type ConnectionDestination = Readonly<{ url: string; hostname: string; port: number }>;
export interface ConnectionLease {
  readonly id: string;
  readonly socket: Socket;
  readonly destination: ConnectionDestination;
  readonly endpoint: Endpoint;
  readonly signal: AbortSignal;
  readonly closed: Promise<void>;
  close(): void;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function error(code: ProtocolErrorCode, stage: Stage, reason: string): EngineError {
  return new EngineError(code, 'Connection failed', false, { stage, reason });
}

// Preserve explicit protocol codes, never infer them from raw transport text or
// retain callback messages/details that can contain secrets or arbitrary data.
function safeFailure(cause: unknown, stage: Stage, reason: string): EngineError {
  const code = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
  return error(
    typeof code === 'string' && codes.has(code) ? (code as ProtocolErrorCode) : 'INTERNAL',
    stage,
    reason
  );
}

function positiveInteger(value: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw error('INVALID_REQUEST', 'admission', name);
  }
  return value;
}

function literal(input: unknown): { address: string; family: 4 | 6 } | undefined {
  if (typeof input !== 'string' || input.includes('%')) return undefined;
  const family = isIP(input);
  if (family !== 4 && family !== 6) return undefined;
  return {
    address: family === 6 ? new URL(`http://[${input}]/`).hostname.slice(1, -1) : input,
    family,
  };
}

function destinationOf(input: ConnectionDestination): ConnectionDestination {
  try {
    const url = new URL(input.url);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (
      /[\[\]]/.test(input.hostname) &&
      !(
        input.hostname.startsWith('[') &&
        input.hostname.endsWith(']') &&
        isIP(input.hostname.slice(1, -1)) === 6
      )
    ) {
      throw new Error('Invalid hostname brackets');
    }
    const suppliedHost = input.hostname.replace(/^\[|\]$/g, '');
    const normalized = literal(suppliedHost)?.address ?? suppliedHost.toLowerCase();
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      normalized !== hostname ||
      !Number.isInteger(input.port) ||
      input.port !== port ||
      port < 1 ||
      port > 65_535
    )
      throw new Error('Invalid destination');
    return Object.freeze({ url: url.href, hostname, port });
  } catch {
    throw error('INVALID_REQUEST', 'admission', 'invalidDestination');
  }
}

/** One budget per service runtime, shared across all session generations. */
export class ConnectionBudget {
  private count = 0;
  private readonly limit: number;
  constructor(limit = 32) {
    this.limit = positiveInteger(limit, 'maxRuntimeConnections');
  }
  get inUse(): number {
    return this.count;
  }
  reserve(): () => void {
    if (this.count >= this.limit) throw error('QUOTA_EXCEEDED', 'admission', 'runtimeCapacity');
    this.count += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.count -= 1;
      }
    };
  }
}

interface AuthorityOptions {
  // The trusted composition root supplies a fixed effective policy snapshot.
  // Capturing bound methods does not freeze arbitrary callback closure state.
  policy: RequestPolicy;
  budget: ConnectionBudget;
  maxConnections?: number;
  maxDnsAnswers?: number;
  setupTimeoutMs?: number;
}
interface Dependencies {
  resolve(hostname: string): Promise<Array<{ address: string; family: number }>>;
  // Trusted, synchronous construction of an unconnected socket; not a caller port.
  createSocket(): Socket;
}
interface ConnectOptions {
  signal?: AbortSignal;
  deadline: number;
}
interface AttemptOptions {
  destination: ConnectionDestination;
  caller: ConnectOptions;
  setupTimeoutMs: number;
  maxDnsAnswers: number;
  checkRequest: RequestPolicy['checkRequest'];
  checkAddresses: NonNullable<RequestPolicy['checkResolvedAddresses']>;
  dependencies: Dependencies;
  drained(): void;
}

/** One instance is one revocable session generation; it never reopens. */
export class ConnectionAuthority {
  private readonly attempts = new Set<ConnectionAttempt>();
  private readonly drain = deferred<void>();
  private readonly maxConnections: number;
  private readonly maxDnsAnswers: number;
  private readonly setupTimeoutMs: number;
  private readonly budget: ConnectionBudget;
  private readonly checkRequest: RequestPolicy['checkRequest'];
  private readonly checkAddresses: NonNullable<RequestPolicy['checkResolvedAddresses']>;
  private readonly dependencies: Dependencies;
  private revoked: EngineError | undefined;
  readonly closed = this.drain.promise;

  constructor(options: AuthorityOptions, dependencies: Partial<Dependencies> = {}) {
    if (
      typeof options.policy?.checkRequest !== 'function' ||
      typeof options.policy.checkResolvedAddresses !== 'function'
    ) {
      throw error('ENGINE_UNSUPPORTED', 'admission', 'strictPolicyRequired');
    }
    this.maxConnections = positiveInteger(options.maxConnections ?? 8, 'maxConnections');
    this.maxDnsAnswers = positiveInteger(options.maxDnsAnswers ?? 16, 'maxDnsAnswers');
    this.setupTimeoutMs = positiveInteger(
      options.setupTimeoutMs ?? 10_000,
      'setupTimeoutMs',
      MAX_TIMER_MS
    );
    this.budget = options.budget;
    this.checkRequest = options.policy.checkRequest.bind(options.policy);
    this.checkAddresses = options.policy.checkResolvedAddresses.bind(options.policy);
    this.dependencies = Object.freeze({
      resolve: dependencies.resolve ?? ((hostname: string) => lookup(hostname, { all: true })),
      createSocket: dependencies.createSocket ?? (() => new Socket()),
    });
  }

  async connect(input: ConnectionDestination, caller: ConnectOptions): Promise<ConnectionLease> {
    if (this.revoked) throw this.revoked;
    if (caller.signal?.aborted)
      throw safeFailure(caller.signal.reason, 'admission', 'callerCancelled');
    if (!Number.isFinite(caller.deadline) || caller.deadline - performance.now() > MAX_TIMER_MS) {
      throw error('INVALID_REQUEST', 'admission', 'invalidDeadline');
    }
    if (caller.deadline <= performance.now())
      throw error('ACTION_TIMEOUT', 'admission', 'deadline');
    const destination = destinationOf(input);
    if (this.attempts.size >= this.maxConnections)
      throw error('QUOTA_EXCEEDED', 'admission', 'authorityCapacity');
    const release = this.budget.reserve();
    const attempt = new ConnectionAttempt({
      destination,
      caller: { ...caller },
      setupTimeoutMs: this.setupTimeoutMs,
      maxDnsAnswers: this.maxDnsAnswers,
      checkRequest: this.checkRequest,
      checkAddresses: this.checkAddresses,
      dependencies: this.dependencies,
      drained: () => {
        release();
        this.attempts.delete(attempt);
        this.checkDrained();
      },
    });
    this.attempts.add(attempt);
    attempt.start();
    const lease = await attempt.ready;
    // Cancellation can occur after synchronous connect/verification but before
    // this continuation hands the lease to its caller.
    attempt.assertActive();
    return lease;
  }

  revoke(reason?: unknown): void {
    if (this.revoked) return;
    this.revoked = safeFailure(reason, 'admission', 'authorityRevoked');
    for (const attempt of this.attempts) attempt.stop(this.revoked);
    this.checkDrained();
  }

  private checkDrained(): void {
    if (this.revoked && this.attempts.size === 0) this.drain.resolve();
  }
}

class ConnectionAttempt {
  private readonly result = deferred<ConnectionLease>();
  private readonly drain = deferred<void>();
  private readonly controller = new AbortController();
  private readonly setupDeadline: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private socket: Socket | undefined;
  private endpoint: Endpoint | undefined;
  private workSettled = false;
  private socketClosed = true;
  private drained = false;
  private delivered = false;
  private terminal: EngineError | undefined;
  private stage: Stage = 'policy';
  readonly ready = this.result.promise;

  constructor(private readonly options: AttemptOptions) {
    this.setupDeadline = performance.now() + options.setupTimeoutMs;
  }

  start(): void {
    this.options.caller.signal?.addEventListener('abort', this.onAbort, { once: true });
    if (this.options.caller.signal?.aborted) this.onAbort();
    this.schedule();
    void this.run();
  }

  private activeDeadline(): number {
    return this.delivered
      ? this.options.caller.deadline
      : Math.min(this.setupDeadline, this.options.caller.deadline);
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.terminal) return;
    this.timer = setTimeout(
      () => {
        try {
          this.assertActive();
          this.schedule();
        } catch {
          /* stop owns completion */
        }
      },
      Math.max(1, Math.ceil(this.activeDeadline() - performance.now()))
    );
  }

  assertActive(): void {
    if (this.terminal) throw this.terminal;
    if (performance.now() >= this.activeDeadline()) {
      this.stop(error('ACTION_TIMEOUT', this.stage, 'deadline'));
      throw this.terminal;
    }
  }

  private onAbort = (): void => {
    this.stop(safeFailure(this.options.caller.signal?.reason, this.stage, 'callerCancelled'));
  };

  private async external<T>(stage: Stage, action: () => Promise<T>): Promise<T> {
    this.stage = stage;
    this.assertActive();
    try {
      return await action();
    } catch (cause) {
      throw safeFailure(cause, stage, 'callbackFailure');
    }
  }

  private async run(): Promise<void> {
    try {
      const { destination, dependencies } = this.options;
      await this.external('policy', () =>
        this.options.checkRequest({
          hostname: new URL(destination.url).hostname,
          url: destination.url,
        })
      );
      this.assertActive();
      const ip = literal(destination.hostname);
      const answers = ip
        ? [ip]
        : await this.external('dns', () => dependencies.resolve(destination.hostname));
      this.assertActive();
      if (
        !Array.isArray(answers) ||
        answers.length === 0 ||
        answers.length > this.options.maxDnsAnswers
      ) {
        throw error('POLICY_DENIED', 'dns', 'invalidAnswers');
      }
      const validated = Array.from(answers, (answer) => {
        const parsed = literal(answer?.address);
        if (!parsed || parsed.family !== answer?.family)
          throw error('POLICY_DENIED', 'dns', 'invalidAnswers');
        return Object.freeze(parsed);
      });
      await this.external('addressPolicy', () =>
        this.options.checkAddresses(validated.map((entry) => entry.address))
      );
      this.assertActive();
      const selected = validated[0];
      if (!selected) throw error('POLICY_DENIED', 'dns', 'invalidAnswers');
      this.endpoint = Object.freeze({ ...selected, port: destination.port });
      this.stage = 'tcp';
      this.socket = dependencies.createSocket();
      this.socketClosed = false;
      this.socket.on('error', this.onError);
      this.socket.once('close', this.onClose);
      this.socket.once('connect', this.onConnect);
      this.assertActive();
      this.socket.connect({
        host: selected.address,
        port: destination.port,
        family: selected.family,
        autoSelectFamily: false,
      });
    } catch (cause) {
      this.stop(
        cause instanceof EngineError ? cause : safeFailure(cause, this.stage, 'transportFailure')
      );
    } finally {
      this.workSettled = true;
      this.checkDrained();
    }
  }

  private onConnect = (): void => {
    try {
      this.assertActive();
      const { socket, endpoint } = this;
      const peer = literal(socket?.remoteAddress);
      if (!socket || !endpoint || !peer || socket.remotePort !== endpoint.port) {
        throw error('POLICY_DENIED', 'tcp', 'peerMismatch');
      }
      const selected = new BlockList();
      selected.addAddress(endpoint.address, endpoint.family === 4 ? 'ipv4' : 'ipv6');
      if (!selected.check(peer.address, peer.family === 4 ? 'ipv4' : 'ipv6')) {
        throw error('POLICY_DENIED', 'tcp', 'peerMismatch');
      }
      this.assertActive();
      this.delivered = true;
      this.stage = 'lease';
      this.schedule();
      this.result.resolve(
        Object.freeze({
          id: randomUUID(),
          socket,
          endpoint,
          destination: this.options.destination,
          signal: this.controller.signal,
          closed: this.drain.promise,
          close: () => this.stop(error('INTERNAL', 'lease', 'leaseClosed')),
        })
      );
    } catch (cause) {
      this.stop(
        cause instanceof EngineError ? cause : safeFailure(cause, 'tcp', 'transportFailure')
      );
    }
  };

  private onError = (cause: Error): void => {
    this.stop(safeFailure(cause, this.stage, 'transportFailure'));
  };

  private onClose = (): void => {
    this.socketClosed = true;
    if (!this.terminal) this.stop(error('INTERNAL', this.stage, 'socketClosed'));
    this.checkDrained();
  };

  stop(reason: EngineError): void {
    if (!this.terminal) {
      this.terminal = reason;
      clearTimeout(this.timer);
      this.options.caller.signal?.removeEventListener('abort', this.onAbort);
      this.result.reject(reason);
      this.controller.abort(reason);
    }
    this.socket?.destroy();
    this.checkDrained();
  }

  private checkDrained(): void {
    if (this.drained || !this.terminal || !this.workSettled || !this.socketClosed) return;
    this.drained = true;
    this.socket?.removeListener('error', this.onError);
    this.socket?.removeListener('close', this.onClose);
    this.socket?.removeListener('connect', this.onConnect);
    this.options.drained();
    this.drain.resolve();
  }
}
