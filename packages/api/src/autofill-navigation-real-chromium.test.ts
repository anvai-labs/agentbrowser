import { createServer } from 'node:http';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { parseAutofillReport } from '@agentbrowser/protocol';
import { expect, it } from 'vitest';
import { buildServer } from './server.js';

it.each(['GET', 'POST'])(
  'REST autofill stops a widget sequence after an observed blocked %s redirect',
  async (method) => {
    let effects = 0;
    let deniedHits = 0;
    let subsequentWrites = 0;
    const fixture = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://fixture').pathname;
      if (path === '/allowed/effect') {
        effects++;
        request.resume();
        response.writeHead(307, { location: '/denied?fixture-secret=1' }).end();
      } else if (path === '/denied') {
        deniedHits++;
        response.end('denied');
      } else if (path === '/allowed/write') {
        subsequentWrites++;
        response.end('recorded');
      } else {
        response.writeHead(200, { 'content-type': 'text/html' }).end(`
          <html><head><link rel="icon" href="data:,"></head><body>
          <form id="effect" method="POST" action="/allowed/effect"></form>
          <label for="choice">Choice</label>
          <div class="select__value-container">
            <input id="choice" role="combobox" aria-autocomplete="list" aria-controls="menu"
              onclick="${method === 'GET' ? "location.assign('/allowed/effect')" : "document.getElementById('effect').requestSubmit()"}"
              oninput="fetch('/allowed/write')">
          </div>
          <div id="menu" role="listbox"><div role="option">Chicago</div></div>
          <label>Later<input oninput="fetch('/allowed/write')"></label>
          </body></html>`);
      }
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const port = (fixture.address() as { port: number }).port;
    const app = await buildServer({
      engine: new PlaywrightChromiumEngine(),
      networkPolicy: new NetworkPolicy({ blockLoopback: false }),
    });
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
    try {
      const session = await post('/v1/sessions', {
        tenantId: 'local',
        policy: { scope: { allowedHosts: ['127.0.0.1'], pathRules: [{ prefix: '/allowed/' }] } },
      });
      expect(session.statusCode).toBe(201);
      const sessionPath = `/v1/sessions/${session.json().sessionId}`;
      const created = await post(`${sessionPath}/pages`, {
        url: `http://127.0.0.1:${port}/allowed/start`,
      });
      expect(created.statusCode).toBe(201);
      const response = await post(`${sessionPath}/pages/${created.json().pageId}/autofill`, {
        fields: [
          { match: { label: 'Choice' }, option: { value: 'Chicago' }, strategy: 'react-select' },
          { match: { label: 'Later' }, value: 'must not write' },
        ],
        policy: { onVerifyFail: 'retry', settleMs: 0 },
      });
      expect(response.statusCode).toBe(200);
      const report = parseAutofillReport(response.json(), 2);
      expect(report.ok).toBe(false);
      expect(report.receipts).toMatchObject([
        {
          status: 'uncertain',
          verified: false,
          actionId: expect.any(String),
          error: { code: 'AUTOFILL_NAVIGATION_BLOCKED' },
          navigationObservation: {
            status: 'blocked',
            reason: 'egress_policy',
            scope: 'SCOPE_PATH_DENIED',
            observedDuring: 'action',
          },
        },
        { status: 'not_attempted', verified: false },
      ]);
      expect(JSON.stringify(report)).not.toContain('fixture-secret');
      expect(effects).toBe(1);
      expect(deniedHits).toBe(0);
      expect(subsequentWrites).toBe(0);
    } finally {
      await app.close();
      fixture.closeAllConnections();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  },
  30_000
);
