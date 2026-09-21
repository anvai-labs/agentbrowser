/**
 * Unit tests for the raw WebDriver transport and driver-process startup
 * (TD-BROWSER-7). No real safaridriver binary is launched: fetch is stubbed
 * for transport-level errors, and the child process is an EventEmitter fake
 * injected through a scoped mock of node:child_process.
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafaridriverError, SafaridriverProcess, webdriverRequest } from './webdriver.js';

/** Mutable spawn strategy, set per test (vi.mock factories hoist above lets). */
const childState = vi.hoisted(() => ({
  spawnImpl: null as null | (() => ChildProcess),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const impl = childState.spawnImpl;
      if (impl) {
        return impl();
      }
      return actual.spawn(...args);
    }) as typeof actual.spawn,
  };
});

/** A dead-simple fake driver process: events, exitCode, stderr, kill. */
function fakeChildProcess(overrides: { exitCode?: number | null } = {}): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess;
  (proc as { exitCode: number | null }).exitCode = overrides.exitCode ?? null;
  (proc as unknown as { stderr: { resume(): void } }).stderr = { resume: () => {} };
  proc.kill = vi.fn(() => true);
  return proc;
}

/** A fetch stub that always fails like a connection refused would. */
function stubUnreachableFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('fetch failed');
    })
  );
}

describe('webdriverRequest transport errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps a rejected connection to SAFARIDRIVER_UNREACHABLE (ENGINE_CRASHED)', async () => {
    stubUnreachableFetch();
    await expect(webdriverRequest('http://127.0.0.1:1/status', 'GET')).rejects.toMatchObject({
      code: 'ENGINE_CRASHED',
      retryable: false,
      reason: 'SAFARIDRIVER_UNREACHABLE',
      message: 'SAFARIDRIVER_UNREACHABLE: Cannot communicate with the Safari driver',
      details: { reason: 'SAFARIDRIVER_UNREACHABLE' },
    });
  });

  it('maps a deadline abort to TIMEOUT and never claims blind retry safety', async () => {
    // A faithful fetch stub: honoring the signal is what makes the abort
    // reject the pending body promise the way the real fetch does.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, init: { signal: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(new Error('This operation was aborted'))
            );
          })
      )
    );
    await expect(
      webdriverRequest('http://127.0.0.1:1/session', 'POST', {}, 10)
    ).rejects.toMatchObject({
      code: 'ACTION_TIMEOUT',
      retryable: false,
      reason: 'TIMEOUT',
      message: 'TIMEOUT: Driver request deadline exceeded; an action may already have executed',
    });
  });

  it('keeps typed driver errors intact instead of wrapping them as unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ value: { error: 'unknown command', message: 'nope' } }),
      }))
    );
    await expect(webdriverRequest('http://127.0.0.1:1/status', 'GET')).rejects.toMatchObject({
      code: 'ENGINE_UNSUPPORTED',
      reason: 'UNKNOWN COMMAND',
    });
  });
});

describe('SafaridriverProcess.start failure paths', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    childState.spawnImpl = null;
  });

  it('kills the driver and reports SAFARIDRIVER_DISABLED when the spawn fails', async () => {
    const proc = fakeChildProcess();
    childState.spawnImpl = () => proc;
    stubUnreachableFetch();
    setTimeout(() => proc.emit('error', new Error('spawn safaridriver ENOENT')), 0);

    const error = await SafaridriverProcess.start(5_000).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SafaridriverError);
    expect(error).toMatchObject({
      code: 'ENGINE_UNSUPPORTED',
      reason: 'SAFARIDRIVER_DISABLED',
    });
    expect((error as Error).message).toContain('spawn safaridriver ENOENT');
    expect(proc.kill).toHaveBeenCalled();
  });

  it('reports SAFARIDRIVER_NOT_READY and kills the driver when /status never answers', async () => {
    const proc = fakeChildProcess();
    childState.spawnImpl = () => proc;
    stubUnreachableFetch();

    await expect(SafaridriverProcess.start(30)).rejects.toMatchObject({
      code: 'ENGINE_UNSUPPORTED',
      reason: 'SAFARIDRIVER_NOT_READY',
      message: 'SAFARIDRIVER_NOT_READY: safaridriver did not become ready in time',
    });
    expect(proc.kill).toHaveBeenCalledOnce();
  });

  it('reports SAFARIDRIVER_EXITED with the child exit code', async () => {
    const proc = fakeChildProcess({ exitCode: 1 });
    childState.spawnImpl = () => proc;
    stubUnreachableFetch();

    await expect(SafaridriverProcess.start(5_000)).rejects.toMatchObject({
      code: 'ENGINE_CRASHED',
      reason: 'SAFARIDRIVER_EXITED',
    });
    const error = await SafaridriverProcess.start(5_000).catch((cause: unknown) => cause);
    expect((error as Error).message).toContain('exited (code 1)');
  });
});
