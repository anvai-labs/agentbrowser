import { describe, expect, it, vi } from 'vitest';
import { MetadataFloorPolicy } from './floor-policy.js';
import { NetworkPolicy, SessionHostPolicy } from './network-policy.js';
import { EngagementScopePolicy } from './scope-policy.js';

// TD-BROWSER-15 phase 0 (ADR-024 §1): the metadata floor binds whatever policy
// the service was given, including an embedder's `new NetworkPolicy({})`.

const permissive = () => new NetworkPolicy({}); // blockMetadata off, as embedders may pass

describe('MetadataFloorPolicy', () => {
  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://[fd00:ec2::254]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://x.metadata.goog/',
    'http://168.63.129.16/machine',
  ])('refuses %s even over a policy with metadata blocking off', async (url) => {
    const floor = new MetadataFloorPolicy(permissive());
    const hostname = new URL(url).hostname;
    await expect(floor.checkRequest({ hostname, url })).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { rule: 'floor.metadata' },
    });
  });

  it('refuses a metadata address in a DNS answer, in any position', async () => {
    const floor = new MetadataFloorPolicy(permissive());
    for (const answer of [['169.254.170.2'], ['93.184.216.34', 'fd00:ec2::23']]) {
      await expect(floor.checkResolvedAddresses(answer)).rejects.toMatchObject({
        details: { rule: 'floor.metadata' },
      });
    }
  });

  it('refuses a metadata host in a redirect hop', async () => {
    const floor = new MetadataFloorPolicy(permissive());
    await expect(
      floor.checkRedirectChain([{ url: 'http://169.254.169.254/latest/' }])
    ).rejects.toMatchObject({ details: { rule: 'floor.metadata' } });
  });

  it('runs before the base, so a permissive base never sees a metadata request', async () => {
    const base = permissive();
    const spy = vi.spyOn(base, 'checkRequest');
    await expect(
      new MetadataFloorPolicy(base).checkRequest({
        hostname: '169.254.169.254',
        url: 'http://169.254.169.254/',
      })
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('delegates everything else to the base unchanged', async () => {
    const floor = new MetadataFloorPolicy(
      new SessionHostPolicy(new NetworkPolicy({ blockLoopback: true }), {
        allowedHosts: ['example.com'],
      })
    );
    await expect(
      floor.checkRequest({ hostname: 'example.com', url: 'https://example.com/' })
    ).resolves.toBeUndefined();
    await expect(
      floor.checkRequest({ hostname: 'other.example', url: 'https://other.example/' })
    ).rejects.toMatchObject({ details: { rule: 'sessionAllowedHosts' } });
    await expect(floor.checkResolvedAddresses(['127.0.0.1'])).rejects.toMatchObject({
      details: { rule: 'resolvedLoopback' },
    });
    await expect(floor.checkResolvedAddresses(['93.184.216.34'])).resolves.toBeUndefined();
  });

  it('passes the request object through, including method and headers', async () => {
    const checkRequest = vi.fn(async () => {});
    const floor = new MetadataFloorPolicy({ checkRequest });
    const request = {
      hostname: 'example.com',
      url: 'https://example.com/',
      method: 'POST',
      headers: { 'x-id': '1' },
    };
    await floor.checkRequest(request);
    expect(checkRequest).toHaveBeenCalledWith(request);
  });

  it('exposes each optional gate only when the base has it', () => {
    // Downloads refuse a policy without a DNS gate ("strict policy"). The floor
    // must not make a weaker base look strict by adding gates of its own.
    const bare = new MetadataFloorPolicy({ checkRequest: async () => {} });
    expect(bare.checkResolvedAddresses).toBeUndefined();
    expect(bare.checkRedirectChain).toBeUndefined();
    expect(bare.checkResponse).toBeUndefined();
    expect(bare.checkBodySize).toBeUndefined();

    const full = new MetadataFloorPolicy(permissive());
    expect(typeof full.checkResolvedAddresses).toBe('function');
    expect(typeof full.checkRedirectChain).toBe('function');
    expect(typeof full.checkResponse).toBe('function');
    expect(typeof full.checkBodySize).toBe('function');
  });

  it('passes the scope preflight through, floor first, without spending budget', async () => {
    const scope = new EngagementScopePolicy(permissive(), {
      allowedHosts: ['example.com', '169.254.169.254'],
      requestBudget: 1,
    });
    const floor = new MetadataFloorPolicy(scope);
    expect(typeof floor.preflightCheck).toBe('function');
    for (let i = 0; i < 3; i++) {
      await expect(
        floor.preflightCheck?.({ hostname: 'example.com', url: 'https://example.com/' })
      ).resolves.toBeUndefined();
    }
    await expect(
      floor.preflightCheck?.({ hostname: '169.254.169.254', url: 'http://169.254.169.254/' })
    ).rejects.toMatchObject({ details: { rule: 'floor.metadata' } });
    expect(new MetadataFloorPolicy(permissive()).preflightCheck).toBeUndefined();
  });
});
