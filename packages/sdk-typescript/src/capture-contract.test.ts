import { DELIVERED_WAIT_TYPES, type DeliveredWaitCondition } from '@agentbrowser/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentBrowserClient } from './client.js';

afterEach(() => vi.unstubAllGlobals());
describe.each(['observe', 'screenshot'] as const)('SDK %s capture contract', (operation) => {
  it.each(DELIVERED_WAIT_TYPES)('serializes %s without dropping fields', async (until) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const wait = {
      until,
      timeoutMs: 250,
      ...(until === 'minElements' ? { count: 2 } : {}),
      ...(until === 'urlPattern' ? { pattern: '**/ready' } : {}),
      ...(until === 'selectorVisible' ? { selector: '#ready' } : {}),
    } as DeliveredWaitCondition;
    await new AgentBrowserClient().sessions[operation]('ses_1', 'pg_1', { wait });
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ wait });
  });
  it.each([
    null,
    { until: 'bogus' },
    { until: 'minElements' },
    { until: 'load', timeoutMs: Number.NaN },
    { until: 'load', timeoutMs: Number.POSITIVE_INFINITY },
  ])('rejects malformed wait %j before serialization', async (wait) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      new AgentBrowserClient().sessions[operation]('ses_1', 'pg_1', { wait } as never)
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
