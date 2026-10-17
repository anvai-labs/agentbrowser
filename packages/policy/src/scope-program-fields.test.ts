// T10 M3: restrictive program-scope fields. Each can only narrow the scope.
import { describe, expect, it } from 'vitest';
import { NetworkPolicy } from './network-policy.js';
import { EngagementScopePolicy } from './scope-policy.js';

const base = () => new NetworkPolicy({ blockLoopback: false });
const req = (url: string, method = 'GET') => ({ hostname: new URL(url).hostname, url, method });
const denied = (scope: string) => ({ code: 'POLICY_DENIED', details: { scope } });

describe('EngagementScopePolicy program fields (T10 M3)', () => {
  it('excludeHosts removes hosts an allowed suffix would admit (exact and .suffix)', async () => {
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['app.example', '.app.example'],
      excludeHosts: ['admin.app.example', '.internal.app.example'],
    });
    await scope.checkRequest(req('https://www.app.example/'));
    await scope.checkRequest(req('https://app.example/'));
    await expect(scope.checkRequest(req('https://admin.app.example/'))).rejects.toMatchObject(
      denied('SCOPE_HOST_DENIED')
    );
    await expect(scope.checkRequest(req('https://db.internal.app.example/'))).rejects.toMatchObject(
      denied('SCOPE_HOST_DENIED')
    );
    // Case-insensitive, and an exclusion never matches a lookalike.
    await expect(scope.checkRequest(req('https://ADMIN.app.example/'))).rejects.toMatchObject(
      denied('SCOPE_HOST_DENIED')
    );
    await scope.checkRequest(req('https://notadmin.app.example/'));
  });

  it('excludePaths removes segment-bounded prefixes, even inside an allowed path rule', async () => {
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['app.example', 'other.example'],
      pathRules: [{ prefix: '/api' }],
      excludePaths: [
        { prefix: '/api/billing' },
        { hostSuffix: 'other.example', prefix: '/api/admin' },
      ],
    });
    await scope.checkRequest(req('https://app.example/api/users'));
    await expect(scope.checkRequest(req('https://app.example/api/billing'))).rejects.toMatchObject(
      denied('SCOPE_PATH_DENIED')
    );
    await expect(
      scope.checkRequest(req('https://app.example/api/billing/invoices'))
    ).rejects.toMatchObject(denied('SCOPE_PATH_DENIED'));
    // Segment boundary: /api/billingx is not under /api/billing.
    await scope.checkRequest(req('https://app.example/api/billingx'));
    // A host-bound exclusion binds only its host.
    await scope.checkRequest(req('https://app.example/api/admin'));
    await expect(scope.checkRequest(req('https://other.example/api/admin'))).rejects.toMatchObject(
      denied('SCOPE_PATH_DENIED')
    );
  });

  it('excludePaths applies with no allow-side path rules', async () => {
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['app.example'],
      excludePaths: [{ prefix: '/logout' }],
    });
    await scope.checkRequest(req('https://app.example/anything'));
    await expect(scope.checkRequest(req('https://app.example/logout'))).rejects.toMatchObject(
      denied('SCOPE_PATH_DENIED')
    );
  });

  it('allowedSchemes and allowedPorts narrow by origin (default ports by scheme)', async () => {
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['app.example'],
      allowedSchemes: ['https'],
      allowedPorts: [443, 8443],
    });
    await scope.checkRequest(req('https://app.example/'));
    await scope.checkRequest(req('https://app.example:8443/'));
    await expect(scope.checkRequest(req('http://app.example/'))).rejects.toMatchObject(
      denied('SCOPE_HOST_DENIED')
    );
    await expect(scope.checkRequest(req('https://app.example:9443/'))).rejects.toMatchObject(
      denied('SCOPE_HOST_DENIED')
    );
  });

  it('allowedPorts alone uses the scheme default port', async () => {
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['app.example'],
      allowedPorts: [80],
    });
    await scope.checkRequest(req('http://app.example/'));
    await expect(scope.checkRequest(req('https://app.example/'))).rejects.toMatchObject(
      denied('SCOPE_HOST_DENIED')
    );
  });

  it('fails closed when an origin rule is set and the request carries no URL', async () => {
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['app.example'],
      allowedSchemes: ['https'],
    });
    await expect(scope.checkRequest({ hostname: 'app.example' })).rejects.toMatchObject(
      denied('SCOPE_HOST_DENIED')
    );
    const excluding = new EngagementScopePolicy(base(), {
      allowedHosts: ['app.example'],
      excludePaths: [{ prefix: '/logout' }],
    });
    await expect(excluding.checkRequest({ hostname: 'app.example' })).rejects.toMatchObject(
      denied('SCOPE_PATH_DENIED')
    );
  });

  it('the dry-run check and redirect hops apply every new rule', async () => {
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['.app.example'],
      excludeHosts: ['admin.app.example'],
      excludePaths: [{ prefix: '/logout' }],
      allowedSchemes: ['https'],
    });
    expect(scope.check({ url: 'https://admin.app.example/' })).toEqual({
      allowed: false,
      scope: 'SCOPE_HOST_DENIED',
    });
    expect(scope.check({ url: 'https://www.app.example/logout' })).toEqual({
      allowed: false,
      scope: 'SCOPE_PATH_DENIED',
    });
    expect(scope.check({ url: 'http://www.app.example/' })).toEqual({
      allowed: false,
      scope: 'SCOPE_HOST_DENIED',
    });
    await expect(
      scope.checkRedirectChain([
        { url: 'https://www.app.example/' },
        { url: 'https://admin.app.example/' },
      ])
    ).rejects.toMatchObject(denied('SCOPE_HOST_DENIED'));
  });

  it('reports the new fields and program metadata in status (and so in the ledger snapshot)', () => {
    const program = {
      id: 'acme-vdp',
      version: '2026-10-01',
      authorizedBy: 'researcher@example.test',
      authorizedAt: '2026-10-17T00:00:00Z',
    };
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['.app.example'],
      excludeHosts: ['admin.app.example'],
      excludePaths: [{ prefix: '/logout' }],
      allowedSchemes: ['HTTPS'],
      allowedPorts: [443],
      program,
    });
    expect(scope.status()).toMatchObject({
      excludeHosts: ['admin.app.example'],
      excludePaths: [{ prefix: '/logout' }],
      allowedSchemes: ['https'],
      allowedPorts: [443],
      program,
    });
  });

  it('omits the new fields from status when unset (unchanged shape for existing scopes)', () => {
    const status = new EngagementScopePolicy(base(), { allowedHosts: ['app.example'] }).status();
    for (const key of [
      'excludeHosts',
      'excludePaths',
      'allowedSchemes',
      'allowedPorts',
      'program',
    ]) {
      expect(status).not.toHaveProperty(key);
    }
  });
});
