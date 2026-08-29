/**
 * Obscura egress choke-point probe (O2, highest-value security test)
 *
 * Probe-verified against Obscura v0.2.1 (2026-08-29), through this
 * engine with an instrumented fixture server:
 *
 * - Main-frame navigations ARE paused and the route handler runs
 *   (Fetch.requestPaused works; route.fetch works).
 * - Fetch.fulfillRequest is IGNORED. For every navigation - allowed or
 *   denied - Obscura re-fetches the URL from its own network stack
 *   after the pause. A permitted page renders from the native re-fetch
 *   (fixture sees 2 hits); a DENIED page is still fetched natively
 *   (fixture sees the denied URL hit) and navigate reports 'success'.
 * - route.fetch ignores `maxRedirects: 0` and follows 302s inside
 *   Obscura's network stack, fetching the redirect target before the
 *   Location policy check can deny it (the audit-bypass shape).
 * - Subresources (img/script/in-page fetch) are never fetched at all in
 *   the default build, so there is no subresource exfiltration channel
 *   today - but also no subresource rendering.
 *
 * Consequence: the engine-level egress choke point CANNOT enforce on
 * Obscura v0.2.1 - policy-denied hosts receive the requests. The only
 * network guard is Obscura's own private-IP block (which
 * --allow-private-network disables). Obscura is an experimental +
 * benchmark backend (spec §17.2); it must not be used where egress
 * enforcement is required. See docs/engines.md and docs/threat-model.md.
 */

import { existsSync } from 'node:fs';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createObscuraEngine } from './engine';
import type { ObscuraEngine } from './engine';

function resolveBinary(): string | undefined {
  const override = process.env.OBSCURA_BIN;
  if (override !== undefined && override !== '' && existsSync(override)) {
    return override;
  }
  const version = process.env.OBSCURA_VERSION ?? 'v0.2.1';
  const binName = process.platform === 'win32' ? 'obscura.exe' : 'obscura';
  const cached = new URL(`../../../.cache/obscura/${version}/${binName}`, import.meta.url).pathname;
  return existsSync(cached) ? cached : undefined;
}

const binary = resolveBinary();
const suite = binary !== undefined ? describe : describe.skip;

interface Fixture {
  port: number;
  hits: string[];
  stop(): Promise<void>;
}

/** Loopback fixture with hit logging, a /canary path and /redirect?to=. */
function fixtureServer(): Promise<Fixture> {
  const fixture = { port: 0, hits: [] as string[], stop: async () => {} };
  const server = http.createServer((req, res) => {
    fixture.hits.push(req.url ?? '/');
    const url = req.url ?? '/';
    const port = (server.address() as { port: number }).port;
    const to = new URL(url, `http://127.0.0.1:${port}`).searchParams.get('to');
    if (url.startsWith('/redirect') && to !== null) {
      res.writeHead(302, { location: to }).end();
      return;
    }
    if (url.startsWith('/canary')) {
      const body = '<!DOCTYPE html><html><body>secret</body></html>';
      res
        .writeHead(200, { 'content-type': 'text/html', 'content-length': String(body.length) })
        .end(body);
      return;
    }
    const body = '<!DOCTYPE html><html><body>ok</body></html>';
    res
      .writeHead(200, { 'content-type': 'text/html', 'content-length': String(body.length) })
      .end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      fixture.port = (server.address() as { port: number }).port;
      fixture.stop = () => new Promise((done) => server.close(() => done()));
      resolve(fixture);
    });
  });
}

/** Wait up to `ms` for a fixture hit matching `path`. */
async function waitForHit(fixture: Fixture, path: string, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fixture.hits.some((hit) => hit.startsWith(path))) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return fixture.hits.some((hit) => hit.startsWith(path));
}

suite('Obscura egress choke point', () => {
  let obscura: ObscuraEngine;
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await fixtureServer();
    obscura = await createObscuraEngine({
      // --allow-private-network: Obscura blocks loopback by its own SSRF
      // defense by default. The fixture and the CDP endpoint live on
      // loopback, so the tests opt in; note that our own egress policy
      // CANNOT enforce on Obscura (see the truth-guard test below).
      launch: { binary, args: ['--allow-private-network'] },
      egress: {
        async checkRequest(request: { hostname: string; url?: string }) {
          if ((request.url ?? '').includes('/canary')) {
            throw new Error('denied by policy');
          }
        },
      },
    });
  }, 30_000);

  afterAll(async () => {
    await obscura?.shutdown();
    await fixture?.stop();
  });

  it('allows a permitted host through the choke point', async () => {
    const session = await obscura.engine.createSession({ headless: true });
    const page = await session.newPage();
    const result = await page.navigate({ url: `http://127.0.0.1:${fixture.port}/links` });
    expect(['success', 'timeout']).toContain(result.status);
    await session.close('done');
  }, 60_000);

  // gap: Obscura v0.2.1 ignores Fetch.fulfillRequest and re-fetches the
  // URL natively after the pause, so a denied navigation reports
  // 'success' and the denied host IS contacted. Enforcement is
  // Chromium-only. Un-skip when the truth guard below starts failing.
  it.skip('blocks a direct navigation to a denied host', async () => {
    const session = await obscura.engine.createSession({ headless: true });
    const page = await session.newPage();
    const result = await page.navigate({ url: 'http://example.com/x' });
    expect(result.status).toBe('blocked');
    await session.close('done');
  }, 60_000);

  // gap: route.fetch follows the 302 inside Obscura's network stack
  // (maxRedirects: 0 ignored), fetching the denied redirect target
  // before the Location check can deny it - the audit-bypass shape.
  // Un-skip when the truth guard below starts failing AND a redirect
  // probe shows maxRedirects honored.
  it.skip('blocks a redirect to a denied host (the audit-bypass shape)', async () => {
    const session = await obscura.engine.createSession({ headless: true });
    const page = await session.newPage();
    const result = await page.navigate({
      url: `http://127.0.0.1:${fixture.port}/redirect?to=http://example.com/x`,
    });
    expect(result.status).toBe('blocked');
    await session.close('done');
  }, 60_000);

  // Truth guard: encodes the CURRENT Obscura behavior so an upstream fix
  // (honoring Fetch.fulfillRequest) flips this test red and prompts
  // un-skipping the deny tests above. On Obscura v0.2.1 the policy
  // denial is NOT enforced: the denied URL is fetched natively and the
  // navigation reports 'success'. On Chromium both assertions fail
  // (blocked + zero hits), which is exactly the engine difference this
  // guard pins.
  it('guard: policy denial is not enforced (denied URL still fetched, reports success)', async () => {
    const session = await obscura.engine.createSession({ headless: true });
    const page = await session.newPage();
    const result = await page.navigate({ url: `http://127.0.0.1:${fixture.port}/canary` });
    expect(result.status).toBe('success');
    const deniedFetched = await waitForHit(fixture, '/canary');
    expect(deniedFetched).toBe(true);
    await session.close('done');
  }, 60_000);
});
