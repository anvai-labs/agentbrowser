import { createServer } from 'node:http';
import type {
  ActionEffect,
  EngineAction,
  EnginePage,
  EngineRequestRecord,
  NavigationResult,
} from '@agentbrowser/engine';
import { EngagementScopePolicy, NetworkPolicy } from '@agentbrowser/policy';
import type { Frame, Page, Request } from 'playwright';
import { expect, it, vi } from 'vitest';
import { PlaywrightChromiumEngine, type RequestEventSink } from './index.js';

async function fixture() {
  const hits: Array<{ path: string; method: string }> = [];
  const records: EngineRequestRecord[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture').pathname;
    hits.push({ path, method: request.method ?? 'GET' });
    if (path === '/allowed/hop') {
      request.resume();
      response.writeHead(307, { location: '/private-token-path?token=fixture-secret' }).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' }).end(`
      <html><head><link rel="icon" href="data:,"></head><body>
      <a href="/allowed/hop?token=fixture-secret">GET redirect</a>
      <form method="POST" action="/allowed/hop?token=fixture-secret">
        <input type="hidden" name="value" value="fixture-body">
        <button>POST redirect</button>
      </form>
      <button type="button" onclick="this.dataset.clicked='yes'">No navigation</button>
      <button type="button" onclick="fetch('/private-token-path')">Fetch denied</button>
      <button type="button" onclick="const f=document.createElement('iframe');f.src='/private-token-path';document.body.append(f)">Iframe denied</button>
      <a href="/private-token-path" target="_blank">Popup denied</a>
      </body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const engine = new PlaywrightChromiumEngine();
  const session = await engine.createSession({
    requestRecorder: (record) => records.push(record),
    requestPolicy: new EngagementScopePolicy(new NetworkPolicy({ blockLoopback: false }), {
      allowedHosts: ['127.0.0.1'],
      pathRules: [{ prefix: '/allowed' }],
    }),
  });
  const page = await session.newPage();
  await page.navigate({ url: `${origin}/allowed/start` });
  return {
    engine,
    session,
    page,
    hits,
    records,
    origin,
    async close() {
      await engine.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function ref(page: EnginePage, name: string) {
  const state = await page.observe({});
  const found = state.elements.find((element) => element.name === name);
  if (!found?.ref) throw new Error(`Missing fixture control: ${name}`);
  return found.ref;
}

it.each(['GET', 'POST'])(
  'reports the bounded main-document scope denial during a %s redirect action without replay',
  async (method) => {
    const f = await fixture();
    try {
      const result = await f.page.act({
        type: 'click',
        target: { ref: await ref(f.page, `${method} redirect`) },
      });
      expect(result.result).toEqual({ success: true });
      expect(result).toHaveProperty('navigationObservation', {
        status: 'blocked',
        reason: 'egress_policy',
        scope: 'SCOPE_PATH_DENIED',
        observedDuring: 'action',
      });
      expect(JSON.stringify(result)).not.toContain('fixture-secret');
      expect(JSON.stringify(result)).not.toContain('private-token-path');
      expect(f.hits.filter((hit) => hit.path === '/allowed/hop')).toEqual([
        { path: '/allowed/hop', method },
      ]);
      expect(f.hits.some((hit) => hit.path === '/private-token-path')).toBe(false);
    } finally {
      await f.close();
    }
  }
);

it('does not invent navigation evidence for a successful action without navigation', async () => {
  const f = await fixture();
  try {
    const result = await f.page.act({
      type: 'click',
      target: { ref: await ref(f.page, 'No navigation') },
    });
    expect(result.result).toEqual({ success: true });
    expect(result).not.toHaveProperty('navigationObservation');
  } finally {
    await f.close();
  }
});

it.each(['Fetch', 'Iframe', 'Popup'])(
  'keeps a real %s denial out of the main-document action observation',
  async (source) => {
    const f = await fixture();
    try {
      const result = await f.page.act({
        type: 'click',
        target: { ref: await ref(f.page, `${source} denied`) },
      });
      await vi.waitFor(() =>
        expect(
          f.records.some(
            (record) =>
              record.type === 'request.failed' && record.data.scope === 'SCOPE_PATH_DENIED'
          )
        ).toBe(true)
      );
      if (source === 'Popup') {
        // Complete the fixture's popup adoption before tearing down its context.
        await vi.waitFor(async () => expect(await f.session.pages()).toHaveLength(2));
      }
      expect(result.result).toEqual({ success: true });
      expect(result).not.toHaveProperty('navigationObservation');
      expect(f.hits.some((hit) => hit.path === '/private-token-path')).toBe(false);
    } finally {
      await f.close();
    }
  }
);

// Drive the real collector at its dispatch seam to pin races without timing sleeps.
// Synthetic request objects supply identity only; the trusted receipt map supplies verdicts.
type CollectorPage = EnginePage & {
  backingPage(): Page;
  dispatchAction(action: EngineAction, onDispatch: () => void): Promise<ActionEffect>;
  performNavigation(): Promise<NavigationResult>;
  navigationFailures: RequestEventSink['navigationFailures'];
};
const effect = (): ActionEffect => ({
  actionId: 'fixture-action',
  startTimestamp: '2026-10-17T00:00:00Z',
  endTimestamp: '2026-10-17T00:00:00Z',
  oldRevision: 1,
  newRevision: 2,
  result: { success: true },
});
const requestFor = (
  page: Page,
  options?: { frame?: Frame; navigation?: boolean; from?: Request }
) =>
  ({
    isNavigationRequest: () => options?.navigation ?? true,
    frame: () => options?.frame ?? page.mainFrame(),
    redirectedFrom: () => options?.from ?? null,
  }) as Request;
const deny = (page: CollectorPage, request: Request) =>
  page.navigationFailures.set(request, {
    kind: 'blocked',
    reason: 'egress_policy',
    scope: 'SCOPE_PATH_DENIED',
  });

it.each(['pre-existing', 'late'])(
  'does not reuse a %s request denial in an action or the next action',
  async (timing) => {
    const f = await fixture();
    try {
      const page = f.page as CollectorPage;
      const raw = page.backingPage();
      const request = requestFor(raw);
      if (timing === 'pre-existing') raw.emit('request', request);
      vi.spyOn(page, 'dispatchAction').mockImplementationOnce(async (_, onDispatch) => {
        onDispatch();
        if (timing === 'late') raw.emit('request', request);
        else {
          deny(page, request);
          raw.emit('requestfailed', request);
        }
        return effect();
      });
      expect(await page.act({ type: 'press', key: 'Tab' })).not.toHaveProperty(
        'navigationObservation'
      );
      deny(page, request);
      raw.emit('requestfailed', request);
      expect(await page.act({ type: 'press', key: 'Tab' })).not.toHaveProperty(
        'navigationObservation'
      );
    } finally {
      await f.close();
    }
  }
);

it.each(['iframe', 'subresource', 'other-page', 'pre-existing-redirect'])(
  'excludes %s traffic from the action navigation observation',
  async (source) => {
    const f = await fixture();
    try {
      const page = f.page as CollectorPage;
      const raw = page.backingPage();
      const other = (await f.session.newPage()) as CollectorPage;
      const request = requestFor(raw, {
        ...(source === 'iframe' ? { frame: {} as Frame } : {}),
        ...(source === 'subresource' ? { navigation: false } : {}),
        ...(source === 'pre-existing-redirect' ? { from: requestFor(raw) } : {}),
      });
      vi.spyOn(page, 'dispatchAction').mockImplementationOnce(async (_, onDispatch) => {
        onDispatch();
        const emitter = source === 'other-page' ? other.backingPage() : raw;
        emitter.emit('request', request);
        deny(page, request);
        emitter.emit('requestfailed', request);
        return effect();
      });
      expect(await page.act({ type: 'press', key: 'Tab' })).not.toHaveProperty(
        'navigationObservation'
      );
    } finally {
      await f.close();
    }
  }
);

it('discards evidence from two independent main-document chains in one dispatch', async () => {
  const f = await fixture();
  try {
    const page = f.page as CollectorPage;
    const raw = page.backingPage();
    vi.spyOn(page, 'dispatchAction').mockImplementationOnce(async (_, onDispatch) => {
      onDispatch();
      for (let i = 0; i < 2; i += 1) {
        const request = requestFor(raw);
        raw.emit('request', request);
        deny(page, request);
        raw.emit('requestfailed', request);
      }
      return effect();
    });
    expect(await page.act({ type: 'press', key: 'Tab' })).not.toHaveProperty(
      'navigationObservation'
    );
  } finally {
    await f.close();
  }
});

it('discards both overlapping action observations and resumes collection for the next action', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const page = f.page as CollectorPage;
    const raw = page.backingPage();
    const record = () => {
      const request = requestFor(raw);
      raw.emit('request', request);
      deny(page, request);
      raw.emit('requestfailed', request);
    };
    vi.spyOn(page, 'dispatchAction')
      .mockImplementationOnce(async (_, onDispatch) => {
        onDispatch();
        record();
        entered.resolve();
        await release.promise;
        return effect();
      })
      .mockImplementation(async (_, onDispatch) => {
        onDispatch();
        record();
        return effect();
      });
    const first = page.act({ type: 'press', key: 'Tab' });
    await entered.promise;
    expect(await page.act({ type: 'press', key: 'Tab' })).not.toHaveProperty(
      'navigationObservation'
    );
    release.resolve();
    expect(await first).not.toHaveProperty('navigationObservation');
    expect(await page.act({ type: 'press', key: 'Tab' })).toHaveProperty('navigationObservation', {
      status: 'blocked',
      reason: 'egress_policy',
      scope: 'SCOPE_PATH_DENIED',
      observedDuring: 'action',
    });
  } finally {
    release.resolve();
    await f.close();
  }
});

it.each(['before', 'during'])(
  'discards action evidence when a direct navigation starts %s the dispatch',
  async (timing) => {
    const f = await fixture();
    const release = Promise.withResolvers<void>();
    try {
      const page = f.page as CollectorPage;
      const raw = page.backingPage();
      let navigation: Promise<NavigationResult> | undefined;
      vi.spyOn(page, 'performNavigation').mockImplementationOnce(async () => {
        await release.promise;
        return { status: 'success', url: `${f.origin}/allowed/start`, redirectChain: [] };
      });
      if (timing === 'before') navigation = page.navigate({ url: `${f.origin}/allowed/start` });
      vi.spyOn(page, 'dispatchAction').mockImplementationOnce(async (_, onDispatch) => {
        onDispatch();
        const request = requestFor(raw);
        raw.emit('request', request);
        deny(page, request);
        if (timing === 'during') navigation = page.navigate({ url: `${f.origin}/allowed/start` });
        return effect();
      });
      expect(await page.act({ type: 'press', key: 'Tab' })).not.toHaveProperty(
        'navigationObservation'
      );
      release.resolve();
      await navigation;
    } finally {
      release.resolve();
      await f.close();
    }
  }
);

it('removes request listeners after a failed action and does not replay or retain its denial', async () => {
  const f = await fixture();
  try {
    const page = f.page as CollectorPage;
    const raw = page.backingPage();
    const before = ['request', 'response', 'requestfailed'].map((name) => raw.listenerCount(name));
    const dispatch = vi
      .spyOn(page, 'dispatchAction')
      .mockImplementationOnce(async (_, onDispatch) => {
        onDispatch();
        const request = requestFor(raw);
        raw.emit('request', request);
        deny(page, request);
        throw new Error('fixture action failure');
      });
    await expect(page.act({ type: 'press', key: 'Tab' })).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(['request', 'response', 'requestfailed'].map((name) => raw.listenerCount(name))).toEqual(
      before
    );
    expect(await page.act({ type: 'press', key: 'Tab' })).not.toHaveProperty(
      'navigationObservation'
    );
  } finally {
    await f.close();
  }
});
