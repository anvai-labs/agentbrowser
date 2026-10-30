import { describe, expect, it, vi } from 'vitest';
import { MetadataFloorPolicy } from './floor-policy.js';
import { EngagementScopePolicy, scopeConfigurationIssues } from './scope-policy.js';

const marker = { header: 'X-HackerOne-Research', value: 'researcher', hostSuffix: '.wolt.com' };
const base = () => ({ checkRequest: vi.fn().mockResolvedValue(undefined) });

describe('T10 M5 research markers', () => {
  it('recognizes overlap with a bare domain that admits its subtree', () => {
    for (const [allowed, hostSuffix] of [
      ['wolt.com', '.wolt.com'],
      ['api.wolt.com', 'wolt.com'],
    ] as const) {
      const scope = new EngagementScopePolicy(base(), {
        allowedHosts: [allowed],
        requestHeaders: [{ ...marker, hostSuffix }],
      });
      expect(scope.headersForRequest!('api.wolt.com', {})).toEqual({
        'x-hackerone-research': 'researcher',
      });
    }
  });
  it('injects on the host subtree, strips inherited/forged values elsewhere and composes with bindings', async () => {
    const policy = base();
    const scope = new EngagementScopePolicy(policy, {
      allowedHosts: ['.wolt.com', 'other.test'],
      requestHeaders: [marker],
      identityBindings: [
        { header: marker.header, value: marker.value, allowedHosts: ['.wolt.com'] },
      ],
    });
    const floor = new MetadataFloorPolicy(scope);
    const original = { 'X-HackerOne-Research': 'forged', accept: '*/*' };
    const bound = floor.headersForRequest!('API.WOLT.COM.', original);
    expect(bound).toEqual({ 'x-hackerone-research': 'researcher', accept: '*/*' });
    await floor.checkRequest({
      hostname: 'api.wolt.com',
      url: 'https://api.wolt.com/',
      headers: bound,
    });
    expect(policy.checkRequest).toHaveBeenCalledWith(expect.objectContaining({ headers: bound }));
    for (const host of ['wolt.com', 'evilwolt.com', 'wolt.com.attacker.test', 'other.test'])
      expect(floor.headersForRequest!(host, bound)).toEqual({ accept: '*/*' });
    expect(original['X-HackerOne-Research']).toBe('forged');
    expect(scope.status().requestHeaders).toEqual([
      {
        header: marker.header.toLowerCase(),
        hostSuffix: '.wolt.com',
        valueSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    expect(JSON.stringify(scope.status())).not.toContain('researcher');
    policy.checkRequest.mockRejectedValue(new Error('base denied'));
    await expect(
      floor.checkRequest({ hostname: 'api.wolt.com', url: 'https://api.wolt.com/', headers: bound })
    ).rejects.toThrow('base denied');
    await expect(
      floor.checkRequest({ hostname: '169.254.169.254', url: 'http://169.254.169.254/' })
    ).rejects.toMatchObject({ details: { rule: 'floor.metadata' } });
  });

  it.each([
    'Host',
    'Content-Length',
    'Cookie',
    'Authorization',
    'User-Agent',
    'Proxy-Authorization',
    'Sec-Fetch-Site',
    'X-Forwarded-For',
    'X-Authorization',
    'X-XSRF-Token',
    'x-api-key',
    'X-HTTP-Method-Override',
    'x-amz-security-token',
  ])('refuses %s', (header) => {
    expect(
      () =>
        new EngagementScopePolicy(base(), {
          allowedHosts: ['.wolt.com'],
          requestHeaders: [{ ...marker, header }],
        })
    ).toThrow();
  });

  it('refuses duplicate names, line breaks, unbound rules and excessive sizes', () => {
    for (const requestHeaders of [
      [marker, { ...marker, header: marker.header.toLowerCase() }],
      [{ ...marker, value: 'a\r\nb' }],
      [{ ...marker, value: 'a'.repeat(1025) }],
      [{ ...marker, hostSuffix: 'elsewhere.test' }],
      Array.from({ length: 17 }, (_, i) => ({ ...marker, header: `X-Research-${i}` })),
      Array.from({ length: 9 }, (_, i) => ({
        ...marker,
        header: `X-Research-${i}`,
        value: 'a'.repeat(1024),
      })),
    ])
      expect(
        scopeConfigurationIssues({ allowedHosts: ['.wolt.com'], requestHeaders }).length
      ).toBeGreaterThan(0);
  });
});
