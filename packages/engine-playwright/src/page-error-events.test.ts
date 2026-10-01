import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

// N1 G1: uncaught page exceptions are failure facts agents cannot see any
// other way. The engine captures them as page.error events marked
// untrusted (page-derived text), and the service pump redacts them before
// storage (pinned at the service level).
describe('page.error event capture', () => {
  it('captures an uncaught page exception as an untrusted page.error event', async () => {
    const fixture = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<script>setTimeout(() => { throw new Error("boom-uncaught"); }, 0);</script>');
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const engine = new PlaywrightChromiumEngine();
    try {
      const address = fixture.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture address');
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      const iterator = page.events()[Symbol.asyncIterator]();
      await page.navigate({ url: `http://127.0.0.1:${address.port}/` });

      const deadline = Date.now() + 10_000;
      let captured: import('./index.js').EngineEvent | undefined;
      while (Date.now() < deadline) {
        const next = await Promise.race([
          iterator.next(),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 500)),
        ]);
        if (next === undefined || next.done) continue;
        if (next.value.type === 'page.error') {
          captured = next.value;
          break;
        }
      }
      expect(captured).toBeDefined();
      expect(captured?.untrustedContent).toBe(true);
      expect((captured?.data as { text?: string } | undefined)?.text).toContain('boom-uncaught');
    } finally {
      await engine.close();
      fixture.closeAllConnections();
      await new Promise<void>((fixtureClosed) => fixture.close(() => fixtureClosed()));
    }
  }, 30_000);
});
