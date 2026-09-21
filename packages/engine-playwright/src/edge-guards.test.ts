import type { EngineEvent, EnginePage } from '@agentbrowser/engine';
import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

function backingPage(page: EnginePage): Page {
  return (page as unknown as { backingPage(): Page }).backingPage();
}

/**
 * Input-validation guards, settle rules, and capture caps the older suites
 * never exercised: typed refusals that must leave the page untouched, the
 * beforeunload auto-settle, the 50-link href cap, and selector waits that
 * succeed.
 */
describe('action guards and capture caps (real Chromium)', () => {
  it('refuses a non-string expectValue before writing the field', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({ url: 'data:text/html,<label>Code<input aria-label="Code"></label>' });
      const ref = (await page.observe({})).elements.find((el) => el.name === 'Code')?.ref;
      if (!ref) throw new Error('Missing observed input');

      await expect(
        page.act({ type: 'fill', target: { ref }, value: 'x', expectValue: 42 as unknown })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      // The refusal happened before any write.
      expect(await backingPage(page).locator('input').inputValue()).toBe('');
    } finally {
      await engine.close();
    }
  });

  it('refuses an empty typeText before any keystroke', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({ url: 'data:text/html,<label>Q<input aria-label="Q"></label>' });
      const ref = (await page.observe({})).elements.find((el) => el.name === 'Q')?.ref;
      if (!ref) throw new Error('Missing observed input');

      await expect(
        page.act({ type: 'typeText', target: { ref }, value: '' })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(await backingPage(page).locator('input').inputValue()).toBe('');
    } finally {
      await engine.close();
    }
  });

  it('waits for networkidle and a visible selector when the state is already reached', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({ url: 'data:text/html,<main><button>Late</button></main>' });

      await expect(
        page.act({ type: 'wait', condition: { until: 'networkidle' } })
      ).resolves.toMatchObject({ result: { success: true } });
      await expect(
        page.waitForSelector('main button', { timeoutMs: 2000 })
      ).resolves.toBeUndefined();
    } finally {
      await engine.close();
    }
  });

  it('caps href capture at the first 50 links that carry a non-empty href', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      const links = Array.from({ length: 60 }, (_, i) => `<a href="/dest-${i}">Link ${i}</a>`).join(
        ''
      );
      // The 51st link has an empty href: caps count successful captures, and
      // an empty href does not count against the cap.
      await page.navigate({
        url: `data:text/html,${links}<a href="">Empty</a><a href="/after">Link 60</a>`,
      });
      const state = await page.observe({});

      const withHref = state.elements.filter((el) => el.role === 'link' && el.href !== undefined);
      expect(withHref.length).toBe(50);
      expect(withHref[0]?.href).toBe('/dest-0');
      expect(withHref[49]?.href).toBe('/dest-49');
      // The empty-href and capped links carry no href at all.
      const empty = state.elements.find((el) => el.name === 'Empty');
      expect(empty?.href).toBeUndefined();
    } finally {
      await engine.close();
    }
  });

  it('auto-accepts a beforeunload dialog after the grace so the navigation proceeds', async () => {
    const engine = new PlaywrightChromiumEngine({ dialogGraceMs: 500 });
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      const fixtures = await originFixtures();
      try {
        await page.navigate({ url: `${fixtures.origin}/beforeunload` });
        const events: EngineEvent[] = [];
        (async () => {
          for await (const event of page.events()) {
            events.push(event);
          }
        })().catch(() => {});

        // The click is the user gesture Chromium requires before it honors a
        // beforeunload dialog; the navigation stalls on the dialog.
        const leave = (await page.observe({})).elements.find((el) => el.name === 'Leave');
        if (!leave?.ref) throw new Error('Missing observed Leave button');
        const clickPromise = page
          .act({ type: 'click', target: { ref: leave.ref } })
          .catch(() => {});

        await vi.waitFor(() => {
          expect(events.some((e) => e.type === 'dialog.opened')).toBe(true);
        });
        const opened = events.find((e) => e.type === 'dialog.opened');
        expect(opened?.data).toMatchObject({ dialogType: 'beforeunload' });

        // No agent settles it: past the grace the engine auto-ACCEPTS
        // (dismissing a beforeunload would cancel the navigation).
        await vi.waitFor(() => {
          expect(events.some((e) => e.type === 'dialog.closed' && e.data?.reason === 'auto')).toBe(
            true
          );
        });
        await clickPromise;
        await vi.waitFor(() => {
          expect(page.getCachedUrl?.()).toBe(`${fixtures.origin}/left`);
        });
        await page.close().catch(() => {});
        await session.close();
      } finally {
        await engine.close();
        await fixtures.stop();
      }
    } finally {
      await engine.close().catch(() => {});
    }
  });

  it('disposes the form-identity state on close when an observation created one', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({
        url: 'data:text/html,<div data-automation-id="widget">w</div>',
      });
      const state = await page.observe({ include: ['formControls'] });
      expect(state.elements.some((el) => el.role === 'control')).toBe(true);
      await page.close();
      await session.close();
    } finally {
      await engine.close();
    }
  });

  it('fails an observation racing a page close without corrupting the session', async () => {
    // A 1ms snapshot budget degrades every observation to the DOM-tag scan;
    // 800 buttons keep that scan busy long enough to race the page close.
    const engine = new PlaywrightChromiumEngine({ snapshotTimeoutMs: 1 });
    try {
      const session = await engine.createSession({ headless: true, snapshotTimeoutMs: 1 });
      const page = await session.newPage();
      const many = Array.from({ length: 800 }, (_, i) => `<button>B${i}</button>`).join('');
      await page.navigate({ url: `data:text/html,${many}` });

      const racing = page.observe({});
      await new Promise((resolve) => setTimeout(resolve, 300));
      await page.close();
      await expect(racing).rejects.toThrow();

      // The failed observation must not leave the session poisoned: refs were
      // dropped wholesale and the next page observes normally (degraded, since
      // the whole session runs on a 1ms snapshot budget, but with elements).
      const next = await session.newPage();
      await next.navigate({ url: 'data:text/html,<button>After</button>' });
      const state = await next.observe({});
      expect(state.degraded).toBe(true);
      expect(state.elements.some((el) => el.role === 'button')).toBe(true);
      await next.close();
      await session.close();
    } finally {
      await engine.close();
    }
  }, 20_000);
});

/** Loopback origin fixture: a beforeunload page and its navigation target. */
async function originFixtures(): Promise<{
  origin: string;
  stop(): Promise<void>;
}> {
  const http = await import('node:http');
  const server = http.createServer((request, response) => {
    if ((request.url ?? '/').startsWith('/left')) {
      response.writeHead(200, { 'content-type': 'text/html' }).end('<body>left</body>');
      return;
    }
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        '<!DOCTYPE html><body>' +
          '<script>window.addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = ""; });</script>' +
          '<button onclick="location.href=\'/left\'">Leave</button>' +
          '</body>'
      );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
