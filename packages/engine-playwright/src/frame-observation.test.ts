import { type Server, createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

// T6 slice 1: child-frame observation and ref binding. Truth guard first —
// these gates pin the OVH Manager handoff's gap (embedded-application iframe
// content invisible to observe) and then the fixed traversal. All fixtures
// are local; no accounts.

const mainPage = `
<iframe src="/frame-a" name="frame-a" title="Frame A"></iframe>
<iframe src="/frame-b" name="frame-b" title="Frame B"></iframe>
<iframe srcdoc="<button>Srcdoc Action</button>" title="Srcdoc"></iframe>
<iframe src="/nested" name="nested" title="Nested"></iframe>
<iframe src="/deep1" name="deep1" title="Deep1"></iframe>
<main><button>Main Action</button></main>`;
const frameADiv = `<div onclick="this.textContent='DIV-DONE'" style="width:80px;height:30px">Div Action</div>`;

const frameA = `<button onclick="this.textContent='DONE-A'">Frame A Action</button>
<button onclick="this.textContent='DONE-SUB-A'">Submit</button>
${frameADiv}`;
const frameB = `<button onclick="this.textContent='DONE-B'">Frame B Action</button>
<button onclick="this.textContent='DONE-SUB-B'">Submit</button>`;
const nestedOuter = `<iframe src="/nested-inner" name="inner" title="Inner"></iframe>`;
const nestedInner = `<button onclick="this.textContent='DONE-NESTED'">Nested Action</button>`;
const deep1 = `<iframe src="/deep2" name="d2" title="D2"></iframe>`;
const deep2 = `<iframe src="/deep3" name="d3" title="D3"></iframe>`;
const deep3 = `<button onclick="this.textContent='DONE-D3'">Deep 3 Action</button>
<iframe src="/deep4" name="d4" title="D4"></iframe>`;
const deep4 = '<button>Deep 4 Action</button>';

function startServers(): Promise<{
  main: string;
  crossOrigin: string;
  close: () => Promise<void>;
}> {
  const main = createServer((request, response) => {
    const path = request.url ?? '/';
    const body =
      path === '/frame-a'
        ? frameA
        : path === '/frame-b'
          ? frameB
          : path === '/nested'
            ? nestedOuter
            : path === '/nested-inner'
              ? nestedInner
              : path === '/deep1'
                ? deep1
                : path === '/deep2'
                  ? deep2
                  : path === '/deep3'
                    ? deep3
                    : path === '/deep4'
                      ? deep4
                      : path === '/frame-a-div'
                        ? frameADiv
                        : mainPage;
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(body);
  });
  // A second origin (different port) for the cross-origin frame case.
  const cross = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(frameB);
  });
  return new Promise((resolve) => {
    main.listen(0, '127.0.0.1', () => {
      cross.listen(0, '127.0.0.1', () => {
        const mainPort = (main.address() as { port: number }).port;
        const crossPort = (cross.address() as { port: number }).port;
        resolve({
          main: `http://127.0.0.1:${mainPort}/`,
          crossOrigin: `http://127.0.0.1:${crossPort}/`,
          close: async () => {
            main.closeAllConnections();
            cross.closeAllConnections();
            await Promise.all([
              new Promise<void>((done) => main.close(() => done())),
              new Promise<void>((done) => cross.close(() => done())),
            ]);
          },
        });
      });
    });
  });
}

async function waitForElement(
  page: {
    observe(request?: { mode?: string }): Promise<{
      elements: Array<{ role: string; name?: string; ref?: string }>;
    }>;
  },
  name: string,
  timeoutMs = 10_000
): Promise<{ role: string; name?: string; ref?: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: { role: string; name?: string; ref?: string } | undefined;
  while (Date.now() < deadline) {
    const observation = await page.observe({ mode: 'interactive' });
    last = observation.elements.find((element) => element.name === name);
    if (last?.ref !== undefined) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  expect(last, `element "${name}" never appeared with a ref`).toBeDefined();
  throw new Error('unreachable');
}

describe('child-frame observation and ref binding (T6)', () => {
  it('observes and acts through a same-origin iframe', async () => {
    const servers = await startServers();
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: servers.main });

      // Truth guard (pre-fix this omitted frame content entirely).
      const button = await waitForElement(page, 'Frame A Action');
      const result = await page.act({ type: 'click', target: { ref: button.ref } });
      expect(result).toBeDefined();

      // The click landed in the frame: the button toggled its own name.
      const after = await page.observe({ mode: 'interactive' });
      expect(after.elements.find((element) => element.name === 'DONE-A')).toBeDefined();
      expect(after.elements.find((element) => element.name === 'Frame A Action')).toBeUndefined();
    } finally {
      await engine.close();
      await servers.close();
    }
  }, 60_000);

  it('observes and acts through a cross-origin iframe', async () => {
    const servers = await startServers();
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      const frameHtml = frameB.replace('/frame-b', `${servers.crossOrigin}frame-cross`);
      void frameHtml;
      // Point the second iframe at the cross-origin server.
      await page.navigate({ url: `${servers.main}` });
      // The main page references /frame-b on the MAIN origin; navigate the
      // dedicated cross-origin case through a page whose iframe points at
      // the second server.
      const crossPage = await session.newPage();
      const crossMain = await servers.main;
      const crossServerPage = `
<iframe src="${servers.crossOrigin}" name="cross" title="Cross"></iframe>`;
      const holder = createServer((request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(crossServerPage);
      });
      await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
      const holderUrl = `http://127.0.0.1:${(holder.address() as { port: number }).port}/`;
      try {
        await crossPage.navigate({ url: holderUrl });
        const button = await waitForElement(crossPage, 'Frame B Action');
        await crossPage.act({ type: 'click', target: { ref: button.ref } });
        const after = await crossPage.observe({ mode: 'interactive' });
        expect(after.elements.find((element) => element.name === 'DONE-B')).toBeDefined();
        void crossMain;
        void frameHtml;
      } finally {
        holder.closeAllConnections();
        await new Promise<void>((done) => holder.close(() => done()));
        await crossPage.close().catch(() => {});
      }
      void page;
    } finally {
      await engine.close();
      await servers.close();
    }
  }, 60_000);

  it('binds duplicate labels per frame without retargeting', async () => {
    const servers = await startServers();
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: servers.main });

      const observation = await page.observe({ mode: 'interactive' });
      const named = observation.elements.filter((element) => element.name === 'Submit');
      expect(named.length).toBe(2);
      // Order follows document order: frame-a's copy precedes frame-b's.
      // Each click mutates its own frame's DOM, so refs are re-minted by
      // observing between clicks (refs are revision-scoped by design).
      await page.act({ type: 'click', target: { ref: named[0]?.ref } });
      let after = await page.observe({ mode: 'interactive' });
      expect(after.elements.find((element) => element.name === 'DONE-SUB-A')).toBeDefined();
      const remaining = after.elements.find((element) => element.name === 'Submit');
      expect(remaining?.ref).toBeDefined();

      await page.act({ type: 'click', target: { ref: remaining?.ref } });
      after = await page.observe({ mode: 'interactive' });
      expect(after.elements.find((element) => element.name === 'DONE-SUB-B')).toBeDefined();
      expect(after.elements.find((element) => element.name === 'DONE-SUB-A')).toBeDefined();
    } finally {
      await engine.close();
      await servers.close();
    }
  }, 60_000);

  it('reports depth-exceeded frames in coverage without faking completeness', async () => {
    const servers = await startServers();
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: servers.main });
      await waitForElement(page, 'Deep 3 Action');

      const observation = await page.observe({ mode: 'interactive' });
      // Depth-3 content is merged; the depth-4 frame is covered, not silent.
      expect(
        observation.elements.find((element) => element.name === 'Deep 3 Action')
      ).toBeDefined();
      expect(
        observation.elements.find((element) => element.name === 'Deep 4 Action')
      ).toBeUndefined();
      const coverage = (observation as { frameCoverage?: Array<{ frame: string; status: string }> })
        .frameCoverage;
      expect(coverage).toBeDefined();
      expect(coverage?.some((entry) => entry.status === 'depth_exceeded')).toBe(true);
      // Frame nodes themselves are never bindable refs.
      expect(observation.elements.find((element) => element.role === 'iframe')).toBeUndefined();
    } finally {
      await engine.close();
      await servers.close();
    }
  }, 60_000);

  it('binds role-less in-frame controls through the formControls scan', async () => {
    const servers = await startServers();
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: servers.main });
      await waitForElement(page, 'Frame A Action');

      const observation = await page.observe({
        mode: 'interactive',
        include: ['formControls'],
      });
      const control = observation.elements.find(
        (element) => element.role === 'control' && element.name === 'Div Action'
      );
      expect(control?.ref).toBeDefined();
      await page.act({ type: 'click', target: { ref: control?.ref } });
      const after = await page.observe({
        mode: 'interactive',
        include: ['formControls'],
      });
      expect(after.elements.find((element) => element.name === 'DIV-DONE')).toBeDefined();
    } finally {
      await engine.close();
      await servers.close();
    }
  }, 60_000);

  it('observes srcdoc and nested (depth 2) frame content', async () => {
    const servers = await startServers();
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: servers.main });

      await waitForElement(page, 'Srcdoc Action');
      const nested = await waitForElement(page, 'Nested Action');
      await page.act({ type: 'click', target: { ref: nested.ref } });
      const after = await page.observe({ mode: 'interactive' });
      expect(after.elements.find((element) => element.name === 'DONE-NESTED')).toBeDefined();
    } finally {
      await engine.close();
      await servers.close();
    }
  }, 60_000);
});
