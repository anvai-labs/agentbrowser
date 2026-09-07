import { describe, expect, it } from 'vitest';
import { NetworkPolicy, SessionHostPolicy } from './network-policy.js';

describe('complete policy composition', () => {
  it('delegates actual-byte and resolved-address checks through a host restriction', async () => {
    const policy = new SessionHostPolicy(
      new NetworkPolicy({ blockLoopback: true, maxResponseSize: 1024 }),
      { allowedHosts: ['example.com'] }
    );
    await policy.checkRequest({ hostname: 'example.com' });
    await expect(policy.checkResolvedAddresses(['127.0.0.1'])).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    await expect(policy.checkBodySize(1025)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(policy.checkBodySize(1024)).resolves.toBeUndefined();
  });
});
