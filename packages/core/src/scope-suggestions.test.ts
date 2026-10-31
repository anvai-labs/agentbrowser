import type { EngagementScope } from '@agentbrowser/protocol';
import { expect, it } from 'vitest';
import {
  type DenialRecord,
  suggestScopeHosts,
  suggestScopeMethods,
  summarizeDeniedHosts,
} from './scope-assets.js';
import { loadTldts } from './tldts-lazy.js';

/** The pre-fix Wolt shape: explicit program subdomains, no bare registry. */
const scope = {
  allowedHosts: [
    'www.wolt.com',
    'restaurant-api.wolt.com',
    'authentication.wolt.com',
    'js.hcaptcha.com',
  ],
  allowedMethods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
} as const as EngagementScope;

const failed = (url: string, resourceType: string, n: number, data = {}): DenialRecord[] =>
  Array.from({ length: n }, () => ({
    type: 'request.failed',
    data: { scope: 'SCOPE_HOST_DENIED', url, resourceType, method: 'GET', ...data },
  }));

const records: DenialRecord[] = [
  ...failed('https://consumer-api.wolt.com/v1/user', 'xhr', 21),
  ...failed('https://consumer-api.wolt.com/v1/pages', 'fetch', 16),
  ...failed('https://gatekeeper.wolt.com/token', 'xhr', 12),
  ...failed('https://cdn.cookieyes.com/legal/x.js', 'script', 8),
  ...failed('https://cdn.jsdelivr.net/npm/x.js', 'stylesheet', 5),
  ...failed('https://telemetry.example.net/collect', 'xhr', 3),
  ...failed('https://o1.ingest.sentry.io/api/1/envelope', 'fetch', 4),
  ...failed('https://www.wolt.com/v1/verify', 'document', 7, {
    scope: 'SCOPE_METHOD_DENIED',
    method: 'PUT',
  }),
];

it('suggests same-registry API hosts as program-host candidates, never auto-widening', async () => {
  await loadTldts();
  const suggestions = suggestScopeHosts(scope, summarizeDeniedHosts(records));
  const byHost = new Map(suggestions.hosts.map((row) => [row.hostname, row]));
  // The two hosts the original Wolt scope missed.
  expect(byHost.get('consumer-api.wolt.com')?.suggestion).toBe('program-host');
  expect(byHost.get('consumer-api.wolt.com')?.count).toBe(37);
  expect(byHost.get('consumer-api.wolt.com')?.registrableDomain).toBe('wolt.com');
  expect(byHost.get('gatekeeper.wolt.com')?.suggestion).toBe('program-host');
  // Cross-registry static and consent vendors route to the asset path.
  expect(byHost.get('cdn.cookieyes.com')?.suggestion).toBe('asset-host');
  expect(byHost.get('cdn.jsdelivr.net')?.suggestion).toBe('asset-host');
  // Cross-registry non-static traffic is surfaced without a suggestion.
  expect(byHost.get('telemetry.example.net')?.suggestion).toBe('unrecognized');
  // A vendor reached with non-static traffic cannot ride the asset class
  // (GET/HEAD static only); it is surfaced with an explicit note instead.
  expect(byHost.get('o1.ingest.sentry.io')?.suggestion).toBe('unrecognized');
  // Counts keep the summary order: the API host dominates.
  expect(suggestions.hosts[0]?.hostname).toBe('consumer-api.wolt.com');
  expect(suggestions.truncated).toBe(false);
});

it('never suggests allowed, adopted or deliberately excluded hosts', async () => {
  await loadTldts();
  const widened = {
    ...scope,
    allowedHosts: ['wolt.com', ...scope.allowedHosts],
    assetHosts: [{ host: 'cdn.cookieyes.com', class: 'asset' as const }],
    excludeHosts: ['.internal.wolt.com'],
  } as const as EngagementScope;
  const local = [
    ...failed('https://consumer-api.wolt.com/v1/user', 'xhr', 4),
    ...failed('https://cdn.cookieyes.com/legal/x.js', 'script', 4),
    ...failed('https://db.internal.wolt.com/metrics', 'xhr', 4),
  ];
  const suggestions = suggestScopeHosts(widened, summarizeDeniedHosts(local));
  expect(suggestions.hosts.map((row) => row.hostname)).toEqual([]);
});

it('suggests denied methods observed on in-scope hosts', () => {
  expect(suggestScopeMethods(scope, records)).toEqual([{ method: 'PUT', count: 7 }]);
  // Already-allowed methods are not resuggested; other denials still are.
  const allowed = [
    ...records,
    ...failed('https://www.wolt.com/x', 'document', 2, {
      scope: 'SCOPE_METHOD_DENIED',
      method: 'POST',
    }),
  ];
  expect(suggestScopeMethods({ ...scope, allowedMethods: ['PUT'] }, allowed)).toEqual([
    { method: 'POST', count: 2 },
  ]);
});
