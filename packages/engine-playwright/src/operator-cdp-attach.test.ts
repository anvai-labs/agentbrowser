import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaywrightChromiumEngine, parseOperatorCdpEndpoint } from './index.js';

const driver = vi.hoisted(() => ({ connectOverCDP: vi.fn(), launch: vi.fn() }));
vi.mock('playwright', () => ({ chromium: driver }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function page(opener: unknown = null) {
  const listeners = new Map<string, (...args: never[]) => void>();
  return {
    on: vi.fn((name: string, listener: (...args: never[]) => void) =>
      listeners.set(name, listener)
    ),
    off: vi.fn((name: string) => listeners.delete(name)),
    opener: vi.fn().mockResolvedValue(opener),
    setViewportSize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isClosed: vi.fn().mockReturnValue(false),
    url: vi.fn().mockReturnValue('about:blank'),
    goto: vi.fn().mockResolvedValue(null),
    mainFrame: vi.fn(),
    emit(name: string) {
      listeners.get(name)?.();
    },
  };
}

function context() {
  const listeners = new Map<string, (value: never) => void>();
  return {
    on: vi.fn((name: string, listener: (value: never) => void) => listeners.set(name, listener)),
    off: vi.fn((name: string) => listeners.delete(name)),
    newPage: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    cookies: vi.fn().mockResolvedValue([]),
    emitPage(value: unknown) {
      listeners.get('page')?.(value as never);
    },
  };
}

function browser(ctx = context()) {
  const listeners = new Map<string, () => void>();
  return {
    contexts: vi.fn().mockReturnValue([ctx]),
    close: vi.fn().mockResolvedValue(undefined),
    version: vi.fn().mockReturnValue('135.0.1'),
    on: vi.fn((name: string, listener: () => void) => listeners.set(name, listener)),
    off: vi.fn((name: string) => listeners.delete(name)),
    emitDisconnected() {
      listeners.get('disconnected')?.();
    },
  };
}

const engines: PlaywrightChromiumEngine[] = [];
function configured(allowUnenforcedEgress = true) {
  const engine = new PlaywrightChromiumEngine({
    operatorCdp: { endpoint: 'http://127.0.0.1:9222', allowUnenforcedEgress },
    egress: { checkRequest: async () => {} },
  });
  engines.push(engine);
  return engine;
}

beforeEach(() => vi.resetAllMocks());
afterEach(async () => {
  await Promise.allSettled(engines.splice(0).map((engine) => engine.close()));
});

describe('operator CDP endpoint', () => {
  it.each([
    ['http://127.0.0.1:9222', 'http://127.0.0.1:9222'],
    ['http://[::1]:9222/', 'http://[::1]:9222'],
    ['http://127.0.0.1:00080', 'http://127.0.0.1:80'],
  ])('normalizes a literal loopback endpoint', (input, expected) => {
    expect(parseOperatorCdpEndpoint(input)).toBe(expected);
  });

  it.each([
    'https://127.0.0.1:9222',
    'http://localhost:9222',
    'http://127.0.0.2:9222',
    'http://user@127.0.0.1:9222',
    'http://127.0.0.1:9222/json',
    'http://127.0.0.1:9222/?token=x',
    'http://127.0.0.1',
  ])('rejects endpoint %s', (input) => {
    expect(() => parseOperatorCdpEndpoint(input)).toThrow('Invalid operator CDP endpoint');
  });
});

describe('operator CDP ownership', () => {
  it('advertises the lane only for acknowledged configured Chromium', async () => {
    expect(await configured().capabilities()).toMatchObject({ supportsCdpAttach: true });
    expect(await configured(false).capabilities()).not.toHaveProperty('supportsCdpAttach');
  });

  it('refuses disabled, policy, and context-mutating requests before connecting', async () => {
    const disabled = new PlaywrightChromiumEngine();
    engines.push(disabled);
    await expect(disabled.createSession({ cdpAttach: true })).rejects.toMatchObject({
      code: 'ENGINE_UNSUPPORTED',
      details: { reason: 'CDP_ATTACH_DISABLED' },
    });
    await expect(
      configured(false).createSession({
        cdpAttach: true,
        requestPolicy: { checkRequest: async () => {} },
      })
    ).rejects.toMatchObject({ details: { reason: 'EGRESS_UNSUPPORTED' } });
    await expect(
      configured().createSession({ cdpAttach: true, locale: 'en-US' })
    ).rejects.toMatchObject({ details: { reason: 'PROFILE_OPTIONS_UNSUPPORTED' } });
    const noPolicy = new PlaywrightChromiumEngine({
      operatorCdp: {
        endpoint: 'http://127.0.0.1:9222',
        allowUnenforcedEgress: true,
      },
    });
    engines.push(noPolicy);
    await expect(noPolicy.createSession({ cdpAttach: true })).rejects.toMatchObject({
      code: 'ENGINE_UNSUPPORTED',
      details: { reason: 'EGRESS_UNSUPPORTED' },
    });
    expect(driver.connectOverCDP).not.toHaveBeenCalled();
  });

  it('reserves pending setup and releases it after failure', async () => {
    const gate = deferred<ReturnType<typeof browser>>();
    driver.connectOverCDP
      .mockReturnValueOnce(gate.promise)
      .mockRejectedValueOnce(new Error('down'));
    const engine = configured();
    const first = engine.createSession({ cdpAttach: true });
    await expect(engine.createSession({ cdpAttach: true })).rejects.toMatchObject({
      details: { reason: 'CDP_ATTACH_BUSY' },
    });
    const host = browser();
    host.contexts.mockReturnValue([]);
    gate.resolve(host);
    await expect(first).rejects.toMatchObject({
      details: { reason: 'PROFILE_CONTEXT_UNAVAILABLE' },
    });
    expect(host.close).toHaveBeenCalledTimes(1);
    await expect(engine.createSession({ cdpAttach: true })).rejects.toMatchObject({
      details: { reason: 'CDP_ATTACH_FAILED' },
    });
    expect(driver.connectOverCDP).toHaveBeenCalledTimes(2);
  });

  it('sanitizes connection failure details and releases the reservation', async () => {
    driver.connectOverCDP.mockRejectedValueOnce(
      new Error('connect http://127.0.0.1:9222/devtools/browser/private-token')
    );
    const engine = configured();
    await expect(engine.createSession({ cdpAttach: true })).rejects.toMatchObject({
      code: 'ENGINE_UNSUPPORTED',
      message: 'Operator CDP attachment failed.',
      details: { reason: 'CDP_ATTACH_FAILED' },
    });
    driver.connectOverCDP.mockResolvedValueOnce(browser());
    await expect(engine.createSession({ cdpAttach: true })).resolves.toBeDefined();
  });

  it('uses the existing context, owns only fresh pages, and detaches on close', async () => {
    const ctx = context();
    const host = browser(ctx);
    const external = page();
    const owned = page();
    const ownedPopup = page(owned);
    ctx.newPage.mockResolvedValue(owned);
    driver.connectOverCDP.mockResolvedValue(host);
    const engine = configured();
    const session = await engine.createSession({ cdpAttach: true });
    expect(driver.connectOverCDP).toHaveBeenCalledWith('http://127.0.0.1:9222', {
      noDefaults: true,
    });
    expect(session.diagnostics).toMatchObject({
      attachment: 'cdp_attach',
      endpointClass: 'loopback_http',
      resourceModel: 'operator_owned_browser',
      egress: 'navigation_preflight_only',
      context: { isolation: 'existing_default_context' },
    });
    ctx.emitPage(external);
    await Promise.resolve();
    expect(await session.pages()).toHaveLength(0);
    const created = await session.newPage();
    expect(await session.pages()).toEqual([created]);
    expect(owned.on).not.toHaveBeenCalledWith('download', expect.any(Function));
    ctx.emitPage(ownedPopup);
    await vi.waitFor(async () => expect(await session.pages()).toHaveLength(2));
    await expect(session.cookies()).rejects.toMatchObject({
      details: { reason: 'PROFILE_COOKIE_EXPORT_UNSUPPORTED' },
    });
    await session.close();
    expect(owned.close).toHaveBeenCalledTimes(1);
    expect(ownedPopup.close).toHaveBeenCalledTimes(1);
    expect(external.close).not.toHaveBeenCalled();
    expect(ctx.close).not.toHaveBeenCalled();
    expect(host.close).toHaveBeenCalledTimes(1);
  });

  it('preflights explicit navigation before goto without installing context routes', async () => {
    const ctx = context();
    const host = browser(ctx);
    const owned = page();
    ctx.newPage.mockResolvedValue(owned);
    driver.connectOverCDP.mockResolvedValue(host);
    const checkRequest = vi.fn().mockRejectedValue(new Error('blocked'));
    const session = await configured().createSession({
      cdpAttach: true,
      requestPolicy: { checkRequest },
    });
    const created = await session.newPage();
    await expect(created.navigate({ url: 'https://example.test/private' })).rejects.toThrow();
    expect(checkRequest).toHaveBeenCalledWith({
      hostname: 'example.test',
      url: 'https://example.test/private',
    });
    expect(owned.goto).not.toHaveBeenCalled();
    await expect(created.navigate({ url: 'data:text/html,private' })).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { reason: 'egress_policy' },
    });
    expect(checkRequest).toHaveBeenCalledTimes(1);
  });

  it('removes externally closed owned pages and releases attach on disconnect', async () => {
    const ctx = context();
    const host = browser(ctx);
    const owned = page();
    ctx.newPage.mockResolvedValue(owned);
    driver.connectOverCDP.mockResolvedValue(host);
    const engine = configured();
    const session = await engine.createSession({ cdpAttach: true });
    await session.newPage();
    owned.emit('close');
    expect(await session.pages()).toHaveLength(0);
    host.emitDisconnected();
    await vi.waitFor(() => expect(host.close).toHaveBeenCalled());
    driver.connectOverCDP.mockResolvedValue(browser());
    await expect(engine.createSession({ cdpAttach: true })).resolves.toBeDefined();
  });

  it('attempts every owned page close and releases the reservation after cleanup failure', async () => {
    const ctx = context();
    const host = browser(ctx);
    const first = page();
    const second = page();
    const failure = new Error('page close failed');
    first.close.mockRejectedValue(failure);
    ctx.newPage.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    driver.connectOverCDP.mockResolvedValueOnce(host).mockResolvedValueOnce(browser());
    const engine = configured();
    const session = await engine.createSession({ cdpAttach: true });
    await session.newPage();
    await session.newPage();
    await expect(session.close()).rejects.toBe(failure);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(host.close).toHaveBeenCalledTimes(1);
    await expect(engine.createSession({ cdpAttach: true })).resolves.toBeDefined();
  });

  it('closes a fresh page that resolves after session shutdown', async () => {
    const ctx = context();
    const host = browser(ctx);
    const gate = deferred<ReturnType<typeof page>>();
    ctx.newPage.mockReturnValue(gate.promise);
    driver.connectOverCDP.mockResolvedValue(host);
    const session = await configured().createSession({ cdpAttach: true });
    const creating = session.newPage();
    const closing = session.close();
    const late = page();
    gate.resolve(late);
    await closing;
    await expect(creating).rejects.toThrow('Session is closed');
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(ctx.close).not.toHaveBeenCalled();
  });

  it('closes an owned popup whose opener lookup resolves after shutdown', async () => {
    const ctx = context();
    const host = browser(ctx);
    const opener = page();
    const popup = page();
    const openerGate = deferred<ReturnType<typeof page>>();
    popup.opener.mockReturnValue(openerGate.promise);
    ctx.newPage.mockResolvedValue(opener);
    driver.connectOverCDP.mockResolvedValue(host);
    const session = await configured().createSession({ cdpAttach: true });
    await session.newPage();
    ctx.emitPage(popup);
    const closing = session.close();
    openerGate.resolve(opener);
    await closing;
    await vi.waitFor(() => expect(popup.close).toHaveBeenCalledTimes(1));
    expect(ctx.close).not.toHaveBeenCalled();
  });

  it('engine shutdown joins an already-running attached-session detach', async () => {
    const host = browser();
    const gate = deferred<void>();
    host.close.mockReturnValue(gate.promise);
    driver.connectOverCDP.mockResolvedValue(host);
    const engine = configured();
    const session = await engine.createSession({ cdpAttach: true });
    const sessionClose = session.close();
    let engineClosed = false;
    const engineClose = engine.close().then(() => {
      engineClosed = true;
    });
    await Promise.resolve();
    expect(engineClosed).toBe(false);
    expect(host.close).toHaveBeenCalledTimes(1);
    gate.resolve();
    await Promise.all([sessionClose, engineClose]);
    expect(host.close).toHaveBeenCalledTimes(1);
  });
});
