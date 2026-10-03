import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultNetworkPolicy,
  networkPolicyFromEnvironment,
} from './network-policy-config.js';

describe('operator network policy configuration', () => {
  it.each([undefined, '', '   '])('keeps the 10 MiB response default for %j', async (raw) => {
    const policy = networkPolicyFromEnvironment({ AGENTBROWSER_MAX_RESPONSE_BYTES: raw });
    await expect(policy.checkBodySize(10 * 1024 * 1024)).resolves.toBeUndefined();
    await expect(policy.checkBodySize(10 * 1024 * 1024 + 1)).rejects.toThrow();
  });

  it.each([1, 32 * 1024 * 1024, 64 * 1024 * 1024])(
    'enforces the configured %i byte boundary and preserves SSRF controls',
    async (bytes) => {
      const policy = networkPolicyFromEnvironment({
        AGENTBROWSER_MAX_RESPONSE_BYTES: ` ${bytes} `,
      });
      await expect(policy.checkBodySize(bytes)).resolves.toBeUndefined();
      await expect(policy.checkBodySize(bytes + 1)).rejects.toThrow();
      await expect(
        policy.checkResponse({ headers: { 'content-length': String(bytes + 1) } })
      ).rejects.toThrow();
      for (const hostname of ['127.0.0.1', '192.168.1.89', '169.254.169.254']) {
        await expect(policy.checkRequest({ hostname })).rejects.toThrow();
      }
    }
  );

  it.each([
    '0',
    '-1',
    '1.5',
    '1e7',
    'Infinity',
    'NaN',
    '32MiB',
    '33554432oops',
    '67108865',
    '9007199254740992',
  ])('rejects invalid response cap %j', (raw) => {
    expect(() => networkPolicyFromEnvironment({ AGENTBROWSER_MAX_RESPONSE_BYTES: raw })).toThrow(
      /AGENTBROWSER_MAX_RESPONSE_BYTES/
    );
  });

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

describe('operator loopback opt-in (local-machine sessions)', () => {
  it('an explicit opt-in builds a policy whose loopback check allows 127.0.0.1', async () => {
    const { networkPolicyFromEnvironment } = await import('./network-policy-config.js');
    const policy = networkPolicyFromEnvironment({
      AGENTBROWSER_ALLOWED_CIDRS: '',
      AGENTBROWSER_ALLOW_LOOPBACK: '1',
    });
    // The base no longer denies the loopback host outright.
    await expect(
      policy.checkRequest({ hostname: '127.0.0.1', url: 'http://127.0.0.1:3000/x' })
    ).resolves.toBeUndefined();
  });

  it('the default (no opt-in) still blocks loopback', async () => {
    const { networkPolicyFromEnvironment } = await import('./network-policy-config.js');
    const policy = networkPolicyFromEnvironment({ AGENTBROWSER_ALLOWED_CIDRS: '' });
    await expect(
      policy.checkRequest({ hostname: '127.0.0.1', url: 'http://127.0.0.1:3000/x' })
    ).rejects.toThrow(/loopback/i);
  });

  it('metadata stays blocked even with the loopback opt-in', async () => {
    const { networkPolicyFromEnvironment } = await import('./network-policy-config.js');
    const policy = networkPolicyFromEnvironment({
      AGENTBROWSER_ALLOWED_CIDRS: '',
      AGENTBROWSER_ALLOW_LOOPBACK: '1',
    });
    await expect(
      policy.checkRequest({ hostname: '169.254.169.254', url: 'http://169.254.169.254/latest' })
    ).rejects.toThrow();
  });
});
