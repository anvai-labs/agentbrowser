import { afterEach, expect, it, vi } from 'vitest';
import { AgentBrowserClient } from './client.js';
afterEach(() => vi.unstubAllGlobals());
it('sends unique operation IDs and supports explicit reconciliation', async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  const client = new AgentBrowserClient();
  await client.sessions.createPage('s');
  await client.sessions.createPage('s');
  const ids = fetch.mock.calls.map((call) => call[1].headers['x-agentbrowser-operation-id']);
  expect(ids[0]).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
  expect(ids[0]).not.toBe(ids[1]);
  await client.sessions.createPage('s', undefined, { operationId: 'reconcile-1' });
  expect(fetch.mock.lastCall?.[1].headers['x-agentbrowser-operation-id']).toBe('reconcile-1');
});
it('exposes operator handoff and read-only agent reconciliation methods', async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  const client = new AgentBrowserClient();
  await client.sessions.control('s');
  await client.sessions.takeover('s');
  await client.sessions.prepareResume('s');
  await client.sessions.delegate('s', 3);
  await client.sessions.operation('s', 'id');
  expect(fetch.mock.calls.map((call) => new URL(call[0]).pathname)).toEqual([
    '/v1/sessions/s/control',
    '/v1/sessions/s/control/takeover',
    '/v1/sessions/s/control/prepare-resume',
    '/v1/sessions/s/control/delegate',
    '/v1/sessions/s/operations/id',
  ]);
});
it('preserves operation ID on lost response without retrying', async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError('connection lost'));
  vi.stubGlobal('fetch', fetch);
  const client = new AgentBrowserClient();
  await expect(
    client.sessions.createPage('s', undefined, { operationId: 'lost-1' })
  ).rejects.toMatchObject({ details: { operationId: 'lost-1' } });
  expect(fetch).toHaveBeenCalledTimes(1);
});
