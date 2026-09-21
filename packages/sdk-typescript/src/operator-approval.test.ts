import { afterEach, expect, it, vi } from 'vitest';
import { AgentBrowserClient } from './client.js';
const view = {
  tokenId: 'tok_1',
  status: 'pending',
  createdAt: 1,
  expiresAt: 100,
  action: { type: 'click', value: 'PRIVATE-ACTION' },
};
afterEach(() => vi.unstubAllGlobals());
it('reads the scoped approval and encodes path identifiers', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ ...view, tokenId: 'tok/a?' })));
  vi.stubGlobal('fetch', fetch);
  const client = new AgentBrowserClient();
  expect(await client.sessions.approval('ses/a', 'tok/a?')).toMatchObject({
    tokenId: 'tok/a?',
    status: 'pending',
  });
  expect(fetch.mock.calls[0]?.[0]).toContain('/sessions/ses%2Fa/approvals/tok%2Fa%3F');
  expect(fetch.mock.calls[0]?.[1].method).toBe('GET');
});
it('sends one decision using the existing mutation identity', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ ...view, status: 'approved', approvedAt: 2 }))
    );
  vi.stubGlobal('fetch', fetch);
  const client = new AgentBrowserClient();
  await client.sessions.decideApproval('ses_1', 'tok_1', 'approve', { operationId: 'review-once' });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({
    method: 'POST',
    body: '{"decision":"approve"}',
    headers: { 'x-agentbrowser-operation-id': 'review-once' },
  });
});
it('rejects invalid direct decisions before network access', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    new AgentBrowserClient().sessions.decideApproval(
      'ses_1',
      'tok_1',
      'PRIVATE-INVALID' as 'approve'
    )
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  { ...view, tokenId: 'another' },
  { ...view, status: 'maybe' },
  { ...view, action: { value: 'PRIVATE'.repeat(20000) } },
])('rejects malformed or mismatched views without echoing action data', async (body) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
  const error = await new AgentBrowserClient().sessions.approval('ses_1', 'tok_1').catch((e) => e);
  expect(error).toMatchObject({ code: 'INVALID_RESPONSE', retryable: false });
  expect(error.message).not.toContain('PRIVATE');
});
