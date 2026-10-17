// T10 M2: engagement ledger export over the SDK (NDJSON text, verbatim).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentBrowserClient } from './client';

describe('engagements.export (T10 M2)', () => {
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
  });

  it('returns the NDJSON body as text and encodes the id', async () => {
    const body = '{"seq":0}\n{"seq":1}\n';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => body });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new AgentBrowserClient({ baseUrl: 'http://localhost:5709' });
    expect(await client.engagements.export('eng_0123456789abcdef01234567')).toBe(body);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://localhost:5709/v1/engagements/eng_0123456789abcdef01234567'
    );
  });
});
