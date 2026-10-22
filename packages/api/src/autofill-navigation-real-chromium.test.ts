import { createServer } from 'node:http';
import { parseAutofillReport } from '@agentbrowser/protocol';
import { expect, it } from 'vitest';
import { startLoopbackScopedApp } from './test-support/loopback-app.js';

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
    const { port, app, post, sessionPath } = await startLoopbackScopedApp(fixture);
    try {
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
