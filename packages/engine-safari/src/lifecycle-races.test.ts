import { expect, it, vi } from 'vitest';
import { SafaridriverEngine } from './index.js';
import type { WebDriverTransport } from './webdriver.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Uninitialized deferred');
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  let selected = 'one';
  let created = 0;
  const handles = ['one', 'two'];
  const operations: string[] = [];
  let pause:
    | {
        path: string;
        entered: ReturnType<typeof deferred<void>>;
        release: ReturnType<typeof deferred<void>>;
      }
    | undefined;
  const driver: WebDriverTransport = {
    async request<T>(path: string, method: string, body?: unknown): Promise<T> {
      const gate = pause;
      if (gate && gate.path === path) {
        pause = undefined;
        gate.entered.resolve();
        await gate.release.promise;
      }
      let value: unknown;
      if (path === '/session') value = { sessionId: 'wd' };
      else if (path.endsWith('/window/handles')) value = [...handles];
      else if (path.endsWith('/window/new')) value = { handle: `new-${++created}` };
      else if (path.endsWith('/window') && method === 'POST')
        selected = (body as { handle: string }).handle;
      else if (path.endsWith('/window') && method === 'DELETE') {
        operations.push(`close:${selected}`);
        const index = handles.indexOf(selected);
        if (index !== -1) handles.splice(index, 1);
      } else if (path.endsWith('/screenshot')) value = Buffer.from(selected).toString('base64');
      else if (path.endsWith('/execute/sync')) {
        operations.push(`execute:${selected}`);
        value = {
          title: selected,
          url: `https://${selected}.example/`,
          elements: [],
          bodyText: '',
        };
      } else if (path.endsWith('/url')) {
        if (method === 'POST') operations.push(`navigate:${selected}`);
        value = `https://${selected}.example/`;
      }
      // Yield after selecting a window to expose un-serialized callers.
      await Promise.resolve();
      return value as T;
    },
    kill: vi.fn(),
  };
  return {
    driver,
    operations,
    pause(path: string) {
      const gate = { path, entered: deferred<void>(), release: deferred<void>() };
      pause = gate;
      return gate;
    },
  };
}

it('serializes entire cross-page operations, including window deletion', async () => {
  const f = fixture();
  const engine = new SafaridriverEngine({ startDriver: async () => f.driver });
  try {
    const session = await engine.createSession({});
    const [one, two] = await session.pages();
    if (!one || !two) throw new Error('Missing fixture pages');
    const captures = await Promise.all([one.screenshot({}), two.screenshot({})]);
    expect(
      captures.map((capture) => Buffer.from(capture.bytesBase64 ?? '', 'base64').toString())
    ).toEqual(['one', 'two']);
    await Promise.all([
      one.navigate({ url: 'https://one.example/' }),
      two.navigate({ url: 'https://two.example/' }),
    ]);
    expect(f.operations).toEqual(['navigate:one', 'navigate:two']);
    const action = one.act({ type: 'press', key: 'Enter' });
    const close = two.close();
    expect(two.close()).toBe(close);
    await Promise.all([action, close]);
    expect(f.operations.slice(-2)).toEqual(['execute:one', 'close:two']);
    await expect(two.screenshot({})).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' });
  } finally {
    await engine.close();
  }
});

it('does not rediscover a closing handle before its queued deletion finishes', async () => {
  const f = fixture();
  const engine = new SafaridriverEngine({ startDriver: async () => f.driver });
  try {
    const session = await engine.createSession({});
    const [one] = await session.pages();
    if (!one) throw new Error('Missing page');
    const ended = one.events()[Symbol.asyncIterator]().next();
    const listing = session.pages();
    const closing = one.close();
    expect((await listing).map((page) => page.id)).toEqual(['two']);
    await closing;
    await expect(ended).resolves.toMatchObject({ done: true });
    expect((await session.pages()).map((page) => page.id)).toEqual(['two']);
    expect(f.operations.filter((operation) => operation === 'close:one')).toHaveLength(1);
  } finally {
    await engine.close();
  }
});

it('releases successful-close tombstones without requiring enumeration', async () => {
  const f = fixture();
  const engine = new SafaridriverEngine({ startDriver: async () => f.driver });
  try {
    const session = await engine.createSession({});
    for (let index = 0; index < 100; index++) {
      const page = await session.newPage();
      await page.close();
    }
    const retained = session as unknown as { closingHandles: Map<string, symbol> };
    expect(retained.closingHandles.size).toBe(0);
  } finally {
    await engine.close();
  }
});

it.each(['pages', 'newPage'] as const)(
  'does not resurrect resources when %s completes after shutdown',
  async (operation) => {
    const f = fixture();
    const engine = new SafaridriverEngine({ startDriver: async () => f.driver });
    const session = await engine.createSession({});
    const [page] = await session.pages();
    if (!page) throw new Error('Missing page');
    const event = page.events()[Symbol.asyncIterator]().next();
    const gate = f.pause(`/session/wd/window/${operation === 'pages' ? 'handles' : 'new'}`);
    const pending = session[operation]();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await gate.entered.promise;
    const close = engine.close();
    expect(engine.close()).toBe(close);
    await expect(event).resolves.toMatchObject({ done: true });
    gate.release.resolve();
    await rejected;
    await close;
    expect(f.driver.kill).toHaveBeenCalledOnce();
    await expect(session.pages()).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await expect(page.observe({})).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' });
  }
);

it.each(['factory', 'session'] as const)(
  'cleans late %s startup and waits for it before shutdown completes',
  async (stage) => {
    const f = fixture();
    const factory = deferred<WebDriverTransport>();
    const gate = stage === 'session' ? f.pause('/session') : undefined;
    const startDriver = vi.fn(() =>
      stage === 'factory' ? factory.promise : Promise.resolve(f.driver)
    );
    const engine = new SafaridriverEngine({ startDriver });
    const pending = engine.createSession({});
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ENGINE_CRASHED' });
    if (gate) await gate.entered.promise;
    let finished = false;
    const close = engine.close();
    void close.then(() => {
      finished = true;
    });
    expect(engine.close()).toBe(close);
    await Promise.resolve();
    expect(finished).toBe(false);
    if (gate) gate.release.resolve();
    else factory.resolve(f.driver);
    await rejected;
    await close;
    expect(f.driver.kill).toHaveBeenCalledOnce();
    await expect(engine.createSession({})).rejects.toMatchObject({ code: 'ENGINE_CRASHED' });
    expect(startDriver).toHaveBeenCalledOnce();
  }
);

it('rejects queued and in-flight page results after close while cleanup still completes', async () => {
  const f = fixture();
  const engine = new SafaridriverEngine({ startDriver: async () => f.driver });
  try {
    const session = await engine.createSession({});
    const [page] = await session.pages();
    if (!page) throw new Error('Missing page');
    const gate = f.pause('/session/wd/execute/sync');
    const observation = page.observe({});
    const rejected = expect(observation).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' });
    await gate.entered.promise;
    const queued = expect(page.screenshot({})).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' });
    const close = page.close();
    expect(page.close()).toBe(close);
    gate.release.resolve();
    await Promise.all([rejected, queued, close]);
    expect(f.operations.filter((operation) => operation === 'close:one')).toHaveLength(1);
  } finally {
    await engine.close();
  }
});
