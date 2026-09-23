import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultNetworkPolicy,
  networkPolicyFromEnvironment,
} from './network-policy-config.js';

describe('operator network policy configuration', () => {
  it.each([undefined, '', '   '])('defaults to private-network denial for %j', async (raw) => {
    const warn = vi.fn();
    const policy = networkPolicyFromEnvironment({ AGENTBROWSER_ALLOWED_CIDRS: raw }, warn);
    await expect(policy.checkRequest({ hostname: '192.168.1.89' })).rejects.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('parses comma-separated CIDRs and keeps the service default independent of environment', async () => {
    const p = networkPolicyFromEnvironment({
      AGENTBROWSER_ALLOWED_CIDRS: ' 192.168.1.89/32 , fd12::/64 ',
    });
    await expect(p.checkRequest({ hostname: '192.168.1.89' })).resolves.toBeUndefined();
    await expect(p.checkResolvedAddresses(['fd12::1'])).resolves.toBeUndefined();
    for (const hostname of ['192.168.1.65', '127.0.0.1', '169.254.169.254']) {
      await expect(p.checkRequest({ hostname })).rejects.toThrow();
    }
    await expect(
      createDefaultNetworkPolicy().checkRequest({ hostname: '192.168.1.89' })
    ).rejects.toThrow();
  });

  it.each(['oops', '192.168.1.89/32,typo', '192.168.1.89/32,', ',192.168.1.89/32', ',', '::/129'])(
    'rejects the whole nonempty config %j instead of ignoring malformed entries',
    (raw) => {
      expect(() => networkPolicyFromEnvironment({ AGENTBROWSER_ALLOWED_CIDRS: raw })).toThrow(
        /CIDR/
      );
    }
  );

  it.each(['0.0.0.0/0', '::/0', '192.168.1.89/0'])(
    'warns for a valid universal allowance %s',
    (raw) => {
      const warn = vi.fn();
      networkPolicyFromEnvironment({ AGENTBROWSER_ALLOWED_CIDRS: raw }, warn);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toMatch(/AGENTBROWSER_ALLOWED_CIDRS.*\/0/);
    }
  );
});
