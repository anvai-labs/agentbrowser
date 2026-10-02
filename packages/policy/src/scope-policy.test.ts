import { describe, expect, it } from 'vitest';
import { NetworkPolicy, NetworkPolicyError } from './network-policy.js';
import { EngagementScopePolicy } from './scope-policy.js';

const permissiveBase = () => new NetworkPolicy({ blockLoopback: false });

describe('EngagementScopePolicy (T7 slice 2)', () => {
  it('allows in-scope hosts and denies everything else (exhaustive allowlist)', async () => {
    const scope = new EngagementScopePolicy(permissiveBase(), {
      allowedHosts: ['api.testhost.example', '.cdn.testhost.example'],
    });
    await scope.checkRequest({
      hostname: 'api.testhost.example',
      url: 'https://api.testhost.example/',
    });
    await scope.checkRequest({
      hostname: 'assets.cdn.testhost.example',
      url: 'https://assets.cdn.testhost.example/a.js',
    });
    await expect(
      scope.checkRequest({ hostname: 'offscope.example', url: 'https://offscope.example/' })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // A lookalike suffix is not a suffix match.
    await expect(
      scope.checkRequest({
        hostname: 'apitesthost.example',
        url: 'https://apitesthost.example/',
      })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('denies non-matching pathnames on in-scope hosts', async () => {
    const scope = new EngagementScopePolicy(permissiveBase(), {
      allowedHosts: ['app.testhost.example'],
      pathRules: [{ prefix: '/api/' }],
    });
    await scope.checkRequest({
      hostname: 'app.testhost.example',
      url: 'https://app.testhost.example/api/users',
    });
    await expect(
      scope.checkRequest({
        hostname: 'app.testhost.example',
        url: 'https://app.testhost.example/admin',
      })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // Host-scoped rules only bind their own host.
    const scoped = new EngagementScopePolicy(permissiveBase(), {
      allowedHosts: ['app.testhost.example', 'other.testhost.example'],
      pathRules: [{ hostSuffix: 'app.testhost.example', prefix: '/api/' }],
    });
    await scoped.checkRequest({
      hostname: 'other.testhost.example',
      url: 'https://other.testhost.example/anything',
    });
  });

  it('enforces the method allowlist (uppercase-compared)', async () => {
    const scope = new EngagementScopePolicy(permissiveBase(), {
      allowedHosts: ['api.testhost.example'],
      allowedMethods: ['get', 'POST'],
    });
    await scope.checkRequest({
      hostname: 'api.testhost.example',
      url: 'https://api.testhost.example/x',
      method: 'GET',
    });
    await expect(
      scope.checkRequest({
        hostname: 'api.testhost.example',
        url: 'https://api.testhost.example/x',
        method: 'DELETE',
      })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // Absent method (callers that do not pass one) cannot bypass the list.
    await expect(
      scope.checkRequest({
        hostname: 'api.testhost.example',
        url: 'https://api.testhost.example/x',
      })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('blocks identity-marked requests to unbound hosts before they leak', async () => {
    const scope = new EngagementScopePolicy(permissiveBase(), {
      allowedHosts: ['app.testhost.example', 'offscope.example'],
      identityBindings: [
        {
          header: 'x-test-identity',
          value: 'admin-session',
          allowedHosts: ['app.testhost.example'],
        },
      ],
    });
    await scope.checkRequest({
      hostname: 'app.testhost.example',
      url: 'https://app.testhost.example/',
      headers: { 'x-test-identity': 'admin-session' },
    });
    await expect(
      scope.checkRequest({
        hostname: 'offscope.example',
        url: 'https://offscope.example/',
        headers: { 'x-test-identity': 'admin-session' },
      })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // A different identity value is not bound by the rule and rides the
    // host rules alone.
    await scope.checkRequest({
      hostname: 'offscope.example',
      url: 'https://offscope.example/',
      headers: { 'x-test-identity': 'someone-else' },
    });
  });

  it('denies every check once the scope has expired (injected clock)', async () => {
    let now = 1_000_000;
    const scope = new EngagementScopePolicy(permissiveBase(), {
      allowedHosts: ['api.testhost.example'],
      expiresAt: 1_000_500,
      now: () => now,
    });
    await scope.checkRequest({
      hostname: 'api.testhost.example',
      url: 'https://api.testhost.example/',
    });
    now = 1_000_499;
    await scope.checkRequest({
      hostname: 'api.testhost.example',
      url: 'https://api.testhost.example/x',
    });
    now = 1_000_500;
    await expect(
      scope.checkRequest({
        hostname: 'api.testhost.example',
        url: 'https://api.testhost.example/y',
      })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // Expiry wins even over hosts/paths that would otherwise be allowed,
    // and no verdict was cached from before the boundary.
    now = 1_000_499;
    await expect(
      scope.checkRequest({
        hostname: 'api.testhost.example',
        url: 'https://api.testhost.example/z',
      })
    ).resolves.toBeUndefined();
  });

  it('counts every request including redirect hops and denies past the budget', async () => {
    const scope = new EngagementScopePolicy(permissiveBase(), {
      allowedHosts: ['a.testhost.example', 'b.testhost.example'],
      requestBudget: 3,
    });
    await scope.checkRequest({
      hostname: 'a.testhost.example',
      url: 'https://a.testhost.example/',
    });
    // Hop 2 and 3 (the walker checks each hop through checkRequest).
    await scope.checkRequest({
      hostname: 'b.testhost.example',
      url: 'https://b.testhost.example/next',
    });
    await scope.checkRequest({
      hostname: 'a.testhost.example',
      url: 'https://a.testhost.example/end',
    });
    await expect(
      scope.checkRequest({ hostname: 'a.testhost.example', url: 'https://a.testhost.example/more' })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // A spent budget is spent: even redirect hops and previously-allowed
    // hosts are denied, and checkRedirectChain cannot ride around it.
    await expect(
      scope.checkRedirectChain([{ url: 'https://b.testhost.example/again' }])
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('never weakens the base policy: both run, either may deny', async () => {
    const scope = new EngagementScopePolicy(new NetworkPolicy({ blockLoopback: true }), {
      allowedHosts: ['api.testhost.example', 'localhost'],
    });
    await scope.checkRequest({
      hostname: 'api.testhost.example',
      url: 'https://api.testhost.example/',
    });
    // In scope by host rules, denied by the base SSRF policy.
    await expect(
      scope.checkRequest({ hostname: 'localhost', url: 'https://localhost/' })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // Base delegates response/body checks through the scope wrapper.
    await scope.checkResponse({ headers: { 'content-length': '10' } });
    await scope.checkBodySize(10);
  });

  it('carries scope sub-codes in the denial details for typed refusals', async () => {
    const scope = new EngagementScopePolicy(permissiveBase(), {
      allowedHosts: ['api.testhost.example'],
    });
    const expired = new EngagementScopePolicy(permissiveBase(), {
      allowedHosts: ['api.testhost.example'],
      expiresAt: 1,
    });
    for (const [probe, expected] of [
      [
        () =>
          scope.checkRequest({ hostname: 'offscope.example', url: 'https://offscope.example/' }),
        'SCOPE_HOST_DENIED',
      ],
      [
        () =>
          expired.checkRequest({
            hostname: 'api.testhost.example',
            url: 'https://api.testhost.example/',
          }),
        'SCOPE_EXPIRED',
      ],
    ] as Array<[() => Promise<void>, string]>) {
      const error = await probe().then(
        () => null,
        (e: NetworkPolicyError) => e
      );
      expect(error).toBeInstanceOf(NetworkPolicyError);
      expect(error?.code).toBe('POLICY_DENIED');
      expect(String(error?.message)).toContain(expected);
      expect(error?.details?.reason).toBe('egress_policy');
      expect(error?.details?.scope).toBe(expected);
    }
  });

  it('matches path prefixes on segment boundaries so a bare prefix cannot expand scope', async () => {
    const scope = new EngagementScopePolicy(permissiveBase(), {
      allowedHosts: ['app.testhost.example'],
      pathRules: [{ prefix: '/api' }],
    });
    await scope.checkRequest({
      hostname: 'app.testhost.example',
      url: 'https://app.testhost.example/api',
    });
    await scope.checkRequest({
      hostname: 'app.testhost.example',
      url: 'https://app.testhost.example/api/users',
    });
    // Sibling spellings that share the string prefix are OUT of scope.
    await expect(
      scope.checkRequest({
        hostname: 'app.testhost.example',
        url: 'https://app.testhost.example/apix',
      })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(
      scope.checkRequest({
        hostname: 'app.testhost.example',
        url: 'https://app.testhost.example/apiary',
      })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('matches ".suffix" host entries on subdomains only, like SessionHostPolicy', async () => {
    const scope = new EngagementScopePolicy(permissiveBase(), {
      allowedHosts: ['.testhost.example'],
    });
    await scope.checkRequest({
      hostname: 'app.testhost.example',
      url: 'https://app.testhost.example/',
    });
    // The apex is NOT covered by the suffix entry — aligning with
    // SessionHostPolicy so the two host policies authorize identically.
    await expect(
      scope.checkRequest({ hostname: 'testhost.example', url: 'https://testhost.example/' })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const withApex = new EngagementScopePolicy(permissiveBase(), {
      allowedHosts: ['testhost.example', '.testhost.example'],
    });
    await withApex.checkRequest({
      hostname: 'testhost.example',
      url: 'https://testhost.example/',
    });
  });

  it('constructs with an empty allowlist only as an explicit deny-all', async () => {
    const scope = new EngagementScopePolicy(permissiveBase(), { allowedHosts: [] });
    await expect(
      scope.checkRequest({ hostname: 'api.testhost.example', url: 'https://api.testhost.example/' })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
});
