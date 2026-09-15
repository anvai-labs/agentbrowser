/** Delegated acceptance using extracted server code and the supplied MCP executable. */
import assert from 'node:assert/strict';
import { checkMcp } from './release-smoke.mjs';

export async function checkPackagedCoexistence({ request, surface, process, fixture, options, env, sessions, close, key }) {
  const session = await request('/v1/sessions', {
    method: 'POST', body: { tenantId: 'release-smoke', controlMode: 'delegated' },
  });
  sessions.add(session.sessionId);
  assert.equal(session.engine?.name, 'playwright-chromium');
  const page = await request(`/v1/sessions/${session.sessionId}/pages`, {
    method: 'POST', body: { url: `${fixture.http}/coexistence` }, operationId: 'packaged-create-page',
  });
  const operator = (action) => process.rpc('operator', {
    pageId: page.pageId, sessionId: session.sessionId, key, action,
  });
  const bind = (token, exercise) => {
    const agentEnv = { ...env, AGENTBROWSER_SESSION_ID: session.sessionId, AGENTBROWSER_API_KEY: token };
    // The delegated process receives its grant, never the server's owner-key map.
    delete agentEnv.AGENTBROWSER_API_KEYS;
    return surface((settings) => checkMcp(options.mcp, settings), {
      expectedVersion: options.expectedVersion, catalog: 'delegated', timeoutMs: 45_000,
      env: agentEnv, exercise,
    });
  };
  const denied = async (client, name, args, code) => {
    const result = await client.request('tools/call', { name, arguments: args });
    assert.equal(result.isError, true, `${name} unexpectedly succeeded`);
    if (code) assert.ok(result.content.some((item) => item.type === 'text' && item.text.includes(code)), `Missing ${code} refusal`);
  };
  const effects = async (expected) => {
    // Application-side HTTP receipt is independent of MCP/driver success payloads.
    const deadline = Date.now() + 5000;
    while (fixture.effects.length < expected.length && Date.now() < deadline) {
      process.signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(fixture.effects, expected, 'Packaged workflow produced unexpected application effects');
  };
  const token = await operator('grant');
  await bind(token, async (client) => {
    const observe = () => client.callTool('browser_observe', { pageId: page.pageId });
    const note = (observation) => {
      const field = observation.elements.find((element) => element.name === 'Note');
      assert.ok(field?.ref, 'Missing Note binding');
      return field;
    };
    await denied(client, 'browser_act', {
      pageId: page.pageId, action: 'fill', target: { ref: note(await observe()).ref },
      value: '', expectValue: 'different', operationId: 'packaged-mismatch',
    }, 'VALUE_MISMATCH');
    const verified = await client.callTool('browser_act', {
      pageId: page.pageId, action: 'fill', target: { ref: note(await observe()).ref },
      value: '', expectValue: '', operationId: 'packaged-verified',
    });
    assert.deepEqual(verified.result, { verified: true });
    const button = (await observe()).elements.find((element) => element.name === 'Add item');
    assert.ok(button?.ref, 'Missing button binding');
    const action = { pageId: page.pageId, action: 'click', target: { ref: button.ref }, operationId: 'packaged-one-click' };
    await client.callTool('browser_act', action);
    await effects([{ trusted: true, value: '' }]);
    await denied(client, 'browser_act', action, 'OPERATION_RECORDED');
    const [receipt, attached] = await Promise.all([
      client.callTool('browser_operation', { operationId: action.operationId }),
      client.callTool('browser_session', {}),
    ]);
    assert.equal(receipt.status, 'completed');
    assert.equal(attached.pages[0].pageId, page.pageId);
    await operator('takeover');
    await denied(client, 'browser_observe', { pageId: page.pageId });
    await denied(client, 'browser_act', { ...action, operationId: 'packaged-revoked-click' });
    await process.rpc('humanEdit', { pageId: page.pageId });
    const nextToken = await operator('grant');
    assert.notEqual(nextToken, token);
    await bind(nextToken, async (next) => {
      await denied(client, 'browser_session', {});
      await denied(next, 'browser_act', { ...action, operationId: 'packaged-stale-click' }, 'STALE_TARGET');
      const fresh = await next.callTool('browser_observe', { pageId: page.pageId });
      assert.equal(note(fresh).value, 'human edit');
      await effects([{ trusted: true, value: '' }]);
      const freshButton = fresh.elements.find((element) => element.name === 'Add item');
      assert.ok(freshButton?.ref);
      await next.callTool('browser_act', {
        ...action, target: { ref: freshButton.ref }, operationId: 'packaged-after-human',
      });
      await effects([{ trusted: true, value: '' }, { trusted: true, value: 'human edit' }]);
    });
  });
  await close(session.sessionId);
  await effects([{ trusted: true, value: '' }, { trusted: true, value: 'human edit' }]);
}
