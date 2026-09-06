import { createServer } from 'node:http';
import { EngineError } from '@agentbrowser/engine';
import { describe, expect, it, vi } from 'vitest';
import { SafaridriverEngine } from './index.js';
import { type WebDriverTransport, webdriverRequest } from './webdriver.js';

function fixture() {
  const calls: Array<{ path: string; method: string }> = [];
  let handles = ['window-1'];
  let newPageError: Error | undefined;
  const driver: WebDriverTransport = {
    async request<T>(path: string, method: 'GET' | 'POST' | 'DELETE'): Promise<T> {
      calls.push({ path, method });
      let value: unknown;
      if (path === '/session') value = { sessionId: 'wd-1' };
      else if (path.endsWith('/window/new')) {
        if (newPageError) throw newPageError;
        value = { handle: 'window-1' };
      } else if (path.endsWith('/window/handles')) value = handles;
      else if (path.endsWith('/execute/sync'))
        value = { url: 'https://example.com/', title: 'Test', bodyText: 'Test', elements: [] };
      return value as T;
    },
    kill: vi.fn(),
  };
  const startDriver = vi.fn(async () => driver);
  return {
    calls,
    driver,
    startDriver,
    engine: new SafaridriverEngine({ startDriver }),
    setHandles: (value: string[]) => {
      handles = value;
    },
    failNewPage: (error: Error) => {
      newPageError = error;
    },
  };
}

describe('Safari deployment and lifecycle contract (mock transport)', () => {
  it('refuses policy-bearing sessions with a protocol code before starting a driver', async () => {
    const f = fixture();
    await expect(
      f.engine.createSession({ requestPolicy: { checkRequest: async () => {} } })
    ).rejects.toMatchObject({
      code: 'ENGINE_UNSUPPORTED',
      details: { reason: 'EGRESS_UNSUPPORTED' },
    });
    expect(f.startDriver).not.toHaveBeenCalled();
  });

  it('scopes execute to its session, closes event iterators, and rejects closed-page operations', async () => {
    const f = fixture();
    const session = await f.engine.createSession({});
    const page = await session.newPage();
    try {
      await page.observe({});
      expect(f.calls).toContainEqual({ path: '/session/wd-1/execute/sync', method: 'POST' });
      expect(f.calls.some(({ path }) => path === '/execute/sync')).toBe(false);
      const iterator = page.events()[Symbol.asyncIterator]();
      const pending = iterator.next();
      await page.close();
      await expect(pending).resolves.toMatchObject({ done: true });
      const count = f.calls.length;
      await expect(page.observe({})).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' });
      await page.close();
      expect(f.calls).toHaveLength(count);
    } finally {
      await f.engine.close();
    }
    expect(f.driver.kill).toHaveBeenCalledOnce();
  });

  it('reconciles externally closed windows and ends streams on engine shutdown', async () => {
    const f = fixture();
    const session = await f.engine.createSession({});
    const page = await session.newPage();
    const pending = page.events()[Symbol.asyncIterator]().next();
    f.setHandles([]);
    expect(await session.pages()).toEqual([]);
    await expect(pending).resolves.toMatchObject({ done: true });
    const next = await session.newPage();
    const nextPending = next.events()[Symbol.asyncIterator]().next();
    await f.engine.close();
    await expect(nextPending).resolves.toMatchObject({ done: true });
    await expect(session.newPage()).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  it('does not retry an ambiguously timed-out window creation', async () => {
    const f = fixture();
    const session = await f.engine.createSession({});
    try {
      f.failNewPage(new EngineError('ACTION_TIMEOUT', 'timeout'));
      await expect(session.newPage()).rejects.toMatchObject({ code: 'ACTION_TIMEOUT' });
      expect(f.calls.filter(({ path }) => path.endsWith('/window/new'))).toHaveLength(1);
      expect(f.calls.some(({ path }) => path.endsWith('/execute/sync'))).toBe(false);
    } finally {
      await f.engine.close();
    }
  });
});

describe('WebDriver whole-response deadline', () => {
  it.each(['slow-success', 'slow-error', 'malformed', 'typed-error', 'empty'])(
    'handles %s responses',
    async (mode) => {
      const server = createServer((_request, response) => {
        response.writeHead(
          mode === 'slow-error' || mode === 'typed-error' ? 500 : mode === 'empty' ? 204 : 200
        );
        if (mode.startsWith('slow')) {
          response.flushHeaders();
          return;
        }
        response.end(
          mode === 'malformed'
            ? '{'
            : mode === 'typed-error'
              ? JSON.stringify({ value: { error: 'no such element', message: 'Missing node' } })
              : undefined
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing fixture address');
        const request = webdriverRequest(
          `http://127.0.0.1:${address.port}/session/wd-1/execute/sync`,
          'POST',
          {},
          mode.startsWith('slow') ? 100 : 5000
        );
        if (mode === 'empty') await expect(request).resolves.toBeUndefined();
        else
          await expect(request).rejects.toMatchObject({
            code: mode.startsWith('slow')
              ? 'ACTION_TIMEOUT'
              : mode === 'typed-error'
                ? 'TARGET_NOT_FOUND'
                : 'INTERNAL',
            retryable: false,
          });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );
});
