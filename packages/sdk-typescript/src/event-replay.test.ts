import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentBrowserClient } from './client.js';

describe('retained event selectors', () => {
  const fetch = vi.fn();
  const page = {
    events: [{ type: 'request.failed', seq: 12 }],
    nextCursor: 14,
    oldestSeq: 10,
    gap: true,
  };
  beforeEach(() => {
    fetch.mockReset();
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ...page, filter: { version: 1, stream: 'request' } }),
    });
    vi.stubGlobal('fetch', fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('encodes the complete selector and preserves per-ledger gap facts', async () => {
    const client = new AgentBrowserClient({ baseUrl: 'http://fixture.invalid' });
    const result = await client.sessions.events('ses_1', {
      type: 'request.failed',
      since: -1,
      limit: 3,
      stream: 'request',
      urlRegex: 'api/(items|offers)\\?q=a&b=λ',
      method: 'PUT',
      statusClass: 'denied',
      failedOnly: true,
    });
    const url = new URL(fetch.mock.calls[0]?.[0]);
    expect(url.pathname).toBe('/v1/sessions/ses_1/events/replay');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      type: 'request.failed',
      since: '-1',
      limit: '3',
      stream: 'request',
      urlRegex: 'api/(items|offers)\\?q=a&b=λ',
      method: 'PUT',
      statusClass: 'denied',
      failedOnly: 'true',
    });
    expect(result).toEqual({ ...page, filter: { version: 1, stream: 'request' } });
  });

  it('serializes an explicit false selector and does not inject an inferred stream', async () => {
    const client = new AgentBrowserClient({ baseUrl: 'http://fixture.invalid' });
    await client.sessions.events('ses_1', { failedOnly: false });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'http://fixture.invalid/v1/sessions/ses_1/events/replay?failedOnly=false'
    );
  });

  it.each([
    undefined,
    null,
    { version: 1, stream: 'other' },
    { version: 2, stream: 'request' },
    { version: '1', stream: 'request' },
    { version: 1, stream: 'request', extra: 'PRIVATE_RECEIPT_VALUE' },
    { version: 1 },
    { stream: 'request' },
    [{ version: 1, stream: 'request' }],
  ])('rejects a missing or invalid filter receipt without fallback: %j', async (filter) => {
    const client = new AgentBrowserClient({ baseUrl: 'http://fixture.invalid' });
    fetch.mockResolvedValue({ ok: true, json: async () => ({ ...page, filter }) });
    await expect(client.sessions.events('ses_1', { failedOnly: false })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: 'INVALID_RESPONSE: Invalid event replay filter acknowledgment',
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('requires and preserves acknowledgment for an explicit other stream', async () => {
    const client = new AgentBrowserClient({ baseUrl: 'http://fixture.invalid' });
    const filter = { version: 1, stream: 'other' };
    fetch.mockResolvedValue({ ok: true, json: async () => ({ ...page, filter }) });
    expect(await client.sessions.events('ses_1', { stream: 'other' })).toEqual({ ...page, filter });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { stream: 'other', method: 'GET' },
    { stream: 'other', type: 'request.finished' },
    { type: 'console.log', failedOnly: true },
    { method: 'get' },
    { statusClass: '3xx' },
    { failedOnly: 'false' },
    { urlRegex: 'λ'.repeat(129) },
    { type: '' },
    { since: 3 },
    { type: 'console.log', limit: 0 },
    { type: 'request.failed', unexpected: 'PRIVATE_SELECTOR_VALUE' },
  ])('refuses an invalid selector before issuing HTTP: %j', async (selector) => {
    const client = new AgentBrowserClient({ baseUrl: 'http://fixture.invalid' });
    await expect(client.sessions.events('ses_1', selector as never)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves legacy empty-string/undefined arrays and empty-object envelopes', async () => {
    const client = new AgentBrowserClient({ baseUrl: 'http://fixture.invalid' });
    fetch.mockResolvedValue({ ok: true, json: async () => page });
    expect(await client.sessions.events('ses_1', '')).toEqual(page.events);
    expect(await client.sessions.events('ses_1', undefined)).toEqual(page.events);
    expect(await client.sessions.events('ses_1', {})).toEqual(page);
    for (const [url] of fetch.mock.calls)
      expect(url).toBe('http://fixture.invalid/v1/sessions/ses_1/events/replay');
  });
});
