// Scope rules as configured must bind exactly as written: a rule that silently binds nothing
// either widens the scope (allow side) or drops a restriction.
import { describe, expect, it } from 'vitest';
import { NetworkPolicy } from './network-policy.js';
import { EngagementScopePolicy } from './scope-policy.js';

const base = () => new NetworkPolicy({ blockLoopback: false });
const req = (url: string) => ({ hostname: new URL(url).hostname, url, method: 'GET' });

describe('scope rule normalization', () => {
  it('a path rule bound with an uppercase hostSuffix still binds its host (no widening)', async () => {
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['app.example'],
      pathRules: [{ prefix: '/public', hostSuffix: 'APP.example' }],
    });
    await scope.checkRequest(req('https://app.example/public/x'));
    await expect(scope.checkRequest(req('https://app.example/secret'))).rejects.toMatchObject({
      details: { scope: 'SCOPE_PATH_DENIED' },
    });
  });

  it('configured hosts with a trailing dot match the normalized request host', async () => {
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['app.example.'],
      identityBindings: [{ header: 'x-id', value: 'v', allowedHosts: ['APP.example.'] }],
    });
    await scope.checkRequest(req('https://app.example/'));
    await scope.checkRequest({ ...req('https://app.example/'), headers: { 'x-id': 'v' } });
  });

  it('reports the normalized rules in status', () => {
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['APP.example.'],
      pathRules: [{ prefix: '/public', hostSuffix: 'APP.example.' }],
    });
    expect(scope.status()).toMatchObject({
      allowedHosts: ['app.example'],
      pathRules: [{ prefix: '/public', hostSuffix: 'app.example' }],
    });
  });
});
