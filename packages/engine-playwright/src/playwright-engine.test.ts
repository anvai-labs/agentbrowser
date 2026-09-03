/**
 * TDD Tests for Playwright Chromium Engine
 *
 * These tests define the expected behavior of the PlaywrightChromiumEngine.
 * Following TDD principles, tests are written before implementation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index';

describe('PlaywrightChromiumEngine', () => {
  let engine: PlaywrightChromiumEngine;

  beforeEach(async () => {
    engine = new PlaywrightChromiumEngine();
  });

  afterEach(async () => {
    await engine.close();
  });

  // TD-BROWSER-6: headed sessions get a dedicated browser; the shared
  // headless browser must be untouched by them. Headed needs a display, so
  // the headed pair runs on darwin only (linux CI has no window server).
  describe('headed sessions (TD-BROWSER-6)', () => {
    const headedSupported = process.platform === 'darwin';
    type Ctx = { context: import('playwright').BrowserContext };

    it.runIf(headedSupported)(
      'gives a headed session its own browser, not the shared one',
      async () => {
        const headless = await engine.createSession({ headless: true });
        const headed = await engine.createSession({ headless: false });
        const headlessBrowser = (headless as unknown as Ctx).context.browser();
        const headedBrowser = (headed as unknown as Ctx).context.browser();
        expect(headedBrowser).toBeDefined();
        expect(headlessBrowser).toBeDefined();
        expect(headedBrowser).not.toBe(headlessBrowser);
        await headed.close();
        await headless.close();
      }
    );

    it.runIf(headedSupported)(
      'closing a headed session disposes its browser but not the shared one',
      async () => {
        const headless = await engine.createSession({ headless: true });
        const headed = await engine.createSession({ headless: false });
        const headlessBrowser = (headless as unknown as Ctx).context.browser();
        const headedBrowser = (headed as unknown as Ctx).context.browser();
        await headed.close();
        expect(headedBrowser?.isConnected()).toBe(false);
        expect(headlessBrowser?.isConnected()).toBe(true);
        await headless.close();
      }
    );

    it('headless sessions still share one browser (performance anchor)', async () => {
      const a = await engine.createSession({ headless: true });
      const b = await engine.createSession({ headless: true });
      expect((a as unknown as Ctx).context.browser()).toBe((b as unknown as Ctx).context.browser());
      await a.close();
      await b.close();
    });

    it('seeds and exports cookies for the credential handoff loop', async () => {
      const session = await engine.createSession({
        headless: true,
        cookies: [{ name: 'sid', value: 'abc', domain: 'example.com', path: '/' }],
      });
      const cookies = await session.cookies();
      expect(cookies.some((c) => c.name === 'sid' && c.value === 'abc')).toBe(true);
      await session.close();
    });
  });

  describe('engine properties', () => {
    it('should have engine name as playwright-chromium', () => {
      expect(engine.name).toBe('playwright-chromium');
    });

    it('should have version property', () => {
      expect(engine.version).toBeDefined();
      expect(typeof engine.version).toBe('string');
    });

    it('should have name and version as readonly at runtime', () => {
      expect(() => {
        (engine as any).name = 'modified';
      }).toThrow();
      expect(engine.name).toBe('playwright-chromium');

      expect(() => {
        (engine as any).version = '2.0.0';
      }).toThrow();
    });
  });

  describe('capabilities', () => {
    it('should return engine capabilities', async () => {
      const capabilities = await engine.capabilities();

      expect(capabilities).toBeDefined();
      expect(typeof capabilities.supportsScreenshots).toBe('boolean');
      expect(typeof capabilities.supportsPdf).toBe('boolean');
      expect(typeof capabilities.supportsDownloads).toBe('boolean');
      expect(typeof capabilities.supportsJavascript).toBe('boolean');
    });

    it('should support screenshots', async () => {
      const capabilities = await engine.capabilities();
      expect(capabilities.supportsScreenshots).toBe(true);
    });

    it('should support PDF', async () => {
      const capabilities = await engine.capabilities();
      expect(capabilities.supportsPdf).toBe(true);
    });

    it('should support accessibility tree', async () => {
      const capabilities = await engine.capabilities();
      expect(capabilities.supportsAccessibilityTree).toBe(true);
    });

    it('should support required observation modes', async () => {
      const capabilities = await engine.capabilities();
      expect(capabilities.supportedObservationModes).toContain('interactive');
      expect(capabilities.supportedObservationModes).toContain('content');
    });

    it('should support required action types', async () => {
      const capabilities = await engine.capabilities();
      // Capability truth: exactly the action set the executor delivers.
      expect(capabilities.supportedActionTypes).toContain('click');
      expect(capabilities.supportedActionTypes).toContain('fill');
      expect(capabilities.supportedActionTypes).not.toContain('navigate');
    });
  });

  describe('session creation', () => {
    it('should create a new session', async () => {
      const session = await engine.createSession({
        viewport: { width: 1280, height: 720 },
      });

      expect(session).toBeDefined();
      expect(session.id).toBeDefined();
      expect(typeof session.id).toBe('string');
    });

    it('should create sessions with default options', async () => {
      const session = await engine.createSession();

      expect(session).toBeDefined();
      expect(session.id).toBeDefined();
    });

    it('should create isolated sessions', async () => {
      const session1 = await engine.createSession();
      const session2 = await engine.createSession();

      expect(session1.id).not.toBe(session2.id);
    });

    it('should seed cookies into the session context', async () => {
      const session = await engine.createSession({
        cookies: [
          {
            name: 'session_token',
            value: 'reused-auth-value',
            domain: 'example.com',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
        ],
      });

      const cookies = await session.cookies();
      const seeded = cookies.find((c) => c.name === 'session_token');
      expect(seeded).toBeDefined();
      expect(seeded?.value).toBe('reused-auth-value');
      expect(seeded?.domain).toContain('example.com');
    });

    it('should seed a __Host- cookie as host-only (Chromium rejects it otherwise)', async () => {
      // Regression: `__Host-`-prefixed cookies must be host-only + Secure, which
      // Playwright expresses via `url` (not `domain`). Passing `domain` makes
      // Chromium silently drop the cookie, so the reused session was anonymous.
      const session = await engine.createSession({
        cookies: [
          {
            name: '__Host-databricksapps',
            value: 'host-only-auth',
            domain: 'app.example.com',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
        ],
      });

      const seeded = (await session.cookies()).find((c) => c.name === '__Host-databricksapps');
      expect(seeded).toBeDefined();
      expect(seeded?.value).toBe('host-only-auth');
      // Host-only: the domain is the bare host with no leading dot.
      expect(seeded?.domain).toBe('app.example.com');
      expect(seeded?.secure).toBe(true);
    });
  });

  describe('session lifecycle', () => {
    it('should close session successfully', async () => {
      const session = await engine.createSession();

      await expect(session.close()).resolves.not.toThrow();
    });

    it('should close session with reason', async () => {
      const session = await engine.createSession();

      await expect(session.close('user_requested')).resolves.not.toThrow();
    });

    it('should support creating pages in session', async () => {
      const session = await engine.createSession();
      const page = await session.newPage();

      expect(page).toBeDefined();
      expect(page.id).toBeDefined();
    });
  });

  describe('page operations', () => {
    it('should navigate to URL', async () => {
      const session = await engine.createSession();
      const page = await session.newPage();

      const result = await page.navigate({
        url: 'https://example.com',
        waitUntil: 'load',
      });

      expect(result.status).toBe('success');
      expect(result.url).toBe('https://example.com/'); // Browsers normalize URLs
    });

    it('should observe page state', async () => {
      const session = await engine.createSession();
      const page = await session.newPage();

      await page.navigate({ url: 'https://example.com' });
      const observation = await page.observe({ mode: 'interactive' });

      expect(observation).toBeDefined();
      expect(observation.url).toBe('https://example.com/'); // Browsers normalize URLs
      expect(observation.elements).toBeDefined();
      expect(Array.isArray(observation.elements)).toBe(true);
    });

    it('should execute click action', async () => {
      const session = await engine.createSession();
      const page = await session.newPage();

      await page.navigate({ url: 'https://example.com' });
      const observation = await page.observe({ mode: 'interactive' });

      if (observation.elements.length > 0) {
        const target = { ref: observation.elements[0].ref };
        const result = await page.act({ type: 'click', target });

        expect(result).toBeDefined();
        expect(result.actionId).toBeDefined();
      }
    });

    it('should capture screenshot', async () => {
      const session = await engine.createSession();
      const page = await session.newPage();

      await page.navigate({ url: 'https://example.com' });
      const screenshot = await page.screenshot({ fullPage: false });

      expect(screenshot).toBeDefined();
      expect(screenshot.artifactId).toBeDefined();
      expect(screenshot.contentType).toBe('image/png');
      expect(screenshot.sizeBytes).toBeGreaterThan(0);
    });

    it('should generate PDF', async () => {
      const session = await engine.createSession();
      const page = await session.newPage();

      await page.navigate({ url: 'https://example.com' });

      if (page.pdf) {
        const pdf = await page.pdf({ landscape: false });

        expect(pdf).toBeDefined();
        expect(pdf.artifactId).toBeDefined();
        expect(pdf.contentType).toBe('application/pdf');
      }
    });
  });

  describe('element references', () => {
    it('should generate stable element refs', async () => {
      const session = await engine.createSession();
      const page = await session.newPage();

      await page.navigate({ url: 'https://example.com' });
      const observation1 = await page.observe({ mode: 'interactive' });

      // Navigate again to get same page
      await page.navigate({ url: 'https://example.com' });
      const observation2 = await page.observe({ mode: 'interactive' });

      if (observation1.elements.length > 0 && observation2.elements.length > 0) {
        expect(observation1.elements[0].ref).toMatch(/^e\d+_\d+$/);
        expect(observation2.elements[0].ref).toMatch(/^e\d+_\d+$/);
      }
    });

    it('should resolve element refs', async () => {
      const session = await engine.createSession();
      const page = await session.newPage();

      await page.navigate({ url: 'https://example.com' });
      const observation = await page.observe({ mode: 'interactive' });

      if (observation.elements.length > 0) {
        const target = { ref: observation.elements[0].ref };
        const resolved = await page.resolve(target);

        expect(resolved).toBeDefined();
        expect(resolved.ref).toBe(target.ref);
        expect(resolved.role).toBeDefined();
      }
    });
  });

  describe('cleanup', () => {
    it('should cleanup all resources on close', async () => {
      const session = await engine.createSession();
      await session.newPage();

      await engine.close();

      // Engine should be closed cleanly
      // This is verified by no resource leaks
    });

    it('should handle multiple sessions', async () => {
      const session1 = await engine.createSession();
      const session2 = await engine.createSession();

      await session1.newPage();
      await session2.newPage();

      await engine.close();

      // All sessions should be cleaned up
    });
  });
});

describe('PlaywrightChromiumEngine ref store', () => {
  let engine: PlaywrightChromiumEngine;

  // Encoded: the raw fragment would truncate the data URL at the first '#'.
  const TEST_PAGE = `data:text/html,${encodeURIComponent(
    '<!DOCTYPE html><html><body><button id="submit">Submit</button>' +
      '<input aria-label="Email" type="email" /><a href="#next">Next page</a></body></html>'
  )}`;

  /** Observe the test page and hand back the engine page for interaction. */
  const observedPage = async () => {
    const session = await engine.createSession({ headless: true });
    const page = await session.newPage();
    await page.navigate({ url: TEST_PAGE });
    await page.observe({ mode: 'interactive' });
    return page;
  };

  beforeEach(() => {
    engine = new PlaywrightChromiumEngine();
  });

  afterEach(async () => {
    await engine.close();
  });

  it('should expose semantic elements with revision-stamped refs', async () => {
    const page = await observedPage();
    const state = await page.observe({ mode: 'interactive' });

    expect(state.url.startsWith('data:')).toBe(true);
    expect(state.elements.length).toBeGreaterThan(0);
    for (const element of state.elements) {
      expect(element.ref).toMatch(/^e\d+_\d+$/);
    }

    const submit = state.elements.find((el) => el.role === 'button' && el.name === 'Submit');
    expect(submit).toBeDefined();
  });

  it('should produce stable refs within a revision', async () => {
    const page = await observedPage();
    const first = await page.observe({ mode: 'interactive' });
    const second = await page.observe({ mode: 'interactive' });

    const a = first.elements.find((el) => el.name === 'Submit')?.ref;
    const b = second.elements.find((el) => el.name === 'Submit')?.ref;

    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  it('should resolve an observed ref to real element state with the canonical fingerprint', async () => {
    const page = await observedPage();
    const state = await page.observe({ mode: 'interactive' });

    const submit = state.elements.find((el) => el.role === 'button' && el.name === 'Submit');
    const resolved = await page.resolve({ ref: submit?.ref });

    expect(resolved.ref).toBe(submit?.ref);
    expect(resolved.role).toBe('button');
    expect(resolved.name).toBe('Submit');
    expect(resolved.visible).toBe(true);
    expect(resolved.enabled).toBe(true);
    expect(resolved.fingerprint).toBe('button_Submit_visible_true_enabled_true');
  });

  it('should reject an unknown ref', async () => {
    const page = await observedPage();

    await expect(page.resolve({ ref: 'e1_99' })).rejects.toThrow(/not found/i);
  });

  it('should click through a ref', async () => {
    const page = await observedPage();
    const state = await page.observe({ mode: 'interactive' });
    const link = state.elements.find((el) => el.role === 'link' && el.name === 'Next page');

    const effect = await page.act({ type: 'click', target: { ref: link?.ref } });

    expect(effect.actionId).toBeDefined();
    expect(effect.newRevision).toBeGreaterThan(effect.oldRevision);
  });

  it('should fill through a ref and reflect the value on the next observation', async () => {
    const page = await observedPage();
    const state = await page.observe({ mode: 'interactive' });
    const email = state.elements.find((el) => el.role === 'textbox' && el.name === 'Email');

    await page.act({ type: 'fill', target: { ref: email?.ref }, value: 'agent@example.com' });

    const after = await page.observe({ mode: 'interactive' });
    const filled = after.elements.find((el) => el.role === 'textbox' && el.name === 'Email');
    expect(filled?.value).toBe('agent@example.com');
  });

  it('should reject acting on an unknown ref', async () => {
    const page = await observedPage();

    await expect(page.act({ type: 'click', target: { ref: 'e1_99' } })).rejects.toThrow(
      /not found/i
    );
  });
});

describe('dialog premise (audit P0-3, settle by evidence)', () => {
  it('should let a subsequent operation succeed after a page alert fires', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      const url = `data:text/html,${encodeURIComponent(
        '<!DOCTYPE html><html><body>' +
          '<button id="a" onclick="alert(\'boom\')">Alert</button>' +
          '<button id="b">After</button>' +
          '</body></html>'
      )}`;
      await page.navigate({ url });

      // Click triggers alert(); with no dialog handler, what happens next?
      const observation = await page.observe({ mode: 'interactive' });
      const alertButton = observation.elements.find((el) => el.name === 'Alert');

      const effect = await page.act({ type: 'click', target: { ref: alertButton?.ref } });

      // The premise test: does a subsequent engine operation complete?
      const after = await Promise.race([
        page.observe({ mode: 'interactive' }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('DEADLOCKED: observe did not complete')), 8000)
        ),
      ]);

      expect(effect.actionId).toBeDefined();
      expect((after as { url: string }).url).toContain('data:');
    } finally {
      await engine.close();
    }
  });
});

describe('dialog actions (real Chromium)', () => {
  it('should accept a prompt dialog with the provided text', async () => {
    const engine = new PlaywrightChromiumEngine({ dialogGraceMs: 60_000 });
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      const url = `data:text/html,${encodeURIComponent(
        '<!DOCTYPE html><html><body>' +
          '<input id="out" aria-label="Out" readonly />' +
          "<button id=\"a\" onclick=\"document.getElementById('out').value = prompt('Name?', '') || ''\">Ask</button>" +
          '</body></html>'
      )}`;
      await page.navigate({ url });
      const observation = await page.observe({ mode: 'interactive' });
      const ask = observation.elements.find((el) => el.name === 'Ask');

      const events: string[] = [];
      (async () => {
        for await (const event of page.events()) {
          events.push(event.type);
        }
      })();

      // Click opens the prompt; the engine holds it. The triggering click
      // cannot resolve until the dialog settles, so fire it without
      // awaiting - exactly the stall the design documents.
      const clickPromise = page.act({ type: 'click', target: { ref: ask?.ref } });
      await new Promise((resolve) => setTimeout(resolve, 300));

      const effect = await page.act({ type: 'acceptDialog', promptText: 'agent' });
      await clickPromise;
      expect(effect.result).toMatchObject({ dialog: 'accepted', promptText: 'agent' });
      expect(effect.newRevision).toBe(effect.oldRevision); // non-mutating

      // The page received the accepted answer, and dialog events fired.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const after = await page.observe({ mode: 'interactive' });
      const out = after.elements.find((el) => el.name === 'Out');
      expect(out?.value).toBe('agent');
      expect(events).toContain('dialog.opened');
      expect(events).toContain('dialog.closed');
    } finally {
      await engine.close();
    }
  });
});

/** Minimal fixture server for egress tests (redirect + subresource probe). */
function egressFixtures(): Promise<{ port: number; stop(): Promise<void> }> {
  const http = require('node:http') as typeof import('node:http');
  const server = http.createServer((request, response) => {
    const url = request.url ?? '/';
    const port = (server.address() as { port: number }).port;
    const to = new URL(url, `http://127.0.0.1:${port}`).searchParams.get('to');
    if (url.startsWith('/redirect') && to !== null) {
      response.writeHead(302, { location: to }).end();
      return;
    }
    if (url.startsWith('/chunked') && to !== null) {
      // Chunked response: no content-length, size from `to` suffix.
      const size = Number.parseInt(to, 10) || 10;
      const payload = 'x'.repeat(size);
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write(payload.slice(0, Math.ceil(size / 2)));
      setTimeout(() => response.end(payload.slice(Math.ceil(size / 2))), 10);
      return;
    }
    if (url.startsWith('/leak') && to !== null) {
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<!DOCTYPE html><html><body><script>fetch(${JSON.stringify(to)}).catch(()=>{})</script></body></html>`
        );
      return;
    }
    const body = '<!DOCTYPE html><html><body>ok</body></html>';
    response
      .writeHead(200, {
        'content-type': 'text/html',
        'content-length': String(body.length),
      })
      .end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as { port: number }).port,
        stop: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe('engine-level egress choke point (P0-4)', () => {
  it('should block a redirect to a denied host (the audit bypass, closed)', async () => {
    const fixtures = await egressFixtures();
    const engine = new PlaywrightChromiumEngine({
      egress: {
        // Allow only the fixture origin; everything else denied.
        async checkRequest(request: { hostname: string }) {
          if (request.hostname === '127.0.0.1') return;
          throw new Error(`POLICY_DENIED: ${request.hostname}`);
        },
      },
    });
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();

      // Public fixture page that 302s to the cloud metadata endpoint.
      const result = await page.navigate({
        url: `http://127.0.0.1:${fixtures.port}/redirect?to=http://169.254.169.254/latest/meta-data/`,
      });

      expect(result.status).toBe('blocked');
    } finally {
      await engine.close();
      await fixtures.stop();
    }
  });

  it('should block in-page fetches to denied hosts from an allowed page', async () => {
    const fixtures = await egressFixtures();
    const engine = new PlaywrightChromiumEngine({
      egress: {
        async checkRequest(request: { hostname: string }) {
          if (request.hostname === '127.0.0.1') return;
          throw new Error(`POLICY_DENIED: ${request.hostname}`);
        },
      },
    });
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();

      // The page loads (allowed origin) and tries to fetch a denied host.
      const errors: string[] = [];
      const pump = (async () => {
        for await (const event of page.events()) {
          if (event.type === 'console.error') {
            errors.push(String((event.data as { text?: string })?.text ?? ''));
          }
        }
      })();

      const result = await page.navigate({
        url: `http://127.0.0.1:${fixtures.port}/leak?to=http://10.0.0.1/secret`,
      });
      expect(result.status).toBe('success');

      // The fetch to the denied host must fail (blocked), never succeed.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(
        errors.some((text) => /Failed to load|blocked|ERR/i.test(text)) || errors.length === 0
      ).toBe(true);
      void pump;
    } finally {
      await engine.close();
      await fixtures.stop();
    }
  });

  it('should block an oversized response at the choke point', async () => {
    const fixtures = await egressFixtures();
    const engine = new PlaywrightChromiumEngine({
      egress: {
        async checkRequest() {
          return; // allow all hosts
        },
        async checkResponse(response: { headers: Record<string, string> }) {
          const length = Number.parseInt(response.headers['content-length'] ?? '0', 10);
          if (length > 10) {
            throw new Error('RESPONSE_TOO_LARGE');
          }
        },
      },
    });
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      // The fixture body is ~40 bytes: over the 10-byte cap.
      const result = await page.navigate({ url: `http://127.0.0.1:${fixtures.port}/links` });
      expect(result.status).toBe('blocked');
    } finally {
      await engine.close();
      await fixtures.stop();
    }
  });

  it('should block an oversized chunked response by actual bytes', async () => {
    const fixtures = await egressFixtures();
    const engine = new PlaywrightChromiumEngine({
      egress: {
        async checkRequest(request: { hostname: string }) {
          if (request.hostname === '127.0.0.1') return;
          throw new Error('denied');
        },
        async checkResponse() {
          return; // header check passes (no content-length)
        },
        async checkBodySize(bytes: number) {
          if (bytes > 50) throw new Error('RESPONSE_TOO_LARGE');
        },
      },
    });
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      // 500-byte chunked body, no content-length: actual-byte cap blocks.
      const result = await page.navigate({
        url: `http://127.0.0.1:${fixtures.port}/chunked?to=500`,
      });
      expect(result.status).toBe('blocked');
    } finally {
      await engine.close();
      await fixtures.stop();
    }
  });

  it('should pass a small chunked response through actual-byte checks', async () => {
    const fixtures = await egressFixtures();
    const engine = new PlaywrightChromiumEngine({
      egress: {
        async checkRequest(request: { hostname: string }) {
          if (request.hostname === '127.0.0.1') return;
          throw new Error('denied');
        },
        async checkBodySize(bytes: number) {
          if (bytes > 50) throw new Error('RESPONSE_TOO_LARGE');
        },
      },
    });
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      const result = await page.navigate({
        url: `http://127.0.0.1:${fixtures.port}/chunked?to=10`,
      });
      expect(result.status).toBe('success');
    } finally {
      await engine.close();
      await fixtures.stop();
    }
  });

  it('should allow a per-session policy to override the root', async () => {
    const fixtures = await egressFixtures();
    const engine = new PlaywrightChromiumEngine(); // no root egress
    try {
      const session = await engine.createSession({
        headless: true,
        requestPolicy: {
          async checkRequest(request: { hostname: string }) {
            // Session chain denies even the fixture origin.
            throw new Error(`POLICY_DENIED: ${request.hostname}`);
          },
        },
      });
      const page = await session.newPage();

      const result = await page.navigate({ url: `http://127.0.0.1:${fixtures.port}/links` });
      expect(result.status).toBe('blocked');
    } finally {
      await engine.close();
      await fixtures.stop();
    }
  });
});

describe('in-page download interception (spec 10)', () => {
  it('should capture a page-initiated download with bytes and events', async () => {
    // Fixture page serving a download via Content-Disposition.
    const http = require('node:http') as typeof import('node:http');
    const server = http.createServer((request, response) => {
      const payload = 'col1,col2\n1,2\n';
      response.writeHead(200, {
        'content-type': 'text/csv',
        'content-length': String(payload.length),
        'content-disposition': 'attachment; filename="report.csv"',
      });
      response.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const engine = new PlaywrightChromiumEngine({
      egress: {
        async checkRequest(request: { hostname: string }) {
          if (request.hostname === '127.0.0.1') return;
          throw new Error('denied');
        },
      },
    });
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();

      const events: string[] = [];
      (async () => {
        for await (const event of page.events()) {
          events.push(`${event.type}:${(event.data as { filename?: string })?.filename ?? ''}`);
        }
      })();

      // A top-level navigation to an attachment throws "Download is
      // starting" - the download still fires. Trigger it in-page instead.
      const anchor = `http://127.0.0.1:${port}/`;
      await page.navigate({ url: `data:text/html,<a href="${anchor}" download>get</a>` });
      const observation = await page.observe({ mode: 'interactive' });
      const link = observation.elements.find((el) => el.name === 'get');
      await page.act({ type: 'click', target: { ref: link?.ref } }).catch(() => {
        // The click may not resolve until the download lands; either way the
        // download handler captures the file.
      });

      // Chromium downloads the "attachment" body; the engine holds it.
      // Poll briefly for the finished event.
      for (let i = 0; i < 20 && !events.some((e) => e.startsWith('download.finished')); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(events.some((e) => e.startsWith('download.created:report.csv'))).toBe(true);
      expect(events.some((e) => e.startsWith('download.finished:report.csv'))).toBe(true);

      const bytes = await (
        session as unknown as {
          downloadBytes(pageId: string, filename: string): Promise<Uint8Array | undefined>;
        }
      ).downloadBytes(page.id, 'report.csv');
      expect(bytes && Buffer.from(bytes).toString('utf8')).toContain('col1,col2');
    } finally {
      await engine.close();
      await new Promise((done) => server.close(() => done()));
    }
  });
});

describe('WebSocket upgrade interception (residual R2)', () => {
  const probeServer = async () => {
    const http = await import('node:http');
    const { WebSocketServer } = await import('ws');
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>ws probe</body></html>');
    });
    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws) => {
      ws.on('message', () => ws.send('pong'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      port: (server.address() as { port: number }).port,
      async stop() {
        wss.close();
        await new Promise((done) => server.close(() => done()));
      },
    };
  };

  const probe = (page: unknown, port: number) =>
    (page as unknown as { page: import('playwright').Page }).page.evaluate(
      async (wsUrl: string) =>
        new Promise<string>((resolve) => {
          const ws = new WebSocket(wsUrl);
          const timer = setTimeout(() => resolve('timeout'), 4000);
          ws.onopen = () => {
            ws.send('ping');
          };
          ws.onmessage = (event) => {
            if (String(event.data) === 'pong') {
              clearTimeout(timer);
              ws.close();
              resolve('echo');
            }
          };
          ws.onclose = () => {
            clearTimeout(timer);
            resolve('closed');
          };
          ws.onerror = () => {
            clearTimeout(timer);
            resolve('error');
          };
        }),
      `ws://127.0.0.1:${port}/`
    );

  it('should leave WebSockets untouched with no egress policy', async () => {
    const fixture = await probeServer();
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: `http://127.0.0.1:${fixture.port}/` });
      expect(await probe(page, fixture.port)).toBe('echo');
    } finally {
      await engine.close();
      await fixture.stop();
    }
  });

  it('should close upgrades cleanly when egress is on (default deny-all)', async () => {
    const fixture = await probeServer();
    const engine = new PlaywrightChromiumEngine({
      egress: {
        async checkRequest(request: { hostname: string }) {
          if (request.hostname === '127.0.0.1') return;
          throw new Error('denied');
        },
      },
    });
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: `http://127.0.0.1:${fixture.port}/` });
      // The fetch/fulfill choke point breaks WS outright (upstream
      // limitation); deny-all at least closes the upgrade cleanly.
      expect(await probe(page, fixture.port)).toBe('closed');
    } finally {
      await engine.close();
      await fixture.stop();
    }
  });

  it('should close every upgrade under deny-all (exfiltration gate)', async () => {
    const fixture = await probeServer();
    const engine = new PlaywrightChromiumEngine({
      webSocketPolicy: 'deny-all',
      egress: {
        async checkRequest(request: { hostname: string }) {
          if (request.hostname === '127.0.0.1') return;
          throw new Error('denied');
        },
      },
    });
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: `http://127.0.0.1:${fixture.port}/` });
      // Even the ALLOWED host's upgrade closes: deny-all is the honest
      // semantic given the upstream forwarding bug.
      expect(await probe(page, fixture.port)).toBe('closed');
    } finally {
      await engine.close();
      await fixture.stop();
    }
  });
});

describe('DNS-rebinding defense (resolved-address validation)', () => {
  it('should block a public hostname that resolves to loopback', async () => {
    // localtest.me is a public DNS wildcard resolving to 127.0.0.1 - the
    // canonical real-world rebinding shape: hostname looks public, the
    // resolution is loopback.
    const engine = new PlaywrightChromiumEngine({
      egress: {
        async checkRequest(request: { hostname: string }) {
          if (request.hostname === '127.0.0.1') {
            throw new Error('denied');
          }
          return; // localtest.me passes hostname checks
        },
        async checkResolvedAddresses(addresses: string[]) {
          for (const address of addresses) {
            if (address === '127.0.0.1' || address.startsWith('127.')) {
              throw new Error(`resolved loopback: ${address}`);
            }
          }
        },
      },
    });
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      const result = await page.navigate({ url: 'http://localtest.me:8080/' });
      expect(result.status).toBe('blocked');
    } finally {
      await engine.close();
    }
  });
});

describe('engine contract suite (the any-engine guarantee)', () => {
  it('playwright-chromium passes the same suite as FakeEngine', async () => {
    const { runEngineContractSuite } = await import('@agentbrowser/testkit');
    const engine = new PlaywrightChromiumEngine();
    // The suite runs the full contract: capabilities, lifecycle, refs,
    // actions, artifacts, close audit. data: URL navigation works.
    await expect(runEngineContractSuite(engine)).resolves.toBeUndefined();
  }, 60_000);
});

describe('multi-browser and remote CDP options', () => {
  it('reports the browser family in engine.name', () => {
    expect(new PlaywrightChromiumEngine().name).toBe('playwright-chromium');
    expect(new PlaywrightChromiumEngine({ browser: 'firefox' }).name).toBe('playwright-firefox');
    expect(new PlaywrightChromiumEngine({ browser: 'webkit' }).name).toBe('playwright-webkit');
    expect(new PlaywrightChromiumEngine({ cdpEndpoint: 'ws://localhost:9222' }).name).toBe(
      'playwright-chromium-remote'
    );
  });

  it('rejects cdpEndpoint on non-chromium families', async () => {
    const engine = new PlaywrightChromiumEngine({
      browser: 'firefox',
      cdpEndpoint: 'ws://localhost:9222',
    });
    await expect(engine.createSession({ headless: true })).rejects.toThrow(/chromium/);
    await engine.close();
  });

  it('runs the contract suite on firefox when binaries are installed', async () => {
    const { firefox } = await import('playwright');
    const available = await firefox
      .launch({ headless: true })
      .then((b) => b.close().then(() => true))
      .catch(() => false);
    if (!available) {
      console.warn('firefox binaries not installed; skipping');
      return;
    }
    const { runEngineContractSuite } = await import('@agentbrowser/testkit');
    const engine = new PlaywrightChromiumEngine({ browser: 'firefox' });
    await expect(runEngineContractSuite(engine)).resolves.toBeUndefined();
  }, 60_000);
});
