/**
 * Managed subprocess server launcher
 *
 * Gives host applications embedded-style ergonomics - create, use, stop -
 * while keeping the browser service in its own process, per ADR-008. The
 * SDK spawns the API server as a supervised child, waits for it to become
 * healthy, and owns its shutdown.
 */

import { spawn } from 'node:child_process';
import { AgentBrowserClient } from './client.js';

export interface SubprocessLauncher {
  spawn(command: string, args: string[], env: Record<string, string>): SubprocessChild;
  /** Probe the server's health endpoint. */
  fetchOk(url: string): Promise<boolean>;
  delay(ms: number): Promise<void>;
}

export interface SubprocessChild {
  pid?: number;
  stdout: { on(event: string, fn: (chunk: unknown) => void): void };
  stderr: { on(event: string, fn: (chunk: unknown) => void): void };
  once(event: string, fn: (...args: unknown[]) => void): void;
  on(event: string, fn: (code: number | null) => void): void;
  killed: boolean;
  kill(): boolean;
}

export interface ManagedServer {
  /** Base URL the server is listening on. */
  readonly baseUrl: string;
  /** PID of the child, once spawned. */
  readonly pid?: number | undefined;
  /** A client pointed at the managed server. */
  readonly client: AgentBrowserClient;
  /** Whether the child is still expected to be alive. */
  isRunning(): boolean;
  /** Register a callback fired when the child exits unexpectedly. */
  onExit(callback: (info: { code: number | null; expected: boolean }) => void): void;
  /** Kill the child and stop supervision. Idempotent. */
  stop(): Promise<void>;
}

export interface ManagedServerOptions {
  /** Launch infrastructure; overridable for tests. */
  launcher?: SubprocessLauncher;
  clock?(): number;
  setInterval_?(fn: () => void, ms: number): unknown;
  clearInterval_?(id: unknown): void;
  port?: number;
  defaultPort?: number;
  /** How long to wait for the health endpoint, in ms. */
  startupTimeoutMs?: number;
  healthIntervalMs?: number;
  /** Extra args for the server entrypoint. */
  serverArgs?: string[];
}

/** How often the health monitor probes the child. */
const DEFAULT_HEALTH_INTERVAL_MS = 5_000;
/** How long to wait for the server to report healthy. */
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;

/**
 * Create and supervise an AgentBrowser server subprocess. Resolves once the
 * server is healthy.
 */
export async function createManagedServer(
  options: ManagedServerOptions = {}
): Promise<ManagedServer> {
  const launcher = options.launcher ?? defaultLauncher;
  const now = options.clock ?? Date.now;
  const setTimer = (fn: () => void, ms: number): unknown =>
    options.setInterval_ ? options.setInterval_(fn, ms) : setInterval(fn, ms);
  const clearTimer = (id: unknown): void => {
    if (options.clearInterval_) {
      options.clearInterval_(id);
    } else {
      clearInterval(id as ReturnType<typeof setInterval>);
    }
  };

  const port = options.port ?? options.defaultPort ?? 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port ${port}: expected an integer between 1 and 65535.`);
  }

  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const healthIntervalMs = options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
  const baseUrl = `http://127.0.0.1:${port}`;

  const child = launcher.spawn('node', options.serverArgs ?? ['dist/server.js'], {
    PORT: String(port),
    AGENTBROWSER_LOG: 'error',
  });

  let running = true;
  let healthTimer: unknown;
  const exitCallbacks: Array<(info: { code: number | null; expected: boolean }) => void> = [];

  const stopSupervision = () => {
    if (healthTimer !== undefined) {
      clearTimer(healthTimer);
      healthTimer = undefined;
    }
  };

  child.on('exit', (code) => {
    if (!running) {
      return; // deliberate stop; nobody needs telling
    }
    running = false;
    stopSupervision();
    for (const callback of [...exitCallbacks]) {
      callback({ code, expected: false });
    }
  });

  // Forward the child's stderr; its stdout is protocol noise here.
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[agentbrowser] ${chunk}`);
  });

  // Wait for the health endpoint before handing back a usable server.
  const healthy = await waitForHealth(
    () => launcher.fetchOk(`${baseUrl}/health`),
    () => launcher.delay(250),
    now,
    startupTimeoutMs
  );

  if (!healthy) {
    if (!child.killed) {
      child.kill();
    }
    running = false;
    stopSupervision();
    throw Object.assign(
      new Error(
        `SERVER_START_TIMEOUT: the AgentBrowser server did not report healthy on ${baseUrl} ` +
          `within ${startupTimeoutMs}ms. Check the child's stderr above.`
      ),
      { code: 'SERVER_START_TIMEOUT' }
    );
  }

  // Supervise: a health monitor that surfaces when the server stops answering,
  // even if it did not exit.
  const probe = async () => {
    if (!running) return;
    const ok = await launcher.fetchOk(`${baseUrl}/health`);
    if (!ok && running) {
      // Two strikes before declaring it unhealthy, to absorb a slow tick.
      const second = await launcher.fetchOk(`${baseUrl}/health`);
      if (!second && running) {
        running = false;
        stopSupervision();
        for (const callback of [...exitCallbacks]) {
          callback({ code: null, expected: false });
        }
      }
    }
  };
  healthTimer = setTimer(() => {
    void probe();
  }, healthIntervalMs);

  return {
    baseUrl,
    pid: child.pid,
    client: new AgentBrowserClient({ baseUrl }),
    isRunning: () => running,
    onExit(callback) {
      exitCallbacks.push(callback);
    },
    async stop() {
      if (!running && healthTimer === undefined) {
        return;
      }
      running = false;
      stopSupervision();
      if (!child.killed) {
        child.kill();
      }
    },
  };
}

async function waitForHealth(
  probeOnce: () => Promise<boolean>,
  delay: () => Promise<void>,
  now: () => number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (await probeOnce()) {
      return true;
    }
    if (now() >= deadline) {
      return false;
    }
    await delay();
  }
}

const defaultLauncher: SubprocessLauncher = {
  spawn(command, args, env) {
    return spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    }) as unknown as SubprocessChild;
  },
  async fetchOk(url) {
    try {
      const response = await fetch(url);
      return response.ok;
    } catch {
      return false;
    }
  },
  async delay(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  },
};
