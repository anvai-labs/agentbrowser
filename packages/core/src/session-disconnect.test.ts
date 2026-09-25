import type { BrowserEngine, EngineSession } from '@agentbrowser/engine';
import { describe, expect, it, vi } from 'vitest';
import { SessionCoordinator, SessionState } from './session-coordinator.js';

function fixture() {
  const loss = new AbortController();
  const session: EngineSession = {
    id: 'engine-fixture',
    disconnected: loss.signal,
    newPage: vi.fn(),
    pages: async () => [],
    cookies: async () => [],
    close: vi.fn(async () => {}),
  };
  const engine: BrowserEngine = {
    name: 'fixture',
    version: '1',
    createSession: async () => session,
    capabilities: async () => ({
      supportsScreenshots: false,
      supportsPdf: false,
      supportsDownloads: false,
      supportsUploads: false,
      supportsJavascript: false,
      supportsWebgl: false,
      supportsVideo: false,
      supportsPersistentStorage: false,
      supportsAccessibilityTree: false,
      supportsCdp: false,
      supportedObservationModes: [],
      supportedActionTypes: [],
    }),
    close: async () => {},
  };
  return { loss, session, engine };
}

describe('typed engine-session loss', () => {
  it('refuses an already-disconnected allocation without registering it', async () => {
    const owner = new SessionCoordinator({ now: () => 1000 });
    const f = fixture();
    f.loss.abort('private endpoint and process data');
    try {
      await expect(owner.create({}, f.engine)).rejects.toThrow('Engine session disconnected');
      expect(owner.getSessionCount()).toBe(0);
      expect(f.session.close).toHaveBeenCalledTimes(1);
    } finally {
      await owner.shutdown();
    }
  });

  it('removes and cancels the exact live allocation synchronously with bounded facts', async () => {
    let now = 1000;
    const owner = new SessionCoordinator({ now: () => now });
    const f = fixture();
    try {
      const { response, context } = await owner.createOwned({ ttlMs: 2000 }, f.engine);
      now = 1100;
      f.loss.abort('private endpoint and process data');
      expect(context.signal.aborted).toBe(true);
      expect(owner.get(response.sessionId)).toBeUndefined();
      expect(owner.inspectTerminal(response.sessionId)?.view).toMatchObject({
        closeCause: 'engine_disconnected',
        state: 'engine_disconnected',
        endedAt: 1100,
        leaseRemainingMs: 0,
        lease: { expiresAt: 3000 },
      });
      expect(JSON.stringify(owner.inspectTerminal(response.sessionId))).not.toContain('private');
      expect(f.session.close).toHaveBeenCalledTimes(1);
    } finally {
      await owner.shutdown();
    }
  });

  it('checks the persistent flag after registering its listener', async () => {
    const owner = new SessionCoordinator({ now: () => 1000 });
    const f = fixture();
    const add = f.loss.signal.addEventListener.bind(f.loss.signal);
    vi.spyOn(f.loss.signal, 'addEventListener').mockImplementation((...args) => {
      f.loss.abort(); // Event occurred immediately before the listener was installed.
      add(...args);
    });
    try {
      await expect(owner.create({}, f.engine)).rejects.toThrow('Engine session disconnected');
      expect(owner.getSessionCount()).toBe(0);
      expect(f.session.close).toHaveBeenCalledTimes(1);
    } finally {
      await owner.shutdown();
    }
  });

  it('removes the listener and preserves explicit-close ownership during a late abort', async () => {
    const owner = new SessionCoordinator({ now: () => 1000 });
    const f = fixture();
    const remove = vi.spyOn(f.loss.signal, 'removeEventListener');
    const completion = Promise.withResolvers<void>();
    vi.mocked(f.session.close).mockImplementation(() => completion.promise);
    try {
      const { sessionId } = await owner.create({}, f.engine);
      const closing = owner.close(sessionId);
      f.loss.abort();
      completion.resolve();
      await closing;
      expect(f.session.close).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(owner.inspectTerminal(sessionId)?.view.closeCause).toBe('explicit_close');
    } finally {
      completion.resolve();
      await owner.shutdown();
    }
  });

  it.each(['expiry', 'policy', 'shutdown'] as const)(
    'detaches its listener on %s',
    async (path) => {
      let now = 1000;
      const owner = new SessionCoordinator({ now: () => now });
      const f = fixture();
      const remove = vi.spyOn(f.loss.signal, 'removeEventListener');
      try {
        const { sessionId } = await owner.create({ ttlMs: 100 }, f.engine);
        if (path === 'expiry') {
          now = 1100;
          owner.get(sessionId);
        } else if (path === 'policy')
          await owner.terminate(sessionId, SessionState.POLICY_TERMINATED, 'policy');
        else await owner.shutdown();
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
        f.loss.abort();
        expect(f.session.close).toHaveBeenCalledTimes(1);
      } finally {
        await owner.shutdown();
      }
    }
  );

  it('does not let a captured old callback terminate a replacement with the same ID', async () => {
    const owner = new SessionCoordinator({ now: () => 1000 });
    const old = fixture();
    let callback: EventListener | undefined;
    const add = old.loss.signal.addEventListener.bind(old.loss.signal);
    vi.spyOn(old.loss.signal, 'addEventListener').mockImplementation((type, listener, options) => {
      if (type === 'abort') callback = listener as EventListener;
      add(type, listener, options);
    });
    vi.spyOn(
      owner as unknown as { generateSessionId(): string },
      'generateSessionId'
    ).mockReturnValue('reused');
    try {
      await owner.create({}, old.engine);
      await owner.close('reused');
      const next = fixture();
      const { context } = await owner.createOwned({}, next.engine);
      expect(callback).toBeDefined();
      callback?.(new Event('abort'));
      expect(owner.get('reused')).toBe(context);
      expect(context.signal.aborted).toBe(false);
      expect(next.session.close).not.toHaveBeenCalled();
      expect(owner.inspectTerminal('reused')).toBeUndefined();
    } finally {
      await owner.shutdown();
    }
  });
});
