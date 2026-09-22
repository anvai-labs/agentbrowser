import { afterEach, expect, it, vi } from 'vitest';
import { AgentBrowserClient } from './client.js';

const body = {
  pageId: 'page-1',
  source: { ownerId: 'owner-1', contract: { id: 'draft', version: 'v1' } },
  request: {
    operation: 'submit',
    input: { answer: 'PRIVATE' },
    operationId: 'future-1',
    expectedVersion: 2,
  },
};
const view = {
  tokenId: 'token-1',
  status: 'pending',
  createdAt: 1,
  expiresAt: 100,
  action: { type: 'review', private: 'PRIVATE' },
};
afterEach(() => vi.unstubAllGlobals());
it('creates a parsed pending review with no generated execution header and no automatic retry', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(view)));
  vi.stubGlobal('fetch', fetch);
  expect(await new AgentBrowserClient().sessions.applicationReview('session/a', body)).toEqual(
    view
  );
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[0]).toContain('/sessions/session%2Fa/application/reviews');
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify(body) });
  expect(fetch.mock.calls[0]?.[1].headers).not.toHaveProperty('x-agentbrowser-operation-id');
});
it('rejects malformed creation locally and rejects malformed private responses statically', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    new AgentBrowserClient().sessions.applicationReview('session', {
      ...body,
      decision: 'approve',
    } as never)
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockResolvedValue(new Response(JSON.stringify({ ...view, status: 'PRIVATE_INVALID' })));
  const error = await new AgentBrowserClient().sessions
    .applicationReview('session', body)
    .catch((error) => error);
  expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
  expect(error.message).not.toContain('PRIVATE');
});
it('forwards protected execution credentials through the existing application endpoint', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ status: 'committed', value: {} })));
  vi.stubGlobal('fetch', fetch);
  const request = { ...body.request, approvalToken: 'token-1' };
  await new AgentBrowserClient().sessions.applicationExecute('session', request);
  expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual(request);
});
