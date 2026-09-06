import { createServer } from 'node:http';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { expect, it } from 'vitest';

// Truth guard, not a security acceptance test. T1 must replace these assertions
// with zero forbidden destination hits when all-hop enforcement is delivered.
it('known R4 gap: a later browser redirect reaches a policy-denied destination', async () => {
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
      response.end('<title>Redirect gap fixture</title>');
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
    expect(result.status).toBe('success');
    expect(new URL(result.url).pathname).toBe('/forbidden');
    expect(hits).toEqual(['/start', '/hop', '/forbidden']);
    expect(checked).toContain('/start');
    // Older adapters cache hostname verdicts, so this end-to-end guard does
    // not assert policy callback counts or isolate routing from that cache.
    expect(checked).not.toContain('/forbidden');
  } finally {
    await engine.close();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
}, 30_000);
