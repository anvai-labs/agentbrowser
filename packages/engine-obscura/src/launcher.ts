/**
 * Obscura process launcher
 *
 * Spawns `obscura serve` on an ephemeral port and hands back the CDP
 * WebSocket endpoint. The endpoint comes from the server itself: Obscura
 * prints `CDP server: ws://host:port/devtools/browser` on startup (probe-
 * verified); HTTP /json/version discovery also works and serves as the
 * readiness check.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export interface ObscuraLaunchOptions {
  /** Path to the obscura binary (default: resolve via fetch script cache). */
  binary?: string;
  /** Fixed port; default: an OS-assigned ephemeral port. */
  port?: number;
  /** Listen host (default 127.0.0.1 - loopback only). */
  host?: string;
  /** Extra CLI args (e.g. --stealth, --workers 2). */
  args?: string[];
  /** Startup wait ceiling (default 15s). */
  readyTimeoutMs?: number;
}

export interface ObscuraServer {
  /** CDP WebSocket endpoint (the /devtools/browser form Obscura prints). */
  wsEndpoint: string;
  /** The child process handle. */
  process: ReturnType<typeof spawn>;
  /** HTTP base for CDP discovery (/json/version). */
  httpEndpoint: string;
  /** Kill the server and wait for exit. Idempotent. */
  stop(): Promise<void>;
}

/** Parse the `CDP server: ws://...` line Obscura prints at startup. */
const ENDPOINT_PATTERN = /CDP server:\s*(ws:\/\/\S+)/;

/**
 * Start an Obscura CDP server. Resolves when /json/version answers.
 */
export async function startObscura(options: ObscuraLaunchOptions = {}): Promise<ObscuraServer> {
  const binary = options.binary ?? resolveDefaultBinary();
  if (!existsSync(binary)) {
    throw new Error(
      `Obscura binary not found at ${binary}. Run 'node scripts/fetch.mjs' or set OBSCURA_BIN.`
    );
  }

  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? (await ephemeralPort());
  const args = ['serve', '--port', String(port), '--host', host, ...(options.args ?? [])];

  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  const httpEndpoint = `http://${host}:${port}`;

  // Ready = HTTP /json/version answers (probe-verified working).
  const deadline = Date.now() + (options.readyTimeoutMs ?? 15_000);
  let ready = false;
  let lastError = 'startup timeout';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Obscura exited during startup (code ${child.exitCode}): ${stdout.slice(-500)}`
      );
    }
    try {
      const response = await fetch(`${httpEndpoint}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        ready = true;
        break;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(150);
  }
  if (!ready) {
    child.kill();
    throw new Error(`Obscura did not become ready on ${httpEndpoint}: ${lastError}`);
  }

  // Prefer the exact endpoint Obscura prints; fall back to the discovery
  // URL shape if the banner line was missed.
  let wsEndpoint = ENDPOINT_PATTERN.exec(stdout)?.[1];
  if (wsEndpoint === undefined) {
    try {
      const version = (await (await fetch(`${httpEndpoint}/json/version`)).json()) as {
        webSocketDebuggerUrl?: string;
      };
      wsEndpoint = version.webSocketDebuggerUrl;
    } catch {
      // fall through
    }
  }
  if (wsEndpoint === undefined) {
    // Their documented bare form.
    wsEndpoint = `ws://${host}:${port}`;
  }

  let stopped = false;
  return {
    wsEndpoint,
    httpEndpoint,
    process: child,
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        const exited = new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
        });
        const race = await Promise.race([exited, delay(3000).then(() => 'timeout')]);
        if (race === 'timeout' && child.exitCode === null) {
          child.kill('SIGKILL');
          await exited.catch(() => undefined);
        }
      }
    },
  };
}

/** Locate the binary in the fetch-script cache layout. */
function resolveDefaultBinary(): string {
  const override = process.env.OBSCURA_BIN;
  if (override !== undefined && override !== '') {
    return override;
  }
  // .cache/obscura/<version>/obscura relative to the repo root (three
  // levels up from this package's dist/).
  const version = process.env.OBSCURA_VERSION ?? 'v0.2.1';
  const binName = process.platform === 'win32' ? 'obscura.exe' : 'obscura';
  return new URL(`../../../.cache/obscura/${version}/${binName}`, import.meta.url).pathname;
}

/** Ask the OS for a free TCP port (bind port 0, read it back, close). */
function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('failed to acquire ephemeral port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}
