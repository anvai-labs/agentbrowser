import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setImmediate as settlePublication } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { runAgentCli } from '../../../scripts/cli-outcome-acceptance.mjs';
import { buildServer } from './server.js';
const operator = { authorization: 'Bearer owner' };
const writeHeaders = (id: string) => ({ ...operator, 'x-agentbrowser-operation-id': id });
async function fixture(
  test: (scope: {
    server: Awaited<ReturnType<typeof buildServer>>;
    path: string;
    tokenId: string;
    sessionId: string;
    pageId: string;
    ref: string;
    dispatch: ReturnType<typeof vi.spyOn>;
  }) => Promise<void>
) {
  const engine = new FakeEngine();
  const server = await buildServer({
    engine,
    apiKeys: new Map(
      ['owner', 'other'].map((key) => [createHash('sha256').update(key).digest('hex'), key])
    ),
  });
  try {
    const created = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: operator,
      payload: { controlMode: 'delegated', policy: { approval: { review: 'operator' } } },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().sessionId as string;
    const path = `/v1/sessions/${sessionId}`;
    const pageResponse = await server.inject({
      method: 'POST',
      url: `${path}/pages`,
      headers: writeHeaders('create-page'),
      payload: {},
    });
    expect(pageResponse.statusCode).toBe(201);
    const pageId = pageResponse.json().pageId as string;
    const engineSession = engine.getSessionIds()[0];
    if (!engineSession) throw new Error('Missing fake session');
    const page = engine.getFakePage(engineSession, pageId);
    if (!page) throw new Error('Missing fake page');
    const dispatch = vi.spyOn(page, 'act');
    await page.navigate({ url: 'https://example.com/review' });
    page.setElements([{ role: 'button', name: 'Save synthetic setting', risk: 'transaction' }]);
    const observed = await server.inject({
      method: 'POST',
      url: `${path}/pages/${pageId}/observe`,
      headers: operator,
      payload: {},
    });
    const ref = observed.json().elements[0].ref as string;
    const denied = await server.inject({
      method: 'POST',
      url: `${path}/pages/${pageId}/act`,
      headers: writeHeaders('challenge'),
      payload: { action: 'click', target: { ref } },
    });
    expect(denied.json().error.code).toBe('APPROVAL_REQUIRED');
    const tokenId = denied.json().error.details.tokenId as string;
    await settlePublication();
    await test({ server, path, tokenId, sessionId, pageId, ref, dispatch });
  } finally {
    await server.close();
  }
}
it('lets the owning operator read and decide through ordinary controlled admission', async () => {
  await fixture(async ({ server, path, tokenId }) => {
    const url = `${path}/approvals/${tokenId}`;
    const read = await server.inject({ method: 'GET', url, headers: operator });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ tokenId, status: 'pending', action: { type: 'click' } });
    expect(read.headers['cache-control']).toBe('no-store');
    const missingId = await server.inject({
      method: 'POST',
      url,
      headers: operator,
      payload: { decision: 'approve' },
    });
    expect(missingId.statusCode).toBe(400);
    const approved = await server.inject({
      method: 'POST',
      url,
      headers: writeHeaders('approve-once'),
      payload: { decision: 'approve' },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      tokenId,
      status: 'approved',
      approvedAt: expect.any(Number),
    });
    const replay = await server.inject({
      method: 'POST',
      url,
      headers: writeHeaders('approve-once'),
      payload: { decision: 'approve' },
    });
    expect(replay.json()).toMatchObject({ replay: true });
  });
});
it.each([{ decision: 'yes' }, { decision: 'approve', extra: true }, [], null])(
  'rejects malformed decision bodies without changing the approval',
  async (payload) => {
    await fixture(async ({ server, path, tokenId }) => {
      const url = `${path}/approvals/${tokenId}`;
      const response = await server.inject({
        method: 'POST',
        url,
        headers: writeHeaders('invalid'),
        payload: payload as object,
      });
      expect(response.statusCode).toBe(400);
      await settlePublication();
      const current = await server.inject({ method: 'GET', url, headers: operator });
      expect(current.json().status).toBe('pending');
    });
  }
);
it('refuses another tenant and delegated grants for both approval routes', async () => {
  await fixture(async ({ server, path, tokenId }) => {
    const url = `${path}/approvals/${tokenId}`;
    const other = await server.inject({
      method: 'GET',
      url,
      headers: { authorization: 'Bearer other' },
    });
    expect(other.statusCode).toBe(403);
    const review = await server.inject({
      method: 'POST',
      url: `${path}/control/prepare-resume`,
      headers: operator,
    });
    const grant = await server.inject({
      method: 'POST',
      url: `${path}/control/delegate`,
      headers: operator,
      payload: { epoch: review.json().epoch, mode: 'forms' },
    });
    expect(grant.statusCode).toBe(200);
    const headers = {
      authorization: `Bearer ${grant.json().token}`,
      'x-agentbrowser-operation-id': 'agent-decision',
    };
    expect((await server.inject({ method: 'GET', url, headers })).statusCode).toBe(403);
    expect(
      (await server.inject({ method: 'POST', url, headers, payload: { decision: 'approve' } }))
        .statusCode
    ).toBe(403);
  });
});
it('does not treat unauthenticated local-mode requests as operators', async () => {
  const server = await buildServer({ engine: new FakeEngine(), apiKeys: new Map() });
  try {
    const created = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { tenantId: 'local' },
    });
    const url = `/v1/sessions/${created.json().sessionId}/approvals/tok_unknown`;
    expect((await server.inject({ method: 'GET', url })).statusCode).toBe(403);
    expect(
      (await server.inject({ method: 'POST', url, payload: { decision: 'approve' } })).statusCode
    ).toBe(403);
  } finally {
    await server.close();
  }
});

it('drives the reviewed action lifecycle through the compiled CLI exactly once', async () => {
  await fixture(async ({ server, sessionId, pageId, ref, dispatch }) => {
    await server.listen({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
    const cli = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url));
    let operation = 0;
    const invoke = (args: string[], expectedExitCode = 0) =>
      runAgentCli(
        [
          process.execPath,
          cli,
          '--base-url',
          baseUrl,
          '--json',
          '--operation-id',
          `cli-review-${++operation}`,
          ...args,
        ],
        { env: process.env, token: 'owner', expectedExitCode }
      );
    const challenge = await invoke(['act', 'click', sessionId, pageId, ref], 1);
    const tokenId = /Approval token: ([A-Za-z0-9_-]+)/.exec(challenge.stderr)?.[1];
    expect(tokenId).toBeTypeOf('string');
    if (!tokenId) throw new Error('Missing CLI challenge token');
    expect(dispatch).not.toHaveBeenCalled();
    const pending = await invoke(['session', 'approval', sessionId, tokenId]);
    expect(JSON.parse(pending.stdout)).toMatchObject({
      tokenId,
      status: 'pending',
      action: { type: 'click' },
    });
    const attempt = () => ['act', '--approval-token', tokenId, 'click', sessionId, pageId, ref];
    await invoke(attempt(), 1);
    expect(dispatch).not.toHaveBeenCalled();
    const decision = await invoke([
      'session',
      'approval-decide',
      sessionId,
      tokenId,
      '--decision',
      'approve',
    ]);
    expect(JSON.parse(decision.stdout).status).toBe('approved');
    const result = await invoke(attempt());
    expect(JSON.parse(result.stdout).status).toBe('success');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).not.toHaveProperty('approvalToken');
    const used = await invoke(['session', 'approval', sessionId, tokenId]);
    expect(JSON.parse(used.stdout).status).toBe('used');
    await invoke(attempt(), 1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
}, 20000);
