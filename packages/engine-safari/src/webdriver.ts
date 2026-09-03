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

export class SafaridriverError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SafaridriverError';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function driver_waitReady(
  proc: ChildProcess,
  port: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
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
    proc.stderr?.on('data', (chunk: Buffer | string) => {
      // surfaced on failure paths only; safaridriver is silent when healthy
    });

    const driver = new SafaridriverProcess(proc, port);
    void driver;
    try {
      await driver_waitReady(proc, port, timeoutMs);
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
    let response: Response;
    try {
      response = await fetch(this.url(path), {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new SafaridriverError(
        'SAFARIDRIVER_UNREACHABLE',
        `request to safaridriver failed: ${String(error)}`
      );
    }

    let payload: { value?: unknown } = {};
    try {
      payload = (await response.json()) as { value?: unknown };
    } catch {
      // 204s and empty bodies are legal for several endpoints.
    }

    const value = payload.value;
    if (
      value !== null &&
      typeof value === 'object' &&
      typeof (value as { error?: unknown }).error === 'string'
    ) {
      const known = value as { error: string; message?: string; stacktrace?: string };
      throw new SafaridriverError(known.error.toUpperCase(), known.message ?? known.error);
    }
    if (!response.ok) {
      throw new SafaridriverError(
        'HTTP_ERROR',
        `safaridriver returned HTTP ${response.status} for ${path}`
      );
    }
    return value as T;
  }

  kill(): void {
    this.proc.kill();
  }
}

export { sleep };
