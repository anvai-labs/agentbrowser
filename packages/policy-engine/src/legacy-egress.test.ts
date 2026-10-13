import { NetworkPolicy } from '@agentbrowser/policy';
import { describe, expect, it } from 'vitest';
import { egressExceptionsOf } from './authorizer.js';
import { LegacyAuthorizer } from './legacy-authorizer.js';

// TD-BROWSER-15 phase 1 (egress): today's loopback and private-CIDR exceptions,
// answered by the Authorizer. The oracle is NetworkPolicy's own default hook.

const ADDRESSES = [
  '127.0.0.1',
  '::1',
  '::',
  '0.0.0.0',
  '10.0.0.1',
  '10.1.2.3',
  '192.168.1.5',
  '192.168.2.5',
  '172.16.0.1',
  '100.64.0.1',
  '198.18.0.1',
  'fd12::1',
  'fd12:1::1',
  'fe80::1',
  '93.184.216.34',
  '2001:4860:4860::8888',
  '::ffff:192.168.1.5',
  '::ffff:10.0.0.1',
  '64:ff9b::c0a8:105',
  '64:ff9b::a00:1',
  '64:ff9b::7f00:1',
  '2002:c0a8:105::',
  '2002:a00:1::',
  '::c0a8:105',
  '::ffff:0:c0a8:105',
  '64:ff9b:1:a00:0:100::',
  '169.254.169.254',
  '100.100.100.200',
];
const HOSTNAMES = [
  'localhost',
  'localhost.localdomain',
  'example.com',
  ...ADDRESSES.map((a) => (a.includes(':') ? `[${a}]` : a)),
];
const CIDR_SETS = [
  [],
  ['192.168.1.0/24'],
  ['10.0.0.0/8', 'fd12::/64'],
  ['0.0.0.0/0'],
  ['::/0'],
  ['64:ff9b::/96'],
  ['192.168.0.0/16', '172.16.0.0/12'],
  ['fd12::/32', '100.64.0.0/10'],
];

async function outcome(run: () => Promise<void>): Promise<string> {
  try {
    await run();
    return 'allow';
  } catch (error) {
    return `deny:${(error as { details?: { rule?: string } }).details?.rule}`;
  }
}

describe('LegacyAuthorizer egress exceptions', () => {
  it('matches NetworkPolicy defaults for every address, hostname and setting', async () => {
    let cases = 0;
    for (const allowLoopback of [false, true]) {
      for (const cidrs of CIDR_SETS) {
        for (const blockMetadata of [false, true]) {
          // Legacy configuration, as networkPolicyFromEnvironment builds it.
          const legacy = new NetworkPolicy({
            blockLoopback: !allowLoopback,
            blockPrivateIPs: true,
            blockMetadata,
            allowedPrivateCIDRs: cidrs,
          });
          // Same configuration with the exceptions answered by the Authorizer.
          const authorizer = new LegacyAuthorizer({ allowLoopback, allowedPrivateCIDRs: cidrs });
          const seamed = new NetworkPolicy({
            blockLoopback: true,
            blockPrivateIPs: true,
            blockMetadata,
            exceptions: egressExceptionsOf(authorizer),
          });
          for (const address of ADDRESSES) {
            expect(await outcome(() => seamed.checkResolvedAddresses([address]))).toBe(
              await outcome(() => legacy.checkResolvedAddresses([address]))
            );
            cases++;
          }
          for (const hostname of HOSTNAMES) {
            expect(await outcome(() => seamed.checkRequest({ hostname }))).toBe(
              await outcome(() => legacy.checkRequest({ hostname }))
            );
            cases++;
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(1500);
  });

  it('names the deciding rule', () => {
    const authorizer = new LegacyAuthorizer({
      allowLoopback: false,
      allowedPrivateCIDRs: ['10.0.0.0/8'],
    });
    const ctx = (cls: Array<'loopback' | 'private'>, address: string) => ({
      phase: 'resolved' as const,
      target: address,
      addressClasses: cls,
      privateSources: cls.includes('private') ? [{ address, type: 'ipv4' as const }] : [],
    });
    expect(
      authorizer.decide({ action: 'request.loopback', context: ctx(['loopback'], '127.0.0.1') })
    ).toMatchObject({
      allowed: false,
      ruleMatched: 'env.block-loopback',
    });
    expect(
      authorizer.decide({ action: 'request.private', context: ctx(['private'], '10.0.0.1') })
    ).toMatchObject({
      allowed: true,
      ruleMatched: 'env.allowed-cidrs',
    });
    expect(
      authorizer.decide({ action: 'request.private', context: ctx(['private'], '192.168.1.1') })
    ).toMatchObject({
      allowed: false,
      ruleMatched: 'env.block-private',
    });
    expect(
      new LegacyAuthorizer({ allowLoopback: true }).decide({
        action: 'request.loopback',
        context: ctx(['loopback'], '127.0.0.1'),
      })
    ).toMatchObject({ allowed: true, ruleMatched: 'env.allow-loopback' });
  });

  it('refuses invalid CIDRs exactly as NetworkPolicy does', () => {
    expect(() => new LegacyAuthorizer({ allowedPrivateCIDRs: ['10.0.0.0'] })).toThrow(
      'Invalid allowedPrivateCIDRs CIDR'
    );
  });
});
