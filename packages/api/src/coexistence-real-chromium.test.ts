import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { expect, it, vi } from 'vitest';
import { buildMcpServer } from '../../mcp-server/src/mcp-server.js';
import { AgentBrowserClient } from '../../sdk-typescript/src/client.js';
import { buildServer } from './server.js';

it('shares a real page through the operator panel and bound MCP, with independent effect evidence', async () => {
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
    const mcp = buildMcpServer({ createClient: () => client, sessionId: session.sessionId });
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = JSON.parse(
        (await mcp.handle(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'agent',
            method: 'tools/call',
            params: { name, arguments: args },
          })
        ))!
      );
      expect(response.id).toBe('agent');
      return response.result;
    };
    const first = await call('browser_observe', { pageId: page.pageId });
    const observation = JSON.parse(first.content[0].text);
    const button = observation.elements.find((e: { name?: string }) => e.name === 'Add item');
    expect(button).toBeDefined();
    const action = { action: 'click' as const, target: { ref: button.ref } };
    expect(
      (await call('browser_act', { pageId: page.pageId, ...action, operationId: 'one-click' }))
        .isError
    ).toBeUndefined();
    await vi.waitFor(() => expect(effects).toEqual([{ trusted: true, value: '' }]));
    await expect(
      client.sessions.executeAction(session.sessionId, page.pageId, action, {
        operationId: 'one-click',
      })
    ).rejects.toMatchObject({ code: 'OPERATION_RECORDED' });
    expect(effects).toHaveLength(1);
    await ui.getByRole('button', { name: 'Take over', exact: true }).click();
    await vi.waitFor(async () =>
      expect(await ui.locator('#status').textContent()).toContain('HUMAN_ACTIVE')
    );
    expect((await call('browser_observe', { pageId: page.pageId })).isError).toBe(true);
    const humanObservation = await owner.sessions.observe(session.sessionId, page.pageId);
    const input = humanObservation.elements.find((e) => e.name === 'Note')!;
    await owner.sessions.executeAction(session.sessionId, page.pageId, {
      action: 'fill',
      target: { ref: input.ref },
      value: 'human edit',
    });
    await ui.getByRole('button', { name: 'Prepare fresh review' }).click();
    await vi.waitFor(async () =>
      expect(await ui.getByRole('button', { name: 'Delegate reviewed state' }).isEnabled()).toBe(
        true
      )
    );
    await ui.getByRole('button', { name: 'Delegate reviewed state' }).click();
    await vi.waitFor(async () => expect(await ui.locator('#grant').inputValue()).not.toBe(''));
    const next = new AgentBrowserClient({
      baseUrl,
      apiKey: await ui.locator('#grant').inputValue(),
    });
    await expect(
      next.sessions.executeAction(session.sessionId, page.pageId, action)
    ).rejects.toMatchObject({ code: 'STALE_TARGET' });
    const fresh = await next.sessions.observe(session.sessionId, page.pageId);
    expect(fresh.elements.find((e) => e.name === 'Note')?.value).toBe('human edit');
    expect(effects).toHaveLength(1);
  } finally {
    await uiEngine.close();
    await server.close();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
}, 30_000);
