/**
 * TDD Tests for the managed-subprocess launcher
 *
 * Gives host applications "embedded" ergonomics without putting the browser
 * in their process: the SDK spawns the API server as a supervised child and
 * owns its lifecycle (ADR-008 keeps the browser in a separate process).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagedServer } from './subprocess';
import type { SubprocessLauncher } from './subprocess';

describe('managed subprocess server', () => {
  let child: { exited: boolean; killed: boolean; code: number | null };
  let spawnCalls: Array<{ command: string; args: string[]; env: Record<string, string> }>;
  let launcher: SubprocessLauncher;
  let clock: { now: number };
  let timers: Array<() => void>;

  const startServer = () =>
    createManagedServer({
      launcher,
      clock: () => clock.now,
      setInterval_: (fn: () => void, ms: number) => {
        timers.push(fn);
        return timers.length - 1;
      },
      clearInterval_: (id: number) => {
        if (timers[id]) timers[id] = () => {};
      },
      defaultPort: 3990,
    });

  /** Advance the supervision clock and run every health tick. */
  const tick = async (ms: number) => {
    clock.now += ms;
    for (const run of [...timers]) await run();
  };

  beforeEach(() => {
    child = { exited: false, killed: false, code: null };
    spawnCalls = [];
    clock = { now: 1_000_000 };
    timers = [];

    launcher = {
      spawn: vi.fn().mockImplementation((command) => {
        spawnCalls.push({
          command,
          args: ['dist/server.js'],
          env: { PORT: '3990' },
        });
        return {
          pid: 4242,
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          once: vi.fn(),
          killed: false,
          kill: vi.fn().mockImplementation(() => {
            child.killed = true;
          }),
          on: vi.fn().mockImplementation((_event: string, fn: (code: number) => void) => {
            // capture exit handler so tests can simulate crash
            launcher._fireExit = fn;
          }),
        };
      }),
      fetchOk: vi.fn().mockResolvedValue(true),
      // A fake clock never advances on its own; waiting would hang forever.
      delay: vi.fn().mockImplementation(async (ms: number) => {
        clock.now += ms;
      }),
    } as unknown as SubprocessLauncher & { _fireExit?: (code: number) => void };
  });

  describe('lifecycle', () => {
    it('should spawn the server on start', async () => {
      const server = await startServer();

      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].command).toBe('node');
      expect(server.baseUrl).toBe('http://127.0.0.1:3990');
      expect(server.pid).toBe(4242);
    });

    it('should reject a custom port out of range', async () => {
      await expect(
        createManagedServer({
          launcher,
          clock: () => clock.now,
          setInterval_: () => 0,
          clearInterval_: () => {},
          port: 99999,
          defaultPort: 3990,
        })
      ).rejects.toThrow(/port/i);
    });

    it('should wait for the server to become healthy before resolving', async () => {
      let healthy = false;
      launcher.fetchOk = vi.fn().mockImplementation(async () => {
        // Sick on the first probe, healthy on the second.
        const was = healthy;
        healthy = true;
        return was;
      });

      const server = await startServer();

      expect(launcher.fetchOk).toHaveBeenCalledTimes(2);
      expect(server.baseUrl).toBeDefined();
    });

    it('should fail with a typed error if the server never becomes healthy', async () => {
      launcher.fetchOk = vi.fn().mockResolvedValue(false);

      await expect(startServer()).rejects.toThrow('SERVER_START_TIMEOUT');
    });
  });

  describe('supervision', () => {
    it('should report crash via onExit and stop reporting health', async () => {
      const server = await startServer();
      const onExit = vi.fn();
      server.onExit(onExit);

      launcher._fireExit?.(1);

      expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ code: 1, expected: false }));
      expect(server.isRunning()).toBe(false);
    });

    it('should not signal a crash on a deliberate stop', async () => {
      const server = await startServer();
      const onExit = vi.fn();
      server.onExit(onExit);

      await server.stop();
      launcher._fireExit?.(0);

      expect(onExit).not.toHaveBeenCalled();
      expect(server.isRunning()).toBe(false);
      expect(child.killed).toBe(true);
    });
  });

  describe('stop', () => {
    it('should kill the child process', async () => {
      const server = await startServer();
      await server.stop();

      expect(child.killed).toBe(true);
      expect(server.isRunning()).toBe(false);
    });

    it('should stop the health monitor', async () => {
      const server = await startServer();
      await server.stop();

      const fetchCount = (launcher.fetchOk as ReturnType<typeof vi.fn>).mock.calls.length;
      await tick(10_000);

      expect((launcher.fetchOk as ReturnType<typeof vi.fn>).mock.calls.length).toBe(fetchCount);
    });

    it('should be idempotent', async () => {
      const server = await startServer();
      await server.stop();
      await server.stop();

      expect(child.killed).toBe(true);
    });
  });

  describe('health monitor', () => {
    it('should probe health on the configured interval', async () => {
      await startServer();

      await tick(5_000);
      await tick(5_000);

      expect(
        (launcher.fetchOk as ReturnType<typeof vi.fn>).mock.calls.length
      ).toBeGreaterThanOrEqual(2);
    });

    it('should declare the server dead only after two consecutive failed probes', async () => {
      const server = await startServer();
      const onExit = vi.fn();
      server.onExit(onExit);
      (launcher.fetchOk as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      await tick(5_000);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onExit).toHaveBeenCalledWith({ code: null, expected: false });
      expect(server.isRunning()).toBe(false);
      await server.stop();
    });

    it('should absorb a single failed probe (two-strike rule)', async () => {
      const server = await startServer();
      const onExit = vi.fn();
      server.onExit(onExit);
      let probes = 0;
      (launcher.fetchOk as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        probes += 1;
        return probes > 1; // sick on the first probe, healthy afterwards
      });

      await tick(5_000);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onExit).not.toHaveBeenCalled();
      expect(server.isRunning()).toBe(true);
      await server.stop();
    });
  });

  describe('child plumbing', () => {
    it('should forward child stderr through the operator prefix', async () => {
      const server = await startServer();
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const spawnedChild = (launcher.spawn as ReturnType<typeof vi.fn>).mock.results[0]?.value as
          | { stderr: { on: ReturnType<typeof vi.fn> } }
          | undefined;
        expect(spawnedChild).toBeDefined();
        const stderrOn = spawnedChild?.stderr.on;
        expect(stderrOn).toHaveBeenCalledWith('data', expect.any(Function));
        const handler = stderrOn?.mock.calls[0]?.[1] as (chunk: unknown) => void;
        handler('health check failed\n');
        expect(write).toHaveBeenCalledWith('[agentbrowser] health check failed\n');
      } finally {
        write.mockRestore();
        await server.stop();
      }
    });

    it('should clear the real health interval on stop when no timer handles are injected', async () => {
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      const server = await createManagedServer({
        launcher,
        clock: () => clock.now,
        healthIntervalMs: 5,
        defaultPort: 3991,
      });
      expect(server.isRunning()).toBe(true);

      await server.stop();

      expect(clearIntervalSpy).toHaveBeenCalledWith(expect.anything());
      expect(server.isRunning()).toBe(false);
      clearIntervalSpy.mockRestore();
    });
  });

  describe('default launcher', () => {
    it('should time out with SERVER_START_TIMEOUT against a server that never comes up', async () => {
      // Real spawn, real fetch, real timers: node rejects the bogus flag
      // immediately, so nothing ever answers /health on the chosen port.
      await expect(
        createManagedServer({
          serverArgs: ['--definitely-not-a-real-agentbrowser-flag'],
          port: 46555,
          startupTimeoutMs: 80,
        })
      ).rejects.toMatchObject({ code: 'SERVER_START_TIMEOUT' });
    }, 20_000);

    it('should resolve once a real child reports healthy and support a clean stop', async () => {
      // The real default launcher end to end: a trivial loopback-only node
      // HTTP server stands in for the API server and answers /health.
      const port = 46556;
      const server = await createManagedServer({
        serverArgs: [
          '-e',
          `require('node:http').createServer((_q, s) => { s.end(JSON.stringify({ status: 'ok' })) }).listen(${port}, '127.0.0.1')`,
        ],
        port,
        startupTimeoutMs: 5_000,
      });
      try {
        expect(server.isRunning()).toBe(true);
        expect(server.baseUrl).toBe(`http://127.0.0.1:${port}`);
        expect(await server.client.health()).toEqual({ status: 'ok' });
      } finally {
        await server.stop();
      }
      expect(server.isRunning()).toBe(false);
    }, 20_000);
  });
});
