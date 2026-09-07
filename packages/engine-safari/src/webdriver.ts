/**
 * Minimal W3C WebDriver client over a `safaridriver` child process.
 *
 * safaridriver (shipped with macOS) binds a local HTTP port and speaks the
 * W3C WebDriver protocol for the user's real Safari. One process serves one
 * WebDriver session; the engine isolates sessions by spawning one process
 * per session, so a crashed driver can never affect other sessions
 * (TD-BROWSER-7 robustness anchor).
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { EngineError, type ProtocolErrorCode } from '@agentbrowser/engine';

const DRIVER_CODES: Record<string, ProtocolErrorCode> = {
  'NO SUCH ELEMENT': 'TARGET_NOT_FOUND',
  'STALE ELEMENT REFERENCE': 'STALE_TARGET',
  'NO SUCH WINDOW': 'PAGE_NOT_FOUND',
  'INVALID SESSION ID': 'SESSION_NOT_FOUND',
  'INVALID ARGUMENT': 'INVALID_REQUEST',
  'UNKNOWN COMMAND': 'ENGINE_UNSUPPORTED',
  'UNSUPPORTED OPERATION': 'ENGINE_UNSUPPORTED',
  TIMEOUT: 'ACTION_TIMEOUT',
  'SCRIPT TIMEOUT': 'ACTION_TIMEOUT',
  SAFARIDRIVER_UNREACHABLE: 'ENGINE_CRASHED',
  SAFARIDRIVER_EXITED: 'ENGINE_CRASHED',
  SAFARIDRIVER_NOT_READY: 'ENGINE_UNSUPPORTED',
  SAFARIDRIVER_DISABLED: 'ENGINE_UNSUPPORTED',
};

export class SafaridriverError extends EngineError {
  constructor(
    readonly reason: string,
    message: string
  ) {
    super(DRIVER_CODES[reason] ?? 'INTERNAL', `${reason}: ${message}`, false, { reason });
    this.name = 'SafaridriverError';
  }
}

export interface WebDriverTransport {
  request<T = unknown>(path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown): Promise<T>;
  kill(): void;
}

/** One deadline covers connection, headers, body consumption and JSON decoding. */
export async function webdriverRequest<T = unknown>(
  url: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown,
  timeoutMs = 30_000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let payload: { value?: unknown } = {};
    if (text.trim()) {
      try {
        const decoded: unknown = JSON.parse(text);
        if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded))
          throw new Error('Expected object');
        payload = decoded;
      } catch {
        throw new SafaridriverError('INVALID_RESPONSE', 'Driver returned malformed JSON');
      }
    }
    const value = payload.value;
    if (
      value !== null &&
      typeof value === 'object' &&
      'error' in value &&
      typeof value.error === 'string'
    ) {
      const message =
        'message' in value && typeof value.message === 'string' ? value.message : value.error;
      throw new SafaridriverError(value.error.toUpperCase(), message);
    }
    if (!response.ok)
      throw new SafaridriverError('HTTP_ERROR', `Driver returned HTTP ${response.status}`);
    return value as T;
  } catch (error) {
    if (controller.signal.aborted)
      throw new SafaridriverError(
        'TIMEOUT',
        'Driver request deadline exceeded; an action may already have executed'
      );
    if (error instanceof EngineError) throw error;
    throw new SafaridriverError(
      'SAFARIDRIVER_UNREACHABLE',
      'Cannot communicate with the Safari driver'
    );
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function driver_waitReady(
  proc: ChildProcess,
  port: number,
  timeoutMs: number,
  spawnFailure: () => Error | undefined
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const failure = spawnFailure();
    if (failure) throw new SafaridriverError('SAFARIDRIVER_DISABLED', failure.message);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))),
      });
      await response.body?.cancel();
      if (response.ok) {
        return;
      }
    } catch {
      // not accepting yet
    }
    if (proc.exitCode !== null) {
      throw new SafaridriverError(
        'SAFARIDRIVER_EXITED',
        `safaridriver exited (code ${proc.exitCode})`
      );
    }
    await sleep(150);
  }
  throw new SafaridriverError(
    'SAFARIDRIVER_NOT_READY',
    'safaridriver did not become ready in time'
  );
}

export class SafaridriverProcess {
  private constructor(
    private readonly proc: ChildProcess,
    private readonly port: number
  ) {}

  /**
   * Spawn `safaridriver` on an explicit random port and wait for readiness.
   * safaridriver prints nothing on stdout, so the port is chosen up front
   * (ephemeral range) and readiness is polled over /status.
   */
  static async start(timeoutMs = 15_000): Promise<SafaridriverProcess> {
    const port = 49152 + Math.floor(Math.random() * 8_000);
    const proc = spawn('safaridriver', ['--port', String(port)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    proc.stderr?.resume();
    let spawnError: Error | undefined;
    proc.once('error', (error) => {
      spawnError = error;
    });

    const driver = new SafaridriverProcess(proc, port);
    try {
      await driver_waitReady(proc, port, timeoutMs, () => spawnError);
    } catch (error) {
      proc.kill();
      throw error;
    }
    return driver;
  }

  private url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  /**
   * W3C request. Resolves with the response's `value` member; rejects with a
   * SafaridriverError carrying the WebDriver error code on failures.
   */
  async request<T = unknown>(
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown
  ): Promise<T> {
    return webdriverRequest<T>(this.url(path), method, body);
  }

  kill(): void {
    this.proc.kill();
  }
}

export { sleep };
