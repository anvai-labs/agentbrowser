import { describe, expect, it } from 'vitest';
import { NetworkPolicy, SessionHostPolicy } from './network-policy.js';

describe('canonical address policy (R14)', () => {
  it.each([
    '127.000.0.1',
    '010.000.0.1',
    '192.168.001.1',
    '0.000.0.0',
    '127.0.0.999',
    '[127.0.0.1]',
    '[::1',
    '::1]',
    '1::2::3',
    'fe80::1%en0',
  ])('does not reinterpret malformed IP hostname %s as an allowed name', async (hostname) => {
    for (const options of [{}, { blockLoopback: true, blockPrivateIPs: true }]) {
      await expect(new NetworkPolicy(options).checkRequest({ hostname })).rejects.toMatchObject({
        code: 'POLICY_DENIED',
        details: { rule: 'requestAddressInvalid' },
      });
    }
  });

  const cases = [
    {
      flag: 'blockLoopback',
      addresses: [
        '127.0.0.1',
        '::ffff:127.0.0.1',
        '::FFFF:7F00:1',
        '0:0:0:0:0:ffff:7f00:1',
        '::1',
        '0:0:0:0:0:0:0:1',
        '::',
        '0:0:0:0:0:0:0:0',
        '::ffff:0.0.0.0',
      ],
    },
    {
      flag: 'blockPrivateIPs',
      addresses: [
        '10.1.2.3',
        '::ffff:10.1.2.3',
        '::ffff:ac10:1',
        '::ffff:c0a8:1',
        '::ffff:a9fe:aa02',
        '::ffff:6440:1',
        '::ffff:647f:ffff',
        '::ffff:1:203',
        '::ffff:c612:1',
        '::ffff:c613:ffff',
        '0:0:0:0:0:0:0:1',
        '0:0:0:0:0:0:0:0',
        'FE80:0:0:0:0:0:0:1',
        'FEBF:ffff::1',
        'FC00::1',
        'FDFF::1',
      ],
    },
    {
      flag: 'blockMetadata',
      addresses: [
        '169.254.169.254',
        '::ffff:169.254.169.254',
        '::FFFF:A9FE:A9FE',
        '0:0:0:0:0:ffff:a9fe:a9fe',
      ],
    },
  ] as const;

  for (const { flag, addresses } of cases) {
    it.each(addresses)(`${flag} denies equivalent request and DNS address %s`, async (address) => {
      const policy = new NetworkPolicy({ [flag]: true });
      const forms = address.includes(':') ? [address, `[${address}]`] : [address];
      for (const hostname of forms) {
        await expect(policy.checkRequest({ hostname })).rejects.toMatchObject({
          code: 'POLICY_DENIED',
          details: { rule: flag },
        });
        await expect(policy.checkResolvedAddresses([hostname])).rejects.toMatchObject({
          code: 'POLICY_DENIED',
        });
      }
      await expect(
        new NetworkPolicy().checkResolvedAddresses([...addresses])
      ).resolves.toBeUndefined();
    });
  }

  it.each([
    '93.184.216.34',
    '::ffff:93.184.216.34',
    '::FFFF:5DB8:D822',
    '2001:4860:4860::8888',
    '2001:4860:4860:0:0:0:0:8888',
    '100.63.255.255',
    '100.128.0.0',
    '198.17.255.255',
    '198.20.0.0',
    'fec0::1',
    'fbff::1',
    'fe00::1',
  ])('retains allowed address %s under all flags', async (address) => {
    const policy = new NetworkPolicy({
      blockLoopback: true,
      blockPrivateIPs: true,
      blockMetadata: true,
    });
    await expect(policy.checkRequest({ hostname: address })).resolves.toBeUndefined();
    await expect(policy.checkResolvedAddresses([address])).resolves.toBeUndefined();
  });

  it('preserves independent flag membership, including mapped IPv4', async () => {
    for (const address of ['127.0.0.1', '::ffff:127.0.0.1']) {
      await expect(
        new NetworkPolicy({ blockPrivateIPs: true }).checkResolvedAddresses([address])
      ).resolves.toBeUndefined();
    }
    await expect(
      new NetworkPolicy({ blockMetadata: true }).checkResolvedAddresses([
        '10.0.0.1',
        '::ffff:10.0.0.1',
        '::1',
      ])
    ).resolves.toBeUndefined();
    await expect(
      new NetworkPolicy({ blockLoopback: true }).checkResolvedAddresses([
        '10.0.0.1',
        '::ffff:169.254.169.254',
      ])
    ).resolves.toBeUndefined();
  });

  it.each([
    '',
    'not-an-ip',
    '127.0.0.999',
    '127.000.0.1',
    '127.1',
    '2130706433',
    '0x7f000001',
    '::ffff:999.1.1.1',
    '1::2::3',
    'fe80::1%en0',
    '[::1',
    '::1]',
    ' 127.0.0.1',
    '127.0.0.1/8',
  ])('rejects malformed or scoped DNS address %s even with all flags off', async (address) => {
    await expect(new NetworkPolicy().checkResolvedAddresses([address])).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { rule: 'resolvedAddressInvalid' },
    });
  });

  it('rejects an empty DNS answer set', async () => {
    await expect(new NetworkPolicy().checkResolvedAddresses([])).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
  });

  it('denies mixed answer sets in either order through session policy', async () => {
    const policy = new SessionHostPolicy(new NetworkPolicy({ blockLoopback: true }), {
      allowedHosts: ['download.invalid'],
    });
    await policy.checkRequest({ hostname: 'download.invalid', url: 'http://download.invalid/' });
    for (const addresses of [
      ['93.184.216.34', '::ffff:127.0.0.1'],
      ['::ffff:127.0.0.1', '93.184.216.34'],
    ]) {
      await expect(policy.checkResolvedAddresses(addresses)).rejects.toMatchObject({
        code: 'POLICY_DENIED',
      });
    }
  });
});
