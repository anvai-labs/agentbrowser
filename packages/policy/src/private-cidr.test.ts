import { describe, expect, it } from 'vitest';
import { NetworkPolicy, SessionHostPolicy } from './network-policy.js';

const defaults = { blockLoopback: true, blockPrivateIPs: true, blockMetadata: true };
const cidrs = ['192.168.1.89/32', '10.20.0.0/16', 'fd12:3456::/48'];
const policy = (allowedPrivateCIDRs = cidrs) =>
  new NetworkPolicy({ ...defaults, allowedPrivateCIDRs });
const gates = {
  hostname: (p: NetworkPolicy, address: string) => p.checkRequest({ hostname: address }),
  resolved: (p: NetworkPolicy, address: string) => p.checkResolvedAddresses([address]),
};

for (const [name, check] of Object.entries(gates)) {
  describe(`private CIDR ${name} gate`, () => {
    it.each([
      '192.168.1.89',
      '::ffff:192.168.1.89',
      '::FFFF:C0A8:159',
      '[::ffff:c0a8:159]',
      '10.20.0.0',
      '10.20.255.255',
      'fd12:3456::1',
      '[FD12:3456:0:ffff::1]',
    ])('allows explicitly listed identity %s', async (address) => {
      await expect(check(policy(), address)).resolves.toBeUndefined();
    });
    it.each([
      '192.168.1.65',
      '192.168.1.88',
      '192.168.1.90',
      '10.19.255.255',
      '10.21.0.0',
      'fd12:3456:1::1',
      '::ffff:192.168.1.65',
    ])('denies unlisted private identity %s', async (address) => {
      await expect(check(policy(), address)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    });
    it.each([
      '127.0.0.1',
      '::1',
      '::',
      '0.0.0.0',
      '::ffff:127.0.0.1',
      '169.254.169.254',
      '::ffff:169.254.169.254',
    ])('keeps loopback and metadata denied with /0: %s', async (address) => {
      await expect(check(policy(['0.0.0.0/0', '::/0']), address)).rejects.toMatchObject({
        code: 'POLICY_DENIED',
      });
    });
    it('preserves default denial and public access', async () => {
      await expect(check(policy([]), '192.168.1.89')).rejects.toMatchObject({
        code: 'POLICY_DENIED',
      });
      await expect(check(policy(), '93.184.216.34')).resolves.toBeUndefined();
      await expect(check(policy(['0.0.0.0/0', '::/0']), '192.168.20.1')).resolves.toBeUndefined();
      await expect(check(policy(['0.0.0.0/0', '::/0']), 'fdab::1')).resolves.toBeUndefined();
    });
  });
}

it('permits a DNS name resolving to a listed address but rejects any unlisted answer', async () => {
  const p = policy();
  await p.checkRequest({ hostname: 'lab.example.test' });
  await expect(p.checkResolvedAddresses(['192.168.1.89'])).resolves.toBeUndefined();
  for (const addresses of [
    ['192.168.1.89', '192.168.1.65'],
    ['192.168.1.65', '192.168.1.89'],
  ]) {
    await expect(p.checkResolvedAddresses(addresses)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
  }
  for (const hostname of ['localhost', 'metadata.google.internal', 'metadata.goog']) {
    await expect(policy(['0.0.0.0/0', '::/0']).checkRequest({ hostname })).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
  }
});

it.each([
  '',
  '192.168.1.89',
  '192.168.1.0/',
  '192.168.1.0/33',
  '192.168.1.0/-1',
  '192.168.1.0/1.5',
  '192.168.1.0/1e1',
  '192.168.1.0/0x10',
  '192.168.1.0/24/1',
  '192.168.1.0/ 24',
  ' 192.168.1.0/24',
  '192.168.1.0/24 ',
  '192.168.001.0/24',
  '192.168.1.0/24\n',
  'example.com/24',
  '::/129',
  '::/-1',
  '[fd12::]/64',
  'fe80::1%en0/64',
])('fails closed on invalid CIDR %j', (cidr) => {
  expect(() => policy([cidr])).toThrow(/CIDR/);
});

it('owns the input and output arrays; updates atomically without changing snapshots', async () => {
  const input = ['192.168.1.89/32'];
  const p = policy(input);
  const snapshot = p.snapshot();
  const gateway = p.snapshotForGateway({ allowedPorts: [8080] }).destinationPolicy;
  input.push('192.168.1.65/32');
  p.getConfig().allowedPrivateCIDRs?.push('192.168.1.65/32');
  await expect(p.checkRequest({ hostname: '192.168.1.65' })).rejects.toThrow();
  expect(() =>
    p.updateConfig({ blockPrivateIPs: false, allowedPrivateCIDRs: ['invalid'] })
  ).toThrow();
  await expect(p.checkResolvedAddresses(['192.168.1.65'])).rejects.toThrow();
  p.updateConfig({ allowedPrivateCIDRs: ['192.168.1.65/32'] });
  await expect(p.checkResolvedAddresses(['192.168.1.65'])).resolves.toBeUndefined();
  await expect(p.checkRequest({ hostname: '192.168.1.89' })).rejects.toThrow();
  await expect(snapshot.checkRequest({ hostname: '192.168.1.89' })).resolves.toBeUndefined();
  await expect(snapshot.checkResolvedAddresses(['192.168.1.65'])).rejects.toThrow();
  await expect(
    gateway.checkDestination({ hostname: '192.168.1.89', port: 8080 })
  ).resolves.toBeUndefined();
  await expect(gateway.checkResolvedAddresses(['192.168.1.65'])).rejects.toThrow();
  expect(() => snapshot.updateConfig({ allowedPrivateCIDRs: ['192.168.1.65/32'] })).toThrow();
  await expect(snapshot.checkResolvedAddresses(['192.168.1.65'])).rejects.toThrow();
  p.updateConfig({ allowedPrivateCIDRs: [] });
  await expect(p.checkResolvedAddresses(['192.168.1.65'])).rejects.toThrow();
});

it('keeps session allow/deny hosts restrict-only', async () => {
  const p = new SessionHostPolicy(policy(), {
    blockedHosts: ['192.168.1.89'],
    allowedHosts: ['192.168.1.65'],
  });
  for (const hostname of ['192.168.1.89', '192.168.1.65']) {
    await expect(p.checkRequest({ hostname })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  }
});

it.each([null, '192.168.1.89/32', [null], [32]])(
  'rejects malformed runtime CIDR options %j',
  (input) => {
    expect(() => policy(input as string[])).toThrow(/CIDR/);
  }
);
