import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { build } from 'esbuild';
import { expect } from 'vitest';
import { buildServer } from '../server.js';

export type FixtureApp<S> = {
  /** The loopback fixture server (already listening). */
  fixture: Server;
  /** The esbuild bundle of `appSource` (assert non-trivial to prove it really bundled). */
  bundle: string;
  /** The app's last reported state, or the reset value before it reports. */
  readonly state: S;
  /** How many form submissions the app reported. */
  readonly submissions: number;
  reset(next: S): void;
  dispose(): Promise<void>;
};

/**
 * The bundle-fixture-server harness the real react-select suites share: esbuild-bundle
 * `appSource`, serve it on loopback with the /state + /submitted oracle channels the app
 * reports into, and expose the reported state as the independent oracle. `dispose()` is
 * the suite's afterAll.
 */
export async function bundleFixtureServer<S>(options: {
  appSource: string;
  initialState: S;
}): Promise<FixtureApp<S>> {
  let state = options.initialState;
  let submissions = 0;
  const result = await build({
    stdin: { contents: options.appSource, resolveDir: import.meta.dirname, loader: 'js' },
    bundle: true,
    write: false,
    format: 'iife',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  const bundle = result.outputFiles[0]?.text ?? '';
  const fixture = createServer((request, response) => {
    if (request.url === '/bundle.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end(bundle);
      return;
    }
    if (request.url === '/state' || request.url === '/submitted') {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        if (request.url === '/state') state = JSON.parse(body);
        else submissions += 1;
        response.end('ok');
      });
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><div id="root"></div><script src="/bundle.js"></script>');
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  return {
    fixture,
    bundle,
    get state() {
      return state;
    },
    get submissions() {
      return submissions;
    },
    reset(next: S) {
      state = next;
      submissions = 0;
    },
    dispose: async () => {
      fixture.closeAllConnections();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    },
  };
}

/**
 * T6 W1/W3b: the bootstrap the real react-select qualification suites share — one
 * qualified server (loopback fixture allowed by policy), one session + page navigated
 * to the fixture URL. A missing browser binary surfaces here as a launch failure,
 * never as a 404 downstream, and the family is pinned so a qualification only passes
 * if the engine really drove `browser`.
 */
export const openRealBrowserApp = async (
  browser: 'chromium' | 'firefox' | 'webkit',
  fixture: { address(): AddressInfo | string }
) => {
  const owner = { authorization: 'Bearer owner' };
  const server = await buildServer({
    engine: new PlaywrightChromiumEngine({ browser }),
    networkPolicy: new NetworkPolicy({ blockLoopback: false, blockPrivateIPs: false }),
    apiKeys: new Map([[createHash('sha256').update('owner').digest('hex'), 'tenant']]),
  });
  const url = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  const created = await server.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: owner,
    payload: {},
  });
  expect([200, 201], created.body).toContain(created.statusCode);
  expect(created.json().engine.name).toBe(`playwright-${browser}`);
  const sessionId = created.json().sessionId as string;
  const pageResponse = await server.inject({
    method: 'POST',
    url: `/v1/sessions/${sessionId}/pages`,
    headers: owner,
  });
  expect([200, 201], pageResponse.body).toContain(pageResponse.statusCode);
  const pagePath = `/v1/sessions/${sessionId}/pages/${pageResponse.json().pageId as string}`;
  const nav = await server.inject({
    method: 'POST',
    url: `${pagePath}/navigate`,
    headers: owner,
    payload: { url, waitUntil: 'networkidle' },
  });
  expect(nav.statusCode).toBe(200);
  return { server, owner, url, pagePath };
};
