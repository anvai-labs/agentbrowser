import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { expect, it } from 'vitest';
import { buildServer } from './server.js';
import { openHarness } from './test-support/coexistence-harness.js';

const transports: Array<'stdio' | 'victor'> = process.env.AGENTBROWSER_VICTOR_ROOT
  ? ['stdio', 'victor']
  : ['stdio'];
it.each(transports)(
  'fills repeated blocks through one real %s MCP call without an explicit submit',
  async (transport) => {
    let submissions = 0;
    const fixture = createServer((req, res) => {
      if (req.url === '/submit') submissions++;
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><form action="/submit">
      <fieldset id="old"><legend>Employment</legend><label>Company name<input id="past" oninput="document.querySelector('form').prepend(document.getElementById('current'))"></label></fieldset>
      <fieldset id="current"><legend>Employment</legend><label>Company name<input id="present"></label></fieldset>
      <label>Source<select><option value="">Choose</option><option value="board">Job Board</option></select></label>
      <button>Submit</button></form>`);
    });
    await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
    const ownerHeaders = { authorization: 'Bearer owner' };
    const server = await buildServer({
      engine: new PlaywrightChromiumEngine(),
      networkPolicy: new NetworkPolicy({ blockLoopback: false, blockPrivateIPs: false }),
      apiKeys: new Map([[createHash('sha256').update('owner').digest('hex'), 'tenant']]),
    });
    let bridge: Awaited<ReturnType<typeof openHarness>> | undefined;
    try {
      await server.listen({ host: '127.0.0.1', port: 0 });
      const session = await server.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: ownerHeaders,
        payload: { controlMode: 'delegated' },
      });
      const sessionId = session.json().sessionId;
      const path = `/v1/sessions/${sessionId}`;
      const page = await server.inject({
        method: 'POST',
        url: `${path}/pages`,
        headers: { ...ownerHeaders, 'x-agentbrowser-operation-id': 'create' },
      });
      const pageId = page.json().pageId;
      const nav = await server.inject({
        method: 'POST',
        url: `${path}/pages/${pageId}/navigate`,
        headers: { ...ownerHeaders, 'x-agentbrowser-operation-id': 'nav' },
        payload: { url: `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/` },
      });
      expect(nav.statusCode).toBe(200);
      const review = await server.inject({
        method: 'POST',
        url: `${path}/control/prepare-resume`,
        headers: ownerHeaders,
      });
      const grant = await server.inject({
        method: 'POST',
        url: `${path}/control/delegate`,
        headers: ownerHeaders,
        payload: { epoch: review.json().epoch },
      });
      bridge = await openHarness({
        transport,
        baseUrl: `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`,
        sessionId,
        token: grant.json().token,
      });
      const args = {
        pageId,
        operationId: 'fill-once',
        fields: [
          { match: { label: 'Company name', block: { id: 'old' } }, value: 'Previous employer' },
          { match: { label: 'Company name', block: { id: 'current' } }, value: 'Current employer' },
          { match: { label: 'Source' }, option: { value: 'board' } },
        ],
        policy: { settleMs: 25 },
      };
      const response = (await bridge.request('tools/call', {
        name: 'browser_autofill',
        arguments: args,
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(response.isError).not.toBe(true);
      const report = JSON.parse(response.content[0]!.text);
      expect(report, JSON.stringify(report)).toMatchObject({
        ok: true,
        receipts: [
          { status: 'verified', actual: 'Previous employer' },
          { status: 'verified', actual: 'Current employer' },
          { status: 'verified', actual: 'board' },
        ],
      });
      expect(report.snapshot.artifactId).toBeTruthy();
      expect(report.snapshot.inline).toBeUndefined();
      expect(report.elapsedMs).toBeLessThan(240000);
      const duplicate = (await bridge.request('tools/call', {
        name: 'browser_autofill',
        arguments: args,
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(JSON.stringify(duplicate)).toContain('OPERATION_RECORDED');
      expect(submissions).toBe(0);
    } finally {
      await bridge?.close();
      await server.close();
      await new Promise<void>((r, reject) => fixture.close((e) => (e ? reject(e) : r())));
    }
  },
  45000
);
