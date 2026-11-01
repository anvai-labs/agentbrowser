// Context options set fixture DPR only; every tested gesture uses the public service.
import { createServer } from 'node:http';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { chromium, type Page } from 'playwright';
import { expect, it, vi } from 'vitest';
import { AgentBrowserService } from './service.js';

it.each([
  { dpr: 1, scrollbars: 'hidden' },
  { dpr: 2, scrollbars: 'hidden' },
  { dpr: 1, scrollbars: 'visible' },
  { dpr: 2, scrollbars: 'visible' },
])(
  'maps actual DPR$dpr image pixels with $scrollbars scrollbars to a small edge target after two-axis scrolling',
  async ({ dpr, scrollbars }) => {
    const launch = chromium.launch.bind(chromium);
    vi.spyOn(chromium, 'launch').mockImplementation(async (options) => {
      const browser = await launch({
        ...options,
        ...(scrollbars === 'visible' ? { ignoreDefaultArgs: ['--hide-scrollbars'] } : {}),
      });
      const newContext = browser.newContext.bind(browser);
      vi.spyOn(browser, 'newContext').mockImplementation((contextOptions) =>
        newContext({ ...contextOptions, deviceScaleFactor: dpr })
      );
      return browser;
    });
    const hits: Array<{ x: number; y: number }> = [];
    const fixture = createServer((req, res) => {
      if (req.url === '/hit') {
        let text = '';
        req.on('data', (chunk) => {
          text += chunk;
        });
        req.on('end', () => {
          hits.push(JSON.parse(text));
          res.end('ok');
        });
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(
        `<!doctype html><link rel=icon href="data:,"><style>body{width:2000px;height:2000px;margin:0}::-webkit-scrollbar{width:16px;height:16px}button{position:fixed;right:25px;bottom:25px;width:8px;height:8px;border:0;padding:0;background:rgb(41,178,92)}</style><button onclick="fetch('/hit',{method:'POST',body:JSON.stringify({x:event.clientX,y:event.clientY})});this.style.background='red'"></button>`
      );
    });
    await new Promise<void>((ok, bad) => {
      fixture.once('error', bad);
      fixture.listen(0, '127.0.0.1', ok);
    });
    const port = (fixture.address() as { port: number }).port;
    const service = new AgentBrowserService({
      engine: new PlaywrightChromiumEngine(),
      networkPolicy: new NetworkPolicy({ blockLoopback: false }),
      approvalPolicy: { unknownRisk: 'allow' },
    });
    try {
      const { sessionId } = await service.createSession({
        scope: { allowedHosts: ['127.0.0.1'], requestBudget: 100 },
        viewport: { width: 800, height: 600 },
      });
      const { pageId } = await service.createPage(sessionId);
      await service.navigate(sessionId, pageId, { url: `http://127.0.0.1:${port}/` });
      const native = (
        service as unknown as {
          requirePage(s: string, p: string): { enginePage: { backingPage(): Page } };
        }
      )
        .requirePage(sessionId, pageId)
        .enginePage.backingPage();
      await service.act(sessionId, pageId, { action: 'scroll', deltaX: 125, deltaY: 200 });
      await vi.waitFor(async () =>
        expect(await native.evaluate(() => scrollX > 0 && scrollY > 0)).toBe(true)
      );
      await native.evaluate(
        () =>
          new Promise<void>((resolve) => {
            let last = '';
            let stable = 0;
            const sample = () => {
              const current = [
                innerWidth,
                innerHeight,
                devicePixelRatio,
                scrollX,
                scrollY,
                visualViewport?.width,
                visualViewport?.height,
              ].join(',');
              stable = current === last ? stable + 1 : 0;
              last = current;
              if (stable >= 3) resolve();
              else requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          })
      );
      const point = await native.locator('button').evaluate((button) => {
        const r = button.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      const image = await service.screenshot(sessionId, pageId, {});
      const c = image.coordinates!;
      expect(c.devicePixelRatio).toBe(dpr);
      const viewport = await native.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        clientWidth: document.documentElement.clientWidth,
      }));
      if (scrollbars === 'visible') expect(viewport.clientWidth).toBeLessThan(viewport.width);
      expect(c.cssWidth).toBe(viewport.width);
      expect(c.cssHeight).toBe(viewport.height);
      expect(c.scrollX).toBeGreaterThan(0);
      expect(c.scrollY).toBeGreaterThan(0);
      // Pixel point comes from independently measured CSS bounds and fixture DPR,
      // never from the mapping implementation's reported CSS/raster ratio.
      const action = {
        action: 'clickAt',
        at: {
          unit: 'image' as const,
          x: point.x * dpr,
          y: point.y * dpr,
          captureId: c.captureId,
          rasterWidth: c.rasterWidth,
          rasterHeight: c.rasterHeight,
        },
      };
      const refused = await service.act(sessionId, pageId, action).catch((e) => e);
      expect(refused).toMatchObject({ code: 'APPROVAL_REQUIRED' });
      await service.act(sessionId, pageId, { ...action, approvalToken: refused.details.tokenId });
      await vi.waitFor(() => expect(hits).toHaveLength(1), { timeout: 3000 });
      expect(hits[0]?.x).toBeCloseTo(point.x, 0);
      expect(hits[0]?.y).toBeCloseTo(point.y, 0);
    } finally {
      await service.shutdown();
      vi.restoreAllMocks();
      fixture.closeAllConnections();
      await new Promise<void>((ok) => fixture.close(() => ok()));
    }
  },
  30000
);
