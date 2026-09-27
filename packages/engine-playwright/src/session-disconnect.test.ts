import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

const driver = vi.hoisted(() => ({ connectOverCDP: vi.fn(), launch: vi.fn() }));
vi.mock('playwright', () => ({ chromium: driver }));

type Listener = (...args: never[]) => void;

function emitter() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    on: vi.fn((name: string, listener: Listener) => {
      const group = listeners.get(name) ?? new Set<Listener>();
      group.add(listener);
      listeners.set(name, group);
    }),
    off: vi.fn((name: string, listener: Listener) => listeners.get(name)?.delete(listener)),
    emit(name: string, ...args: never[]) {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(...args);
    },
    listenerCount(name: string) {
      return listeners.get(name)?.size ?? 0;
    },
  };
}

function page() {
  const events = emitter();
  let closed = false;
  return {
    ...events,
    opener: vi.fn().mockResolvedValue(null),
    setViewportSize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(async () => {
      if (closed) return;
      closed = true;
      events.emit('close');
    }),
    isClosed: vi.fn(() => closed),
    url: vi.fn().mockReturnValue('about:blank'),
    goto: vi.fn().mockResolvedValue(null),
    mainFrame: vi.fn(),
  };
}

function context() {
  const events = emitter();
  const pages: ReturnType<typeof page>[] = [];
  let closed = false;
  return {
    ...events,
    newPage: vi.fn(async () => {
      const created = page();
      pages.push(created);
      return created;
    }),
    close: vi.fn(async () => {
      if (closed) return;
      closed = true;
      events.emit('close');
    }),
    cookies: vi.fn().mockResolvedValue([]),
    addCookies: vi.fn().mockResolvedValue(undefined),
    pages: vi.fn(() => pages),
  };
}

function browser(contexts: ReturnType<typeof context>[] = []) {
  const events = emitter();
  let connected = true;
  const queued = [...contexts];
  return {
    ...events,
    newContext: vi.fn(async () => queued.shift() ?? context()),
    contexts: vi.fn(() => queued),
    close: vi.fn(async () => {
      if (!connected) return;
      connected = false;
      events.emit('disconnected');
    }),
    isConnected: vi.fn(() => connected),
    version: vi.fn().mockReturnValue('135.0.1'),
    disconnect() {
      if (!connected) return;
      connected = false;
      events.emit('disconnected');
    },
  };
}

const engines: PlaywrightChromiumEngine[] = [];
beforeEach(() => vi.resetAllMocks());
afterEach(async () => {
  await Promise.allSettled(engines.splice(0).map((engine) => engine.close()));
});

function shared(host: ReturnType<typeof browser>) {
  driver.launch.mockResolvedValue(host);
  const engine = new PlaywrightChromiumEngine();
  engines.push(engine);
  return engine;
}

describe('typed engine-session disconnect evidence', () => {
  it('fans shared browser loss to every session but scopes context loss to its owner', async () => {
    const firstContext = context();
    const secondContext = context();
    const host = browser([firstContext, secondContext]);
    const engine = shared(host);
    const first = await engine.createSession({ headless: true });
    const second = await engine.createSession({ headless: true });

    expect(first.disconnected?.aborted).toBe(false);
    expect(second.disconnected?.aborted).toBe(false);
    firstContext.emit('close');
    expect(first.disconnected?.aborted).toBe(true);
    expect(second.disconnected?.aborted).toBe(false);

    host.disconnect();
    expect(second.disconnected?.aborted).toBe(true);
  });

  it('disarms exact browser and context listeners before intentional close', async () => {
    const ownedContext = context();
    const host = browser([ownedContext]);
    const engine = shared(host);
    const session = await engine.createSession({ headless: true });
    const signal = session.disconnected;

    expect(host.listenerCount('disconnected')).toBe(1);
    expect(ownedContext.listenerCount('close')).toBe(1);
    expect(ownedContext.listenerCount('page')).toBe(1);
    await session.close('intentional');
    expect(signal?.aborted).toBe(false);
    expect(host.listenerCount('disconnected')).toBe(0);
    expect(ownedContext.listenerCount('close')).toBe(0);
    expect(ownedContext.listenerCount('page')).toBe(0);
  });

  it('shares cleanup when disconnect and caller close race', async () => {
    const ownedContext = context();
    const host = browser([ownedContext]);
    const engine = shared(host);
    const session = await engine.createSession({ headless: true });

    host.disconnect();
    const requested = session.close('caller');
    await requested;
    expect(session.disconnected?.aborted).toBe(true);
    expect(ownedContext.close).toHaveBeenCalledTimes(1);
  });

  it('releases a settled failed close owner so later cleanup can retry', async () => {
    const ownedContext = context();
    const failure = new Error('context close failed');
    ownedContext.close.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const host = browser([ownedContext]);
    const engine = shared(host);
    const session = await engine.createSession({ headless: true });

    const first = session.close('first');
    const concurrent = session.close('concurrent');
    await expect(Promise.all([first, concurrent])).rejects.toBe(failure);
    expect(ownedContext.close).toHaveBeenCalledTimes(1);
    await expect(session.close('retry')).resolves.toBeUndefined();
    expect(ownedContext.close).toHaveBeenCalledTimes(2);
  });

  it('keeps the session live when its last owned page closes', async () => {
    const ownedContext = context();
    const host = browser([ownedContext]);
    const engine = shared(host);
    const session = await engine.createSession({ headless: true });
    const first = await session.newPage();

    await first.close();
    expect(session.disconnected?.aborted).toBe(false);
    expect(await session.pages()).toEqual([]);
    await expect(session.newPage()).resolves.toBeDefined();
  });

  it('refuses an already disconnected allocation with fixed sanitized output', async () => {
    const ownedContext = context();
    const host = browser([ownedContext]);
    host.disconnect();
    const engine = shared(host);

    await expect(engine.createSession({ headless: true })).rejects.toMatchObject({
      code: 'ENGINE_CRASHED',
      message: 'Browser session disconnected during creation.',
    });
    expect(ownedContext.close).toHaveBeenCalledTimes(1);
    expect(host.listenerCount('disconnected')).toBe(0);
    expect(ownedContext.listenerCount('close')).toBe(0);
  });

  it('cleans the page listener when disconnect lands during session construction', async () => {
    const ownedContext = context();
    const host = browser([ownedContext]);
    const originalOn = ownedContext.on.getMockImplementation();
    ownedContext.on.mockImplementation((name: string, listener: Listener) => {
      originalOn?.(name, listener);
      if (name === 'page') host.disconnect();
    });
    const engine = shared(host);

    await expect(engine.createSession({ headless: true })).rejects.toMatchObject({
      code: 'ENGINE_CRASHED',
      message: 'Browser session disconnected during creation.',
    });
    expect(ownedContext.listenerCount('page')).toBe(0);
    expect(ownedContext.close).toHaveBeenCalledTimes(1);
  });

  it('removes observation listeners when later setup fails', async () => {
    const ownedContext = context();
    ownedContext.addCookies.mockRejectedValue(new Error('PRIVATE cookie setup failure'));
    const host = browser([ownedContext]);
    const engine = shared(host);

    await expect(
      engine.createSession({
        headless: true,
        cookies: [{ name: 'sid', value: 'x', domain: 'example.test', path: '/' }],
      })
    ).rejects.toThrow('PRIVATE cookie setup failure');
    expect(host.listenerCount('disconnected')).toBe(0);
    expect(ownedContext.listenerCount('close')).toBe(0);
  });
});
