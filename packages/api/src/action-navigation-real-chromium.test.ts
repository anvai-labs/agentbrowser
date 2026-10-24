import { createServer } from 'node:http';
import { ActOutcomeSchema, parsePlanReport, validate } from '@agentbrowser/protocol';
import { expect, it } from 'vitest';
import { startLoopbackScopedApp } from './test-support/loopback-app.js';

it.each(['GET', 'POST'])(
  'REST actions and plans retain a completed %s interaction with a blocked redirect',
  async (method) => {
    let effects = 0;
    let deniedHits = 0;
    const fixture = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://fixture').pathname;
      if (path === '/allowed/effect') {
        effects += 1;
        request.resume();
        response.writeHead(307, { location: '/denied?fixture-secret=1' }).end();
      } else if (path === '/denied') {
        deniedHits += 1;
        response.end('denied');
      } else {
        response
          .writeHead(200, { 'content-type': 'text/html' })
          .end(
            `<html><head><link rel="icon" href="data:,"></head><body>${method === 'GET' ? '<a href="/allowed/effect">Continue</a>' : '<form method="POST" action="/allowed/effect"><button>Continue</button></form>'}</body></html>`
          );
      }
    });
    const { port, app, post, sessionPath } = await startLoopbackScopedApp(fixture);
    try {
      for (const surface of ['act', 'plan']) {
        const created = await post(`${sessionPath}/pages`, {
          url: `http://127.0.0.1:${port}/allowed/start`,
        });
        expect(created.statusCode).toBe(201);
        const pagePath = `${sessionPath}/pages/${created.json().pageId}`;
        const observed = await post(`${pagePath}/observe`, {});
        expect(observed.statusCode).toBe(200);
        const ref = observed
          .json()
          .elements.find((element: { name?: string }) => element.name === 'Continue')?.ref;
        expect(ref).toEqual(expect.any(String));
        const action = {
          action: 'click',
          target: { ref },
          observe: 'after',
          wait: { until: 'domcontentloaded', timeoutMs: 100 },
        };
        const response = await post(
          `${pagePath}/${surface}`,
          surface === 'act' ? action : { actions: [action, { action: 'press', key: 'Tab' }] }
        );
        expect(response.statusCode).toBe(200);
        const report = response.json();
        const receipt = surface === 'act' ? report : report.results[0];
        expect(receipt).toMatchObject({
          actionId: expect.any(String),
          navigationObservation: {
            status: 'blocked',
            reason: 'egress_policy',
            scope: 'SCOPE_PATH_DENIED',
            observedDuring: 'action',
          },
        });
        expect(JSON.stringify(report)).not.toContain('fixture-secret');
        expect(receipt).not.toHaveProperty('observation');
        if (surface === 'act') {
          expect(report.status).toBe('success');
          expect(validate(ActOutcomeSchema, report).success).toBe(true);
        } else {
          expect(parsePlanReport(report, 2)).toEqual(report);
          expect(report).toMatchObject({
            ok: false,
            completed: 1,
            error: { code: 'PLAN_NAVIGATION_BLOCKED' },
          });
          expect(report.results).toHaveLength(1);
          expect(receipt.ok).toBe(true);
        }
        expect(effects).toBe(surface === 'act' ? 1 : 2);
        expect(deniedHits).toBe(0);
      }
    } finally {
      await app.close();
      fixture.closeAllConnections();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  },
  30_000
);
