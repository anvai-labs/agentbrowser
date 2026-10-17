// T10 M2: scope status and the dry-run check over the SDK.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentBrowserClient } from './client';

describe('scope status and check (T10 M2)', () => {
  const fetchMock = vi.fn();
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
    fetchMock.mockReset();
  });
  const client = () => {
    global.fetch = fetchMock as unknown as typeof fetch;
    return new AgentBrowserClient({ baseUrl: 'http://localhost:5709' });
  };
  const reply = (body: unknown) =>
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });

  it('reads the scope status', async () => {
    const status = {
      allowedHosts: ['a.example'],
      pathRules: [],
      identityBindings: [],
      expired: false,
      denials: {},
    };
    reply(status);
    expect(await client().sessions.scopeStatus('ses_1')).toEqual(status);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:5709/v1/sessions/ses_1/scope');
  });

  it('encodes the url and method for a dry-run check', async () => {
    reply({ allowed: false, scope: 'SCOPE_PATH_DENIED' });
    const verdict = await client().sessions.checkScope('ses_1', {
      url: 'https://a.example/x?y=1&z=#f',
      method: 'POST',
    });
    expect(verdict).toEqual({ allowed: false, scope: 'SCOPE_PATH_DENIED' });
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/v1/sessions/ses_1/scope/check');
    expect(url.searchParams.get('url')).toBe('https://a.example/x?y=1&z=#f');
    expect(url.searchParams.get('method')).toBe('POST');
  });
});

describe('non-standard error bodies (T10 M2)', () => {
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
  });

  it('reports the HTTP status, not undefined, for a framework 431 body', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 431,
      statusText: 'Request Header Fields Too Large',
      json: async () => ({ error: 'Request Header Fields Too Large', statusCode: 431 }),
    }) as unknown as typeof fetch;
    const client = new AgentBrowserClient({ baseUrl: 'http://localhost:5709' });
    await expect(
      client.sessions.checkScope('ses_1', { url: `https://a.example/${'x'.repeat(10)}` })
    ).rejects.toMatchObject({
      code: 'UNKNOWN_ERROR',
      message: 'UNKNOWN_ERROR: HTTP 431: Request Header Fields Too Large',
    });
  });

  it('encodes the session id in the path', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    global.fetch = fetchMock as unknown as typeof fetch;
    await new AgentBrowserClient({ baseUrl: 'http://localhost:5709' }).sessions.scopeStatus(
      'a/../b'
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:5709/v1/sessions/a%2F..%2Fb/scope');
    await new AgentBrowserClient({ baseUrl: 'http://localhost:5709' }).sessions.checkScope('a/../b', {
      url: 'https://a.example/',
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toMatch(
      /^http:\/\/localhost:5709\/v1\/sessions\/a%2F\.\.%2Fb\/scope\/check\?/
    );
  });
});
