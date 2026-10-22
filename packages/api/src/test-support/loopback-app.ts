import type { Server } from 'node:http';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { expect } from 'vitest';
import { buildServer } from '../server.js';

/**
 * The real-Chromium egress suites' shared bootstrap: start the caller's loopback fixture,
 * build an app whose policy allows loopback, and open one session scoped to the fixture's
 * `/allowed/` paths only. The caller owns the app's lifetime (close it in a finally).
 */
export async function startLoopbackScopedApp(fixture: Server) {
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const port = (fixture.address() as { port: number }).port;
  const app = await buildServer({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy({ blockLoopback: false }),
  });
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  const session = await post('/v1/sessions', {
    tenantId: 'local',
    policy: { scope: { allowedHosts: ['127.0.0.1'], pathRules: [{ prefix: '/allowed/' }] } },
  });
  expect(session.statusCode).toBe(201);
  const sessionPath = `/v1/sessions/${session.json().sessionId}`;
  return { port, app, post, sessionPath };
}
