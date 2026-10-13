import { describe, expect, it } from 'vitest';
import { classifyIPAddress } from './ip-address.js';
import { NetworkPolicy } from './network-policy.js';

// TD-BROWSER-15 phase 0 (ADR-024 §1, §3): the metadata floor widens, and IPv4
// embedded in IPv6 is decoded as a union that only ever adds classes.

const classes = (address: string) => {
  const c = classifyIPAddress(address);
  if (!c) throw new Error(`not an IP: ${address}`);
  return { loopback: c.loopback, privateIP: c.privateIP, metadata: c.metadata };
};

describe('widened metadata floor', () => {
  it.each([
    '169.254.169.254', // AWS/Azure/GCP IMDS
    '169.254.170.2', // ECS task metadata
    '169.254.170.23', // EKS Pod Identity
    '169.254.0.1', // the whole IPv4 link-local range
    '100.100.100.200', // Alibaba Cloud
    '168.63.129.16', // Azure wire server
    'fd00:ec2::254', // AWS IMDS over IPv6
    'fd00:ec2::23', // EKS Pod Identity over IPv6
    'fd00:ec2:0:0:ffff::1', // anywhere in fd00:ec2::/64
    'fe80::1', // IPv6 link-local
    'febf:ffff::1',
    'fd20:ce::254', // GCP metadata server, IPv6-only instances
    'fd00:c1::a9fe:a9fe', // OCI IMDS over IPv6
  ])('classifies %s as metadata', (address) => {
    expect(classes(address).metadata).toBe(true);
  });

  it.each(['169.254.169.254', '168.63.129.16', 'fd00:ec2::254', 'fe80::1'])(
    'refuses %s under blockMetadata as a hostname and as a resolved address',
    async (address) => {
      const policy = new NetworkPolicy({ blockMetadata: true });
      for (const hostname of address.includes(':') ? [address, `[${address}]`] : [address]) {
        await expect(policy.checkRequest({ hostname })).rejects.toMatchObject({
          code: 'POLICY_DENIED',
          details: { rule: 'blockMetadata' },
        });
      }
      await expect(policy.checkResolvedAddresses([address])).rejects.toMatchObject({
        code: 'POLICY_DENIED',
        details: { rule: 'resolvedMetadata' },
      });
    }
  );

  it('keeps metadata refused even when every private range is an operator exception', async () => {
    const policy = new NetworkPolicy({
      blockLoopback: true,
      blockPrivateIPs: true,
      blockMetadata: true,
      allowedPrivateCIDRs: ['0.0.0.0/0', '::/0'],
    });
    for (const address of ['fd00:ec2::254', '169.254.170.2', '100.100.100.200', 'fe80::1']) {
      await expect(policy.checkResolvedAddresses([address])).rejects.toMatchObject({
        code: 'POLICY_DENIED',
        details: { rule: 'resolvedMetadata' },
      });
    }
    // An ordinary private exception still works.
    await expect(policy.checkResolvedAddresses(['192.168.1.89'])).resolves.toBeUndefined();
  });

  it('leaves neighbouring public and private addresses unchanged', () => {
    expect(classes('168.63.129.15').metadata).toBe(false);
    expect(classes('100.100.100.201')).toEqual({
      loopback: false,
      privateIP: true,
      metadata: false,
    });
    expect(classes('fd00:ec2:0:1::254')).toEqual({
      loopback: false,
      privateIP: true,
      metadata: false,
    });
    expect(classes('fec0::1').metadata).toBe(false);
  });
});

describe('embedded IPv4 decoding (union, only adds classes)', () => {
  it.each([
    ['64:ff9b::7f00:1', 'loopback'], // NAT64 well-known prefix, 127.0.0.1
    ['64:ff9b::a9fe:a9fe', 'metadata'], // NAT64, 169.254.169.254
    ['64:ff9b::a00:1', 'privateIP'], // NAT64, 10.0.0.1
    ['64:ff9b:1::7f00:1', 'loopback'], // NAT64 local-use prefix
    ['2002:7f00:1::', 'loopback'], // 6to4, 127.0.0.1
    ['2002:a9fe:a9fe::1', 'metadata'], // 6to4, 169.254.169.254
    ['2002:c0a8:101::', 'privateIP'], // 6to4, 192.168.1.1
    ['::7f00:1', 'loopback'], // IPv4-compatible, 127.0.0.1
    ['::a9fe:a9fe', 'metadata'], // IPv4-compatible, 169.254.169.254
  ] as const)('%s carries the embedded %s class', (address, cls) => {
    expect(classes(address)[cls]).toBe(true);
  });

  it('marks embedded metadata as private too, as its IPv4 form is', () => {
    expect(classes('64:ff9b::a9fe:a9fe')).toEqual({
      loopback: false,
      privateIP: true,
      metadata: true,
    });
  });

  it('never decodes :: or ::1, so IPv6 loopback stays {loopback, private}', () => {
    expect(classes('::1')).toEqual({ loopback: true, privateIP: true, metadata: false });
    expect(classes('::')).toEqual({ loopback: true, privateIP: true, metadata: false });
  });

  it('keeps ::1 refused under a /0 private exception', async () => {
    const policy = new NetworkPolicy({
      blockLoopback: true,
      blockPrivateIPs: true,
      allowedPrivateCIDRs: ['0.0.0.0/0', '::/0'],
    });
    for (const address of ['::1', '::', '64:ff9b::7f00:1', '2002:7f00:1::', '::7f00:1']) {
      await expect(policy.checkResolvedAddresses([address])).rejects.toMatchObject({
        code: 'POLICY_DENIED',
        details: { rule: 'resolvedLoopback' },
      });
    }
  });

  it('refuses embedded loopback as a request hostname', async () => {
    const policy = new NetworkPolicy({ blockLoopback: true });
    for (const hostname of ['[64:ff9b::7f00:1]', '[2002:7f00:1::]', '[::7f00:1]']) {
      await expect(policy.checkRequest({ hostname })).rejects.toMatchObject({
        code: 'POLICY_DENIED',
        details: { rule: 'blockLoopback' },
      });
    }
  });

  it('leaves public embedded addresses public', () => {
    for (const address of ['64:ff9b::5db8:d822', '2002:5db8:d822::', '::5db8:d822']) {
      expect(classes(address)).toEqual({ loopback: false, privateIP: false, metadata: false });
    }
  });
});

describe('review round 1: every RFC 6052 layout, SIIT, and CIDRs on the embedded IPv4', () => {
  // RFC 8215 64:ff9b:1::/48 may be used with any RFC 6052 prefix length; the IPv4
  // then sits at different offsets (skipping the reserved u-octet, byte 8).
  it.each([
    ['64:ff9b:1:7f00:0:100:808:808', 'loopback'], // /48 layout: 127.0.0.1
    ['64:ff9b:1:a00:0:100:808:808', 'privateIP'], // /48 layout: 10.0.0.1
    ['64:ff9b:1:a9fe:a9:fe00:808:808', 'metadata'], // /48 layout: 169.254.169.254
    ['64:ff9b:1:7f:0:1::', 'loopback'], // /56 layout: 127.0.0.1
    ['64:ff9b:1:0:7f:0:1:0', 'loopback'], // /64 layout: 127.0.0.1
  ] as const)('%s carries the embedded %s class', (address, cls) => {
    expect(classes(address)[cls]).toBe(true);
  });

  it('treats the never-global local-use NAT64 prefix as private', () => {
    expect(classes('64:ff9b:1:ffff:ffff:ffff:ffff:ffff').privateIP).toBe(true);
  });

  it.each([
    ['::ffff:0:7f00:1', 'loopback'], // SIIT IPv4-translated: 127.0.0.1
    ['::ffff:0:a9fe:a9fe', 'metadata'], // SIIT: 169.254.169.254
  ] as const)('decodes SIIT %s as %s', (address, cls) => {
    expect(classes(address)[cls]).toBe(true);
  });

  it('matches an IPv4 CIDR exception on the embedded IPv4 of every wrapper form', async () => {
    const policy = new NetworkPolicy({
      blockPrivateIPs: true,
      allowedPrivateCIDRs: ['192.168.1.0/24'],
    });
    for (const address of [
      '192.168.1.5',
      '::ffff:192.168.1.5',
      '64:ff9b::c0a8:105',
      '2002:c0a8:105::',
      '::c0a8:105',
    ]) {
      await expect(policy.checkResolvedAddresses([address])).resolves.toBeUndefined();
    }
    await expect(policy.checkResolvedAddresses(['64:ff9b::c0a8:205'])).rejects.toMatchObject({
      details: { rule: 'resolvedPrivate' },
    });
  });

  it('never lets an IPv6 wrapper exception grant the private IPv4 inside it', async () => {
    // ::/0 is not a wrapper exception: Node's BlockList matches every IPv4 against
    // it through the mapped form, so it already grants 10.0.0.1 directly and,
    // consistently, behind any wrapper. Only narrower wrapper CIDRs are tested.
    for (const cidr of ['64:ff9b::/96', '2002::/16']) {
      const policy = new NetworkPolicy({ blockPrivateIPs: true, allowedPrivateCIDRs: [cidr] });
      for (const address of ['64:ff9b::a00:1', '2002:a00:1::', '::a00:1']) {
        await expect(policy.checkResolvedAddresses([address])).rejects.toMatchObject({
          details: { rule: 'resolvedPrivate' },
        });
      }
    }
    // A genuinely private IPv6 address is still granted by an IPv6 exception.
    const v6 = new NetworkPolicy({ blockPrivateIPs: true, allowedPrivateCIDRs: ['fd12::/64'] });
    await expect(v6.checkResolvedAddresses(['fd12::1'])).resolves.toBeUndefined();
  });
});

describe('metadata hostnames: trailing dot and short names', () => {
  it.each([
    'metadata.google.internal.',
    'METADATA.GOOGLE.INTERNAL',
    'x.metadata.goog.',
    'metadata', // GCP search-domain short name
    'metadata.', // and with the root dot
    'instance-data', // AWS
    'instance-data.ec2.internal',
    'instance-data.ec2.internal.',
  ])('refuses %s as a request hostname under blockMetadata', async (hostname) => {
    await expect(
      new NetworkPolicy({ blockMetadata: true }).checkRequest({ hostname })
    ).rejects.toMatchObject({ details: { rule: 'blockMetadata' } });
  });

  it('does not refuse lookalikes', async () => {
    const policy = new NetworkPolicy({ blockMetadata: true });
    for (const hostname of ['metadata.example.com', 'notmetadata.goog', 'instance-database']) {
      await expect(policy.checkRequest({ hostname })).resolves.toBeUndefined();
    }
  });
});
