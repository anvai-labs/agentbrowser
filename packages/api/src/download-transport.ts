import { randomUUID } from 'node:crypto';
import { type ClientRequest, type IncomingMessage, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { Transform } from 'node:stream';
import { type TLSSocket, connect as connectTls } from 'node:tls';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import {
  EngineError,
  type ProtocolErrorCode,
  type RequestPolicy,
  normalizeEngineError,
} from '@agentbrowser/engine';
import {
  ConnectionAuthority,
  ConnectionBudget,
  type SessionTcpAdmission,
} from './connection-authority.js';

export interface DownloadOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}
/** Trusted test fetcher port; no socket types cross the service surface. */
export interface DownloadTransportOptions extends DownloadOptions {
  policy: RequestPolicy;
}
type Payload = { bytes: Uint8Array; contentType: string };
type Stage = 'admission' | 'connect' | 'tls' | 'headers' | 'response' | 'redirect' | 'body';
export interface DownloadOutcome {
  generation: string;
  transferId: string;
  connectionId?: string;
  stage: Stage;
  outcome: 'ok' | 'error';
  code?: ProtocolErrorCode;
}
function safeError(cause: unknown, stage: Stage): EngineError {
  const code = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
  return new EngineError(
    normalizeEngineError({ code, message: 'Download failed' }).code,
    'Download failed',
    false,
    { stage, reason: 'transferFailed' }
  );
}

/** Shared by every session generation. Bound callback work separately from TCP. */
export class DownloadBudget {
  readonly connections: ConnectionBudget;
  readonly transfers: ConnectionBudget;
  constructor(limit = 32) {
    this.connections = new ConnectionBudget(limit);
    this.transfers = new ConnectionBudget(limit);
  }
}
interface TransportOwner {
  policy: RequestPolicy;
  budget: DownloadBudget;
  admission?: SessionTcpAdmission;
  maxConnections?: number;
  signal?: AbortSignal;
  onOutcome?(outcome: DownloadOutcome): void;
  onCleanupFailure?(fields: {
    generation: string;
    transferId: string;
    connectionId: string;
    reason: 'resourceCloseFailed';
  }): void;
}
interface TransportDependencies {
  resolve?(hostname: string): Promise<Array<{ address: string; family: number }>>;
  /** Fixture-local trust only, never supplied by an API request. */
  ca?: string;
  fetch?(url: string, options: DownloadTransportOptions): Promise<Payload>;
}

/** Private, single-generation HTTP caller over the verified TCP authority. */
export class DownloadTransport {
  private readonly authority: ConnectionAuthority;
  private readonly cancellation = new AbortController();
  private readonly local: ConnectionBudget;
  private readonly generation = randomUUID();
  private readonly policy: RequestPolicy;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly owner: TransportOwner,
    private readonly dependencies: TransportDependencies = {}
  ) {
    const policy = owner.policy;
    if (
      typeof policy?.checkRequest !== 'function' ||
      typeof policy.checkResolvedAddresses !== 'function'
    )
      throw new EngineError('ENGINE_UNSUPPORTED', 'Downloads require a strict policy');
    // Capture method identity; the composition root owns immutable behavior.
    this.policy = Object.freeze({
      checkRequest: policy.checkRequest.bind(policy),
      ...(policy.checkResolvedAddresses
        ? { checkResolvedAddresses: policy.checkResolvedAddresses.bind(policy) }
        : {}),
      ...(policy.checkResponse ? { checkResponse: policy.checkResponse.bind(policy) } : {}),
      ...(policy.checkRedirectChain
        ? { checkRedirectChain: policy.checkRedirectChain.bind(policy) }
        : {}),
      ...(policy.checkBodySize ? { checkBodySize: policy.checkBodySize.bind(policy) } : {}),
    });
    this.local = new ConnectionBudget(owner.maxConnections ?? 8);
    this.authority = new ConnectionAuthority(
      {
        policy: this.policy,
        admission:
          owner.admission ?? owner.budget.connections.createSessionScope(owner.maxConnections ?? 8),
        ...(owner.maxConnections !== undefined ? { maxConnections: owner.maxConnections } : {}),
      },
      dependencies.resolve ? { resolve: dependencies.resolve } : {}
    );
    const abort = () => this.revoke(owner.signal?.reason);
    owner.signal?.addEventListener('abort', abort, { once: true });
    this.unsubscribe = () => owner.signal?.removeEventListener('abort', abort);
    if (owner.signal?.aborted) abort();
  }

  revoke(reason?: unknown): void {
    if (this.cancellation.signal.aborted) return;
    const failure = safeError(reason, 'admission');
    this.cancellation.abort(failure);
    this.authority.revoke(failure);
    this.unsubscribe();
  }

  async download(url: string, input: DownloadOptions): Promise<Payload> {
    const options = { ...input };
    const timeoutMs = options.timeoutMs ?? 30_000;
    const maxRedirects = options.maxRedirects ?? 10;
    const transferId = randomUUID();
    let stage: Stage = 'admission';
    let connectionId: string | undefined;
    const report = (failure?: EngineError) => {
      try {
        this.owner.onOutcome?.({
          generation: this.generation,
          transferId,
          ...(connectionId ? { connectionId } : {}),
          stage,
          outcome: failure ? 'error' : 'ok',
          ...(failure ? { code: failure.code } : {}),
        });
      } catch {
        /* A diagnostic sink cannot change a transport outcome. */
      }
    };
    let release: (() => void) | undefined;
    let releaseGlobal: (() => void) | undefined;
    try {
      if (
        !Number.isSafeInteger(options.maxBytes) ||
        options.maxBytes < 1 ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 2_147_483_647 ||
        !Number.isSafeInteger(maxRedirects) ||
        maxRedirects < 0 ||
        maxRedirects > 100
      )
        throw new EngineError('INVALID_REQUEST', 'Invalid download limits');
      this.cancellation.signal.throwIfAborted();
      options.signal?.throwIfAborted();
      release = this.local.reserve();
      releaseGlobal = this.owner.budget.transfers.reserve();
    } catch (cause) {
      release?.();
      const failure = safeError(cause, stage);
      report(failure);
      throw failure;
    }
    const controller = new AbortController();
    const deadline = performance.now() + timeoutMs;
    const cancelOwner = () => controller.abort(this.cancellation.signal.reason);
    const cancelCaller = () => controller.abort(safeError(options.signal?.reason, stage));
    this.cancellation.signal.addEventListener('abort', cancelOwner, { once: true });
    options.signal?.addEventListener('abort', cancelCaller, { once: true });
    const timer = setTimeout(
      () => controller.abort(new EngineError('ACTION_TIMEOUT', 'Download deadline exceeded')),
      timeoutMs
    );
    const active = () => {
      controller.signal.throwIfAborted();
      if (performance.now() >= deadline) {
        controller.abort(new EngineError('ACTION_TIMEOUT', 'Download deadline exceeded'));
        controller.signal.throwIfAborted();
      }
    };
    let rejectAbort!: (cause: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (this.cancellation.signal.aborted) cancelOwner();
    if (options.signal?.aborted) cancelCaller();

    const transfer = async (): Promise<Payload> => {
      let current: URL;
      try {
        current = new URL(url);
      } catch {
        throw new EngineError('INVALID_REQUEST', 'Invalid download URL');
      }
      const visited = new Set<string>();
      const redirects: Array<{ url: string; hostname: string }> = [];
      for (let hop = 0; ; hop += 1) {
        active();
        if (hop > maxRedirects || visited.has(current.href))
          throw new EngineError('POLICY_DENIED', 'Download redirect limit or loop');
        visited.add(current.href);
        if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password)
          throw new EngineError('POLICY_DENIED', 'Downloads require http(s) without credentials');
        if (this.dependencies.fetch) {
          await this.policy.checkRequest({ hostname: current.hostname, url: current.href });
          active();
          const result = await this.dependencies.fetch(current.href, {
            ...options,
            policy: this.policy,
            signal: controller.signal,
          });
          active();
          return result;
        }
        stage = 'connect';
        const lease = await this.authority.connect(
          {
            kind: 'request',
            url: current.href,
            hostname: current.hostname,
            port: Number(current.port || (current.protocol === 'https:' ? 443 : 80)),
          },
          { signal: controller.signal, deadline }
        );
        connectionId = lease.id;
        let response: IncomingMessage | undefined;
        let request: ClientRequest | undefined;
        let tls: TLSSocket | undefined;
        let decoder: Transform | undefined;
        // Raw TCP can close normally while buffered bytes still await decoding.
        const abortIO = () => {
          for (const close of [
            () => request?.destroy(),
            () => response?.destroy(),
            () => decoder?.destroy(),
            () => tls?.destroy(),
            () => lease.close(),
          ]) {
            try {
              close();
            } catch {
              try {
                this.owner.onCleanupFailure?.({
                  generation: this.generation,
                  transferId,
                  connectionId: lease.id,
                  reason: 'resourceCloseFailed',
                });
              } catch {
                /* Diagnostics never replace the terminal outcome. */
              }
            }
          }
        };
        controller.signal.addEventListener('abort', abortIO, { once: true });
        try {
          active();
          let socket = lease.socket;
          if (current.protocol === 'https:') {
            stage = 'tls';
            const hostname = lease.destination.hostname;
            tls = connectTls({
              socket,
              host: hostname,
              ...(isIP(hostname) ? {} : { servername: hostname }),
              ...(this.dependencies.ca ? { ca: this.dependencies.ca } : {}),
            });
            tls.on('error', () => {});
            await new Promise<void>((resolve, reject) => {
              const done = (error?: Error) => {
                tls?.removeListener('secureConnect', secure);
                tls?.removeListener('error', failed);
                tls?.removeListener('close', closed);
                error ? reject(error) : resolve();
              };
              const secure = () => done();
              const failed = (error: Error) => done(error);
              const closed = () => done(new EngineError('INTERNAL', 'TLS closed'));
              tls?.once('secureConnect', secure);
              tls?.once('error', failed);
              tls?.once('close', closed);
            });
            active();
            socket = tls;
          }
          stage = 'headers';
          response = await new Promise<IncomingMessage>((resolve, reject) => {
            // agent:false creates a default Agent and bypasses createConnection.
            request = (current.protocol === 'https:' ? httpsRequest : httpRequest)(
              current,
              {
                createConnection: () => socket,
                signal: controller.signal,
                headers: { 'accept-encoding': 'identity', connection: 'close' },
              },
              resolve
            );
            request.once('error', reject);
            request.end();
          });
          response.on('error', () => {});
          stage = 'response';
          const headers = Object.fromEntries(
            Object.entries(response.headers)
              .filter((entry) => entry[1] !== undefined)
              .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)])
          );
          await this.policy.checkResponse?.({ headers });
          active();
          if (response.destroyed && !response.complete)
            throw new EngineError('INTERNAL', 'Incomplete download response');
          const status = response.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
            stage = 'redirect';
            current = new URL(response.headers.location, current);
            redirects.push({ url: current.href, hostname: current.hostname });
            await this.policy.checkRedirectChain?.(redirects);
            active();
            continue;
          }
          if (status < 200 || status >= 300)
            throw new EngineError('INTERNAL', 'Download HTTP status failure');
          const declared = Number(response.headers['content-length']);
          if (Number.isFinite(declared) && declared > options.maxBytes)
            throw new EngineError('DOWNLOAD_BLOCKED', 'Download exceeds the session byte limit');
          stage = 'body';
          const encoding = response.headers['content-encoding']?.toLowerCase();
          decoder =
            encoding === 'gzip'
              ? createGunzip()
              : encoding === 'deflate'
                ? createInflate()
                : encoding === 'br'
                  ? createBrotliDecompress()
                  : undefined;
          if (encoding && encoding !== 'identity' && !decoder)
            throw new EngineError('DOWNLOAD_BLOCKED', 'Unsupported download content encoding');
          let encodedSize = 0;
          const countEncoded = (chunk: Buffer) => {
            encodedSize += chunk.byteLength;
            if (encodedSize > options.maxBytes) {
              const failure = new EngineError(
                'DOWNLOAD_BLOCKED',
                'Encoded download exceeds the session byte limit'
              );
              // Decoder errors alone can sit behind an awaited body-policy
              // callback. Stop all I/O now; callback admission drains later.
              controller.abort(failure);
            }
          };
          response.on('data', countEncoded);
          const stream = decoder ? response.pipe(decoder) : response;
          const failed = (error: Error) => decoder?.destroy(error);
          response.on('error', failed);
          const chunks: Buffer[] = [];
          let size = 0;
          try {
            for await (const chunk of stream) {
              active();
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              size += bytes.byteLength;
              if (size > options.maxBytes)
                throw new EngineError(
                  'DOWNLOAD_BLOCKED',
                  'Download exceeds the session byte limit'
                );
              await this.policy.checkBodySize?.(size);
              active();
              chunks.push(bytes);
            }
            active();
            return {
              bytes: Buffer.concat(chunks, size),
              contentType: headers['content-type'] ?? 'application/octet-stream',
            };
          } finally {
            response.removeListener('data', countEncoded);
            response.removeListener('error', failed);
            decoder?.destroy();
          }
        } finally {
          controller.signal.removeEventListener('abort', abortIO);
          abortIO();
          await lease.closed;
        }
      }
    };
    // Keep cancelled callback reservations until their actual continuation settles.
    const work = transfer().finally(() => {
      release?.();
      releaseGlobal?.();
    });
    try {
      const result = await Promise.race([work, aborted]);
      active();
      report();
      return result;
    } catch (cause) {
      const failure = safeError(
        controller.signal.aborted ? controller.signal.reason : cause,
        stage
      );
      report(failure);
      throw failure;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      this.cancellation.signal.removeEventListener('abort', cancelOwner);
      options.signal?.removeEventListener('abort', cancelCaller);
    }
  }
}
