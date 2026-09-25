import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

const driver = vi.hoisted(() => ({ launch: vi.fn(), connectOverCDP: vi.fn() }));
vi.mock('playwright', () => ({ chromium: driver }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function context() {
  return {
    on: vi.fn(),
    off: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    route: vi.fn().mockResolvedValue(undefined),
    addCookies: vi.fn().mockResolvedValue(undefined),
  };
}

function browser() {
  return {
    newContext: vi.fn().mockImplementation(async () => context()),
    on: vi.fn(),
    off: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

type Lane = 'pooled' | 'headed' | 'remote';
const engines: PlaywrightChromiumEngine[] = [];
function engine(lane: Lane) {
  const result = new PlaywrightChromiumEngine({
    preferBundled: true,
    ...(lane === 'remote' ? { cdpEndpoint: 'http://127.0.0.1:9222' } : {}),
  });
  engines.push(result);
  return result;
}
function options(lane: Lane) {
  return { headless: lane === 'pooled' };
}
function launcher(lane: Lane) {
  return lane === 'remote' ? driver.connectOverCDP : driver.launch;
}

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(async () => {
  await Promise.allSettled(engines.splice(0).map((item) => item.close()));
});

describe('browser resource ownership', () => {
  it.each(['pooled', 'remote'] as const)(
    'shares one concurrent %s initialization',
    async (lane) => {
      const host = browser();
      const gate = deferred<ReturnType<typeof browser>>();
      launcher(lane).mockReturnValue(gate.promise);
      const owner = engine(lane);
      const first = owner.createSession(options(lane));
      const second = owner.createSession(options(lane));
      gate.resolve(host);
      const sessions = await Promise.all([first, second]);
      expect(launcher(lane)).toHaveBeenCalledTimes(1);
      expect(host.newContext).toHaveBeenCalledTimes(2);
      await Promise.all(sessions.map((session) => session.close()));
      expect(host.close).not.toHaveBeenCalled();
      await Promise.all([owner.close(), owner.close()]);
      expect(host.close).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['pooled', 'remote'] as const)(
    'permits retry after failed %s initialization',
    async (lane) => {
      const failure = new Error('launch failed');
      const host = browser();
      const gate = deferred<ReturnType<typeof browser>>();
      launcher(lane).mockReturnValueOnce(gate.promise).mockResolvedValue(host);
      const owner = engine(lane);
      const first = expect(owner.createSession(options(lane))).rejects.toBe(failure);
      const second = expect(owner.createSession(options(lane))).rejects.toBe(failure);
      gate.reject(failure);
      await Promise.all([first, second]);
      expect(launcher(lane)).toHaveBeenCalledTimes(1);
      const session = await owner.createSession(options(lane));
      expect(launcher(lane)).toHaveBeenCalledTimes(2);
      await session.close();
      expect(host.close).not.toHaveBeenCalled();
    }
  );

  it('a remote headed request owns only its context', async () => {
    const host = browser();
    const firstContext = context();
    const secondContext = context();
    host.newContext.mockResolvedValueOnce(firstContext).mockResolvedValueOnce(secondContext);
    driver.connectOverCDP.mockResolvedValue(host);
    const owner = engine('remote');
    const first = await owner.createSession({ headless: false });
    const second = await owner.createSession({ headless: true });
    await first.close();
    expect(firstContext.close).toHaveBeenCalledTimes(1);
    expect(secondContext.close).not.toHaveBeenCalled();
    expect(host.close).not.toHaveBeenCalled();
    await second.close();
    await owner.close();
    expect(host.close).toHaveBeenCalledTimes(1);
  });

  it('local headed sessions own distinct browsers without closing the pool', async () => {
    const pool = browser();
    const firstHost = browser();
    const secondHost = browser();
    driver.launch
      .mockResolvedValueOnce(pool)
      .mockResolvedValueOnce(firstHost)
      .mockResolvedValueOnce(secondHost);
    const owner = engine('headed');
    const pooled = await owner.createSession({ headless: true });
    const [first, second] = await Promise.all([
      owner.createSession({ headless: false }),
      owner.createSession({ headless: false }),
    ]);
    await first.close();
    expect(firstHost.close).toHaveBeenCalledTimes(1);
    expect(secondHost.close).not.toHaveBeenCalled();
    expect(pool.close).not.toHaveBeenCalled();
    await second.close();
    await pooled.close();
    await owner.close();
    expect(secondHost.close).toHaveBeenCalledTimes(1);
    expect(pool.close).toHaveBeenCalledTimes(1);
  });

  it.each(['pooled', 'headed', 'remote'] as const)(
    'drains %s launch racing shutdown and rejects new work',
    async (lane) => {
      const host = browser();
      const gate = deferred<ReturnType<typeof browser>>();
      launcher(lane).mockReturnValue(gate.promise);
      const owner = engine(lane);
      const creation = owner.createSession(options(lane));
      const refused = expect(creation).rejects.toThrow('closed');
      const closing = owner.close();
      gate.resolve(host);
      await closing;
      await refused;
      expect(host.newContext).not.toHaveBeenCalled();
      expect(host.close).toHaveBeenCalledTimes(1);
      await expect(owner.createSession(options(lane))).rejects.toThrow('closed');
      expect(launcher(lane)).toHaveBeenCalledTimes(1);
      await owner.close();
      expect(host.close).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['pooled', 'headed', 'remote'] as const)(
    'cleans %s context creation racing shutdown',
    async (lane) => {
      const host = browser();
      const ctx = context();
      const gate = deferred<ReturnType<typeof context>>();
      host.newContext.mockReturnValue(gate.promise);
      launcher(lane).mockResolvedValue(host);
      const owner = engine(lane);
      const creation = owner.createSession(options(lane));
      const refused = expect(creation).rejects.toThrow('closed');
      await vi.waitFor(() => expect(host.newContext).toHaveBeenCalledTimes(1));
      const closing = owner.close();
      gate.resolve(ctx);
      await closing;
      await refused;
      expect(ctx.close).toHaveBeenCalledTimes(1);
      expect(host.close).toHaveBeenCalledTimes(1);
    }
  );

  describe.each(['pooled', 'headed', 'remote'] as const)('%s setup failure', (lane) => {
    const stages = (['newContext', 'addInitScript', 'route', 'addCookies'] as const).filter(
      (stage) => lane !== 'pooled' || stage !== 'addInitScript'
    );
    it.each(stages)('releases only owned resources after %s fails', async (stage) => {
      const failure = new Error(`failed ${stage}`);
      const host = browser();
      const ctx = context();
      host.newContext.mockResolvedValue(ctx);
      if (stage === 'newContext') host.newContext.mockRejectedValueOnce(failure);
      else ctx[stage].mockRejectedValueOnce(failure);
      launcher(lane).mockResolvedValue(host);
      const owner = engine(lane);
      await expect(
        owner.createSession({
          ...options(lane),
          requestPolicy: { checkRequest: async () => {} },
          cookies: [{ name: 'x', value: 'y', domain: 'example.com', path: '/' }],
        })
      ).rejects.toBe(failure);
      expect(ctx.close).toHaveBeenCalledTimes(stage === 'newContext' ? 0 : 1);
      expect(host.close).toHaveBeenCalledTimes(lane === 'headed' ? 1 : 0);
      await owner.close();
      expect(host.close).toHaveBeenCalledTimes(1);
    });
  });

  it.each(['pooled', 'headed', 'remote'] as const)(
    'withholds a %s session while shutdown drains late cookie setup',
    async (lane) => {
      const host = browser();
      const ctx = context();
      const gate = deferred<void>();
      ctx.addCookies.mockReturnValue(gate.promise);
      host.newContext.mockResolvedValue(ctx);
      launcher(lane).mockResolvedValue(host);
      const owner = engine(lane);
      const creation = owner.createSession({
        ...options(lane),
        cookies: [{ name: 'x', value: 'y', domain: 'example.com', path: '/' }],
      });
      const refused = expect(creation).rejects.toThrow('closed');
      await vi.waitFor(() => expect(ctx.addCookies).toHaveBeenCalledTimes(1));
      let drained = false;
      const closing = owner.close().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      gate.resolve();
      await closing;
      await refused;
      expect(ctx.close).toHaveBeenCalledTimes(1);
      expect(host.close).toHaveBeenCalledTimes(1);
    }
  );

  it('validates snapshot timeout before allocating resources', async () => {
    const owner = engine('headed');
    driver.launch.mockResolvedValue(browser());
    await expect(owner.createSession({ headless: false, snapshotTimeoutMs: 0 })).rejects.toThrow();
    expect(driver.launch).not.toHaveBeenCalled();
  });

  it('preserves setup error even when cleanup fails', async () => {
    const host = browser();
    const ctx = context();
    const failure = new Error('cookie seed failed');
    ctx.addCookies.mockRejectedValue(failure);
    ctx.close.mockRejectedValue(new Error('context close failed'));
    host.close.mockRejectedValue(new Error('browser close failed'));
    host.newContext.mockResolvedValue(ctx);
    driver.launch.mockResolvedValue(host);
    await expect(
      engine('headed').createSession({
        headless: false,
        cookies: [{ name: 'x', value: 'y', domain: 'example.com', path: '/' }],
      })
    ).rejects.toBe(failure);
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(host.close).toHaveBeenCalledTimes(1);
  });

  it('releases dedicated browser even if session context close fails', async () => {
    const host = browser();
    const ctx = context();
    const failure = new Error('context close failed');
    ctx.close.mockRejectedValue(failure);
    host.newContext.mockResolvedValue(ctx);
    driver.launch.mockResolvedValue(host);
    const session = await engine('headed').createSession({ headless: false });
    await expect(session.close()).rejects.toBe(failure);
    expect(host.close).toHaveBeenCalledTimes(1);
  });
});
