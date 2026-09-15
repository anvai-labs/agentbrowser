import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { expect, it, vi } from 'vitest';
import { AgentBrowserClient } from '../../sdk-typescript/src/client.js';
import { buildServer } from './server.js';
import { type Harness, openHarness } from './test-support/coexistence-harness.js';

for (const transport of ['in-process', 'stdio', 'victor'] as const) {
  it.skipIf(transport === 'victor' && !process.env.AGENTBROWSER_VICTOR_ROOT)(
    `shares the operator panel and real Chromium through ${transport} MCP with independent effects`,
    async () => {
      const harnesses: Harness[] = [];
      const effects: Array<{ trusted: boolean; value: string }> = [];
      const fixture = createServer((req, res) => {
        if (req.url === '/increment') {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            effects.push(JSON.parse(body));
            res.end('ok');
          });
          return;
        }
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<!doctype html><title>Coexistence fixture</title><label>Note <input id="note"></label><button id="add">Add item</button><script>add.onclick = e => fetch("/increment",{method:"POST",body:JSON.stringify({trusted:e.isTrusted,value:note.value})});</script>'
        );
      });
      await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
      const engine = new PlaywrightChromiumEngine();
      const humanPages: import('playwright').Page[] = [];
      const createSession = engine.createSession.bind(engine);
      vi.spyOn(engine, 'createSession').mockImplementation(async (options) => {
        const session = await createSession(options);
        const newPage = session.newPage.bind(session);
        vi.spyOn(session, 'newPage').mockImplementation(async (pageOptions) => {
          const native = await newPage(pageOptions);
          humanPages.push((native as unknown as { page: import('playwright').Page }).page);
          return native;
        });
        return session;
      });
      const uiEngine = new PlaywrightChromiumEngine();
      const server = await buildServer({
        engine,
        networkPolicy: new NetworkPolicy({ blockLoopback: false, blockPrivateIPs: false }),
        apiKeys: new Map([[createHash('sha256').update('owner-key').digest('hex'), 'owner']]),
      });
      try {
        await server.listen({ port: 0, host: '127.0.0.1' });
        const baseUrl = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
        const owner = new AgentBrowserClient({ baseUrl, apiKey: 'owner-key' });
        const session = await owner.sessions.create({ controlMode: 'delegated' });
        const page = await owner.sessions.createPage(session.sessionId, {
          url: `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`,
        });
        const nativePage = await (await uiEngine.createSession({})).newPage();
        // Driver access is confined to this test; the production panel uses REST.
        const ui = (nativePage as unknown as { page: import('playwright').Page }).page;
        await ui.goto(`${baseUrl}/operator`);
        await ui.getByLabel('Operator key', { exact: true }).fill('owner-key');
        await ui.getByRole('button', { name: 'Connect', exact: true }).click();
        await ui.getByLabel('Session ID', { exact: true }).fill(session.sessionId);
        await ui.getByRole('button', { name: 'Attach', exact: true }).click();
        await vi.waitFor(async () =>
          expect(await ui.locator('#status').textContent()).toContain('HUMAN_ACTIVE')
        );
        await ui.getByRole('button', { name: 'Prepare fresh review' }).click();
        await vi.waitFor(async () =>
          expect(await ui.locator('#pages').textContent()).toContain(page.pageId)
        );
        await ui.getByRole('button', { name: 'Delegate reviewed state' }).click();
        await vi.waitFor(async () => expect(await ui.locator('#grant').inputValue()).not.toBe(''));
        const token = await ui.locator('#grant').inputValue();
        const client = new AgentBrowserClient({ baseUrl, apiKey: token });
        const bind = async (grant: string) => {
          const harness = await openHarness({
            transport,
            baseUrl,
            sessionId: session.sessionId,
            token: grant,
          });
          harnesses.push(harness);
          const catalog = await harness.request('tools/list');
          const names = catalog.tools.map((tool: { name: string }) => tool.name);
          expect(names).toContain('browser_session');
          expect(names).toContain('browser_operation');
          for (const forbidden of ['browser_create', 'browser_close', 'browser_cookies'])
            expect(names).not.toContain(forbidden);
          return (name: string, args: Record<string, unknown> = {}) =>
            harness.request('tools/call', { name, arguments: args });
        };
        const call = await bind(token);
        const initial = JSON.parse(
          (await call('browser_observe', { pageId: page.pageId })).content[0].text
        );
        let note = initial.elements.find((element: { name?: string }) => element.name === 'Note');
        const mismatch = await call('browser_act', {
          pageId: page.pageId,
          action: 'fill',
          target: { ref: note.ref },
          value: '',
          expectValue: 'different',
          operationId: 'mismatched-fill',
        });
        expect(mismatch.isError).toBe(true);
        expect(mismatch.content[0].text).toContain('VALUE_MISMATCH');
        const afterMismatch = JSON.parse(
          (await call('browser_observe', { pageId: page.pageId })).content[0].text
        );
        note = afterMismatch.elements.find((element: { name?: string }) => element.name === 'Note');
        const verified = await call('browser_act', {
          pageId: page.pageId,
          action: 'fill',
          target: { ref: note.ref },
          value: '',
          expectValue: '',
          operationId: 'verified-fill',
        });
        expect(verified.isError).not.toBe(true);
        expect(JSON.parse(verified.content[0].text).result).toEqual({ verified: true });
        const observation = JSON.parse(
          (await call('browser_observe', { pageId: page.pageId })).content[0].text
        );
        const button = observation.elements.find((e: { name?: string }) => e.name === 'Add item');
        expect(button).toBeDefined();
        const action = { action: 'click' as const, target: { ref: button.ref } };
        expect(
          (await call('browser_act', { pageId: page.pageId, ...action, operationId: 'one-click' }))
            .isError
        ).not.toBe(true);
        await vi.waitFor(() => expect(effects).toEqual([{ trusted: true, value: '' }]));
        await expect(
          client.sessions.executeAction(session.sessionId, page.pageId, action, {
            operationId: 'one-click',
          })
        ).rejects.toMatchObject({ code: 'OPERATION_RECORDED' });
        const duplicate = await call('browser_act', {
          pageId: page.pageId,
          ...action,
          operationId: 'one-click',
        });
        expect(duplicate.isError).toBe(true);
        expect(duplicate.content[0].text).toContain('OPERATION_RECORDED');
        const [receipt, attached] = await Promise.all([
          call('browser_operation', { operationId: 'one-click' }),
          call('browser_session'),
        ]);
        expect(JSON.parse(receipt.content[0].text).status).toBe('completed');
        expect(JSON.parse(attached.content[0].text).pages[0].pageId).toBe(page.pageId);
        expect(effects).toHaveLength(1);
        await ui.getByRole('button', { name: 'Take over', exact: true }).click();
        await vi.waitFor(async () =>
          expect(await ui.locator('#status').textContent()).toContain('HUMAN_ACTIVE')
        );
        expect((await call('browser_observe', { pageId: page.pageId })).isError).toBe(true);
        // Simulate human input through the actual browser after takeover settles.
        // This test-only driver access never enters the production operator panel.
        expect(humanPages).toHaveLength(1);
        await humanPages[0].getByLabel('Note', { exact: true }).fill('human edit');
        await ui.getByRole('button', { name: 'Prepare fresh review' }).click();
        await vi.waitFor(async () =>
          expect(
            await ui.getByRole('button', { name: 'Delegate reviewed state' }).isEnabled()
          ).toBe(true)
        );
        await ui.getByRole('button', { name: 'Delegate reviewed state' }).click();
        await vi.waitFor(async () => expect(await ui.locator('#grant').inputValue()).not.toBe(''));
        const nextToken = await ui.locator('#grant').inputValue();
        expect(nextToken).not.toBe(token);
        const nextCall = await bind(nextToken);
        expect((await call('browser_session')).isError).toBe(true);
        const stale = await nextCall('browser_act', {
          pageId: page.pageId,
          ...action,
          operationId: 'stale-click',
        });
        expect(stale.isError).toBe(true);
        expect(stale.content[0].text).toContain('STALE_TARGET');
        const fresh = JSON.parse(
          (await nextCall('browser_observe', { pageId: page.pageId })).content[0].text
        );
        expect(fresh.elements.find((e) => e.name === 'Note')?.value).toBe('human edit');
        expect(effects).toHaveLength(1);
        const freshButton = fresh.elements.find((e: { name?: string }) => e.name === 'Add item');
        expect(
          (
            await nextCall('browser_act', {
              pageId: page.pageId,
              action: 'click',
              target: { ref: freshButton.ref },
              operationId: 'after-human',
            })
          ).isError
        ).not.toBe(true);
        await vi.waitFor(() =>
          expect(effects).toEqual([
            { trusted: true, value: '' },
            { trusted: true, value: 'human edit' },
          ])
        );
      } finally {
        await Promise.all(harnesses.map((harness) => harness.close()));
        await uiEngine.close();
        await server.close();
        await new Promise<void>((resolve) => fixture.close(() => resolve()));
      }
    },
    30_000
  );
}
