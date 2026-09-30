import { createServer } from 'node:http';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { expect, it } from 'vitest';

// Retired the R4 truth guard: all-hop enforcement walks redirect chains
// Node-side, so every hop is policy-checked and a denied terminal is never
// fetched. This end-to-end test pins the fixed behavior on real Chromium:
// the forbidden destination is checked, denied, and never reached.
it('all-hop enforcement: a redirect chain is policy-checked hop by hop', async () => {
  const hits: string[] = [];
  const checked: string[] = [];
  const fixture = createServer((request, response) => {
    const path = request.url ?? '/';
    if (!['/start', '/hop', '/forbidden'].includes(path)) {
      response.writeHead(204).end();
      return;
    }
    hits.push(path);
    if (path === '/forbidden') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<title>Forbidden fixture</title>');
      return;
    }
    response.writeHead(302, { location: path === '/start' ? '/hop' : '/forbidden' });
    response.end();
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const engine = new PlaywrightChromiumEngine();
  try {
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const session = await engine.createSession({
      requestPolicy: {
        async checkRequest({ url }) {
          const path = new URL(url).pathname;
          checked.push(path);
          if (path === '/forbidden') throw new Error('POLICY_DENIED: forbidden fixture');
        },
      },
    });
    const page = await session.newPage();
    const result = await page.navigate({ url: `http://127.0.0.1:${address.port}/start` });
    // The denied terminal hop blocks the navigation instead of loading.
    expect(result.status).toBe('blocked');
    // Every hop was policy-checked, including the denied one.
    expect(checked).toEqual(['/start', '/hop', '/forbidden']);
    // The forbidden destination was never reached: zero forbidden hits.
    expect(hits).toEqual(['/start', '/hop']);
  } finally {
    await engine.close();
    fixture.closeAllConnections();
    await new Promise<void>((fixtureClosed) => fixture.close(() => fixtureClosed()));
  }
}, 30_000);

it('allowed chains land the document at the verified terminal URL', async () => {
  const hits: string[] = [];
  const checked: string[] = [];
  const fixture = createServer((request, response) => {
    const path = request.url ?? '/';
    if (!['/login', '/final', '/favicon.ico'].includes(path)) {
      response.writeHead(204).end();
      return;
    }
    hits.push(path);
    if (path === '/final') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<title>Final page</title>');
      return;
    }
    response.writeHead(302, { location: '/final' });
    response.end();
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const engine = new PlaywrightChromiumEngine();
  try {
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const session = await engine.createSession({
      requestPolicy: {
        async checkRequest({ url }) {
          checked.push(new URL(url).pathname);
        },
      },
    });
    const page = await session.newPage();
    const result = await page.navigate({ url: `http://127.0.0.1:${address.port}/login` });
    // The document lands at the verified terminal address, not the
    // pre-redirect one — every hop was checked (extra routed requests like
    // favicon probes are allowed for, hence contains-not-equals).
    expect(result.status).toBe('success');
    expect(new URL(result.url).pathname).toBe('/final');
    expect(checked).toContain('/login');
    expect(checked).toContain('/final');
    expect(hits).toContain('/final');
    expect(hits).not.toContain('/forbidden');
  } finally {
    await engine.close();
    fixture.closeAllConnections();
    await new Promise<void>((fixtureClosed) => fixture.close(() => fixtureClosed()));
  }
}, 30_000);
