import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { AgentBrowserClient } from '../../sdk-typescript/src/client.js';
import { buildServer } from './server.js';
import { type Harness, openHarness } from './test-support/coexistence-harness.js';

it('shares service sessions across stdio bridges without replaying a disconnected write', async () => {
  const engine = new FakeEngine();
  const server = await buildServer({
    engine,
    apiKeys: new Map([[createHash('sha256').update('operator').digest('hex'), 'owner']]),
  });
  const harnesses: Harness[] = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await server.listen({ port: 0, host: '127.0.0.1' });
    const baseUrl = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
    const owner = new AgentBrowserClient({ baseUrl, apiKey: 'operator' });
    const { sessionId } = await owner.sessions.create({ controlMode: 'delegated' });
    const firstPage = await owner.sessions.createPage(sessionId);
    const secondPage = await owner.sessions.createPage(sessionId);
    const review = await owner.sessions.prepareResume(sessionId);
    const { token, cursor } = await owner.sessions.delegate(sessionId, review.epoch);
    const attach = async (credential = token) => {
      const harness = await openHarness({
        transport: 'stdio',
        baseUrl,
        sessionId,
        token: credential,
      });
      harnesses.push(harness);
      return harness;
    };
    const call = (harness: Harness, name: string, args = {}) =>
      harness.request('tools/call', { name, arguments: args });
    const first = await attach();
    const second = await attach();
    const raw = engine.getFakePage(engine.getSessionIds()[0]!, firstPage.pageId)!;
    const act = raw.act.bind(raw);
    let effects = 0;
    vi.spyOn(raw, 'act').mockImplementation(async (action) => {
      const result = await act(action);
      effects++;
      entered.resolve();
      await release.promise;
      return result;
    });
    const action = {
      pageId: firstPage.pageId,
      action: 'press',
      key: 'Tab',
      operationId: 'shared-write',
    };
    const pending = call(first, 'browser_act', action);
    const disconnected = expect(pending).rejects.toThrow('closed');
    await entered.promise;
    const duplicate = await call(second, 'browser_act', action);
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content[0].text).toContain('OPERATION_RECORDED');
    expect(effects).toBe(1);
    await first.close();
    await disconnected;
    expect((await owner.sessions.control(sessionId)).busy).toBe(true);
    release.resolve();
    await vi.waitFor(async () =>
      expect((await owner.sessions.control(sessionId)).busy).toBe(false)
    );
    const replacement = await attach();
    const state = JSON.parse((await call(replacement, 'browser_session')).content[0].text);
    expect(state.control.cursor).toEqual(cursor);
    expect(state.pages.map((page: { pageId: string }) => page.pageId).sort()).toEqual(
      [firstPage.pageId, secondPage.pageId].sort()
    );
    const receipt = JSON.parse(
      (await call(second, 'browser_operation', { operationId: 'shared-write' })).content[0].text
    );
    expect(receipt).toMatchObject({ status: 'completed', dispatched: true });
    expect((await call(replacement, 'browser_act', action)).isError).toBe(true);
    expect(effects).toBe(1);
    await owner.sessions.takeover(sessionId);
    for (const harness of [second, replacement])
      expect((await call(harness, 'browser_session')).isError).toBe(true);
    await owner.sessions.closePage(sessionId, firstPage.pageId);
    expect((await owner.sessions.listPages(sessionId)).map((page) => page.pageId)).toEqual([
      secondPage.pageId,
    ]);
    const nextReview = await owner.sessions.prepareResume(sessionId);
    const fresh = await owner.sessions.delegate(sessionId, nextReview.epoch);
    expect(fresh.cursor.bindingGeneration).not.toBe(cursor.bindingGeneration);
    const resumed = await attach(fresh.token);
    const resumedState = JSON.parse((await call(resumed, 'browser_session')).content[0].text);
    expect(resumedState.control.cursor).toEqual(fresh.cursor);
    expect(resumedState.pages[0].pageId).toBe(secondPage.pageId);
    expect((await call(second, 'browser_session')).isError).toBe(true);
    expect(effects).toBe(1);
  } finally {
    release.resolve();
    await Promise.all(harnesses.map((harness) => harness.close()));
    await server.close();
  }
}, 20000);
