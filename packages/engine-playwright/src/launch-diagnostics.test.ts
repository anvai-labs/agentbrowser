import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  connectOverCDP: vi.fn(),
  access: vi.fn(),
}));

vi.mock('playwright', () => ({
  chromium: { launch: mocks.launch, connectOverCDP: mocks.connectOverCDP },
}));
vi.mock('node:fs/promises', () => ({ access: mocks.access }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
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

function browser(version: string, suppliedContext = context()) {
  return {
    version: vi.fn().mockReturnValue(version),
    newContext: vi.fn().mockResolvedValue(suppliedContext),
    on: vi.fn(),
    off: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

const engines: PlaywrightChromiumEngine[] = [];
function engine(options: ConstructorParameters<typeof PlaywrightChromiumEngine>[0] = {}) {
  const result = new PlaywrightChromiumEngine(options);
  engines.push(result);
  return result;
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(async () => {
  await Promise.allSettled(engines.splice(0).map((item) => item.close()));
});

describe('bounded launch diagnostics', () => {
  it('captures a pooled local launch and the exact context decisions once', async () => {
    const host = browser('Chromium 140.0.1');
    mocks.launch.mockResolvedValue(host);
    const session = await engine({ preferBundled: true }).createSession({ headless: true });

    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.launch).toHaveBeenCalledWith({ headless: true });
    expect(host.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ viewport: { width: 1280, height: 720 } })
    );
    expect(session.diagnostics).toEqual({
      attachment: 'local_launch',
      browserFamily: 'chromium',
      browserVersion: 'Chromium 140.0.1',
      executableSelection: 'playwright_default',
      launchMode: 'headless',
      resourceModel: 'shared_local_browser',
      context: {
        isolation: 'new_context',
        viewport: { mode: 'fixed', width: 1280, height: 720 },
        initScript: 'not_registered',
      },
    });
    expect(Object.isFrozen(session.diagnostics)).toBe(true);
    expect(Object.isFrozen(session.diagnostics?.context)).toBe(true);
    expect(Object.isFrozen(session.diagnostics?.context.viewport)).toBe(true);
  });

  it('reports explicit headed selection from the same single path resolution used to launch', async () => {
    const path = '/configured/chrome';
    mocks.access.mockResolvedValue(undefined);
    mocks.launch.mockResolvedValue(browser('Chrome 140'));
    const session = await engine({
      chromeBinaryPath: path,
      brandedChromeCandidates: ['/must-not-probe'],
    }).createSession({ headless: false, viewport: { width: 1440, height: 900 } });

    expect(mocks.access).toHaveBeenCalledTimes(1);
    expect(mocks.access).toHaveBeenCalledWith(path);
    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({ headless: false, executablePath: path })
    );
    expect(session.diagnostics).toMatchObject({
      executableSelection: 'explicit',
      launchMode: 'headed',
      resourceModel: 'dedicated_local_browser',
      context: {
        isolation: 'new_context',
        viewport: { mode: 'fixed', width: 1440, height: 900 },
        initScript: 'registered',
      },
    });
  });

  it('does not run detection behind a missing explicit path', async () => {
    mocks.access.mockRejectedValue(new Error('missing'));
    mocks.launch.mockResolvedValue(browser('Chromium 140'));
    const session = await engine({
      chromeBinaryPath: '/missing/explicit',
      brandedChromeCandidates: ['/would-have-existed'],
    }).createSession({ headless: false });

    expect(mocks.access).toHaveBeenCalledTimes(1);
    expect(mocks.access).toHaveBeenCalledWith('/missing/explicit');
    expect(mocks.launch).toHaveBeenCalledWith(
      expect.not.objectContaining({ executablePath: expect.anything() })
    );
    expect(session.diagnostics?.executableSelection).toBe('playwright_default');
  });

  it('reports detected selection and probes each candidate only until the winner', async () => {
    mocks.access.mockRejectedValueOnce(new Error('missing')).mockResolvedValueOnce(undefined);
    mocks.launch.mockResolvedValue(browser('Chrome 140'));
    const session = await engine({
      preferBundled: false,
      brandedChromeCandidates: ['/missing', '/detected', '/must-not-probe'],
    }).createSession({ headless: false });

    expect(mocks.access.mock.calls).toEqual([['/missing'], ['/detected']]);
    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({ executablePath: '/detected' })
    );
    expect(session.diagnostics?.executableSelection).toBe('detected');
  });

  it('reports Playwright default without filesystem probing when explicitly preferred', async () => {
    mocks.launch.mockResolvedValue(browser('Chromium 140'));
    const session = await engine({
      preferBundled: true,
      brandedChromeCandidates: ['/must-not-probe'],
    }).createSession({ headless: false });

    expect(mocks.access).not.toHaveBeenCalled();
    expect(session.diagnostics?.executableSelection).toBe('playwright_default');
  });

  it('reports remote attachment facts without inspecting local executables', async () => {
    const ctx = context();
    const host = browser('140.0.0.0', ctx);
    mocks.connectOverCDP.mockResolvedValue(host);
    const session = await engine({
      cdpEndpoint: 'http://127.0.0.1:9222',
      chromeBinaryPath: '/must-not-probe',
      brandedChromeCandidates: ['/must-not-probe-either'],
    }).createSession({ headless: false });

    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.connectOverCDP).toHaveBeenCalledTimes(1);
    expect(ctx.addInitScript).toHaveBeenCalledTimes(1);
    expect(session.diagnostics).toEqual({
      attachment: 'remote_cdp',
      browserFamily: 'chromium',
      browserVersion: '140.0.0.0',
      executableSelection: 'not_applicable',
      launchMode: 'unknown',
      resourceModel: 'shared_remote_connection',
      context: {
        isolation: 'new_context',
        viewport: { mode: 'no_viewport' },
        initScript: 'registered',
      },
    });
  });

  it('omits an unsafe runtime version without dropping the remaining facts', async () => {
    mocks.launch.mockResolvedValue(browser('chrome://private/path'));
    const session = await engine({ preferBundled: true }).createSession({ headless: true });

    expect(session.diagnostics).toMatchObject({
      attachment: 'local_launch',
      browserFamily: 'chromium',
      executableSelection: 'playwright_default',
    });
    expect(session.diagnostics).not.toHaveProperty('browserVersion');
  });

  it('binds concurrent shared sessions to the same initialization facts', async () => {
    const gate = deferred<ReturnType<typeof browser>>();
    const host = browser('Chromium shared');
    mocks.launch.mockReturnValue(gate.promise);
    const owner = engine({ preferBundled: true });
    const first = owner.createSession({ headless: true });
    const second = owner.createSession({ headless: true, viewport: { width: 800, height: 600 } });
    gate.resolve(host);
    const sessions = await Promise.all([first, second]);

    expect(mocks.launch).toHaveBeenCalledTimes(1);
    expect(sessions[0].diagnostics?.browserVersion).toBe('Chromium shared');
    expect(sessions[1].diagnostics?.browserVersion).toBe('Chromium shared');
    expect(sessions[0].diagnostics?.context.viewport).toEqual({
      mode: 'fixed',
      width: 1280,
      height: 720,
    });
    expect(sessions[1].diagnostics?.context.viewport).toEqual({
      mode: 'fixed',
      width: 800,
      height: 600,
    });
  });

  it('does not cross-contaminate facts between concurrent dedicated launches', async () => {
    const firstGate = deferred<ReturnType<typeof browser>>();
    const secondGate = deferred<ReturnType<typeof browser>>();
    mocks.launch.mockReturnValueOnce(firstGate.promise).mockReturnValueOnce(secondGate.promise);
    const owner = engine({ preferBundled: true });
    const first = owner.createSession({ headless: false });
    const second = owner.createSession({ headless: false });
    secondGate.resolve(browser('Chrome second'));
    firstGate.resolve(browser('Chrome first'));
    const sessions = await Promise.all([first, second]);

    expect(sessions[0].diagnostics?.browserVersion).toBe('Chrome first');
    expect(sessions[1].diagnostics?.browserVersion).toBe('Chrome second');
    expect(sessions.map((session) => session.diagnostics?.resourceModel)).toEqual([
      'dedicated_local_browser',
      'dedicated_local_browser',
    ]);
  });
});
