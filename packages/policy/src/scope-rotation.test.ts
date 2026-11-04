// P1-6a (ADR-033): the rotation advisory state machine and its policy wiring.
// Advisory only — the signature (refresh navigation, then 401/403 on identity,
// same page, bounded window) fires exactly once and never gates traffic.
import { expect, it, vi } from 'vitest';
import { EngagementScopePolicy } from './scope-policy.js';
import { compileUrlPattern, RotationAdvisor } from './scope-rotation.js';

const REFRESH = 'https://sso.test/auth/refresh';
const IDENTITY = 'https://app.test/api/me';

type Outcome = Parameters<RotationAdvisor['noteOutcome']>;

const advisor = () =>
  new RotationAdvisor({
    refreshUrlPattern: 'https://sso.test/auth/refresh',
    identityUrlPattern: 'https://app.test/api/*',
  });

/** A finished document navigation on a page. */
const navigation = (url: string, pageKey = 1): Outcome => [
  'request.finished',
  { url, pageKey, resourceType: 'document' },
];
/** A finished subresource response on a page. */
const response = (url: string, status: number, pageKey = 1, resourceType = 'fetch'): Outcome => [
  'request.finished',
  { url, status, pageKey, resourceType },
];
/** A same-page filler outcome that matches neither pattern. */
const filler = (): Outcome => [
  'request.finished',
  { url: 'https://app.test/static', pageKey: 1, resourceType: 'script', status: 200 },
];

it('compiles the shared URL-pattern convention: globs, ** and /regex/flags', () => {
  expect(compileUrlPattern('https://a.test/*/x').test('https://a.test/1/x')).toBe(true);
  expect(compileUrlPattern('https://a.test/*/x').test('https://a.test/1/2/x')).toBe(false);
  expect(compileUrlPattern('https://a.test/**').test('https://a.test/1/2')).toBe(true);
  expect(compileUrlPattern('/api\\/me$/i').test('https://a.test/API/me')).toBe(true);
  expect(compileUrlPattern('/unterminated/')).toBeInstanceOf(RegExp);
  expect(() => compileUrlPattern('/(/')).toThrow();
});

it('fires once when a refresh navigation is followed by 401/403 on identity', () => {
  const rotation = advisor();
  expect(rotation.noteOutcome(...navigation(REFRESH))).toBeUndefined();
  // 19 intervening same-page outcomes stay inside the 20-request window.
  for (let i = 0; i < 19; i += 1) expect(rotation.noteOutcome(...filler())).toBeUndefined();
  expect(rotation.noteOutcome(...response(IDENTITY, 401))).toMatchObject({
    event: 'auth.rotation-suspected',
    refresh: REFRESH,
    identity: IDENTITY,
    status: 401,
  });
  expect(rotation.suspected()).toBe(true);
  // Exactly once: a later complete signature never fires again.
  rotation.noteOutcome(...navigation(REFRESH));
  expect(rotation.noteOutcome(...response(IDENTITY, 403))).toBeUndefined();
});

it('fires on 403 as well as 401, including a document identity response', () => {
  const rotation = advisor();
  rotation.noteOutcome(...navigation(REFRESH, 7));
  expect(rotation.noteOutcome(...response(IDENTITY, 403, 7, 'document'))).toMatchObject({
    status: 403,
  });
});

it('does not fire outside the window, across pages, or on the wrong signature', () => {
  // Window exhausted: the identity 401 after 20 same-page outcomes is late.
  const exhausted = advisor();
  exhausted.noteOutcome(...navigation(REFRESH));
  for (let i = 0; i < 20; i += 1) exhausted.noteOutcome(...filler());
  expect(exhausted.noteOutcome(...response(IDENTITY, 401))).toBeUndefined();

  // Different page: an identity 401 on another page never fires.
  const crossPage = advisor();
  crossPage.noteOutcome(...navigation(REFRESH, 1));
  expect(crossPage.noteOutcome(...response(IDENTITY, 401, 2))).toBeUndefined();

  // Statuses that are not auth rejections, or a failed (never observed)
  // request, never complete the signature.
  for (const wrong of [
    response(IDENTITY, 200),
    response(IDENTITY, 500),
    ['request.failed', { url: IDENTITY, pageKey: 1 }] as Outcome,
  ]) {
    const rotation = advisor();
    rotation.noteOutcome(...navigation(REFRESH));
    expect(rotation.noteOutcome(...wrong)).toBeUndefined();
  }

  // No refresh navigation first: an identity 401 alone is not rotation.
  const unarmed = advisor();
  expect(unarmed.noteOutcome(...response(IDENTITY, 401))).toBeUndefined();
});

it('ignores unattributed records and header injections; a bounce loop re-arms', () => {
  const rotation = advisor();
  // No page key (redirect-walker hops, probes): ignored, never arms.
  expect(rotation.noteOutcome('request.finished', { url: REFRESH })).toBeUndefined();
  expect(
    rotation.noteOutcome('request.headersInjected', { url: REFRESH, pageKey: 1 })
  ).toBeUndefined();
  // The window restarts on a repeated refresh navigation: the identity 401
  // after a second bounce still fires.
  rotation.noteOutcome(...navigation(REFRESH));
  for (let i = 0; i < 20; i += 1)
    rotation.noteOutcome('request.failed', { url: 'https://app.test/x', pageKey: 1 });
  rotation.noteOutcome(...navigation(REFRESH));
  expect(rotation.noteOutcome(...response(IDENTITY, 401))).toMatchObject({
    event: 'auth.rotation-suspected',
  });
});

it('the scope policy surfaces the config and the sticky hint, and refuses bad patterns', () => {
  const base = { checkRequest: vi.fn(async () => {}) };
  const policy = new EngagementScopePolicy(base, {
    allowedHosts: ['app.test', 'sso.test'],
    authRotation: {
      refreshUrlPattern: 'https://sso.test/auth/refresh',
      identityUrlPattern: '/api\\/me$/',
    },
  });
  expect(policy.status().authRotation).toMatchObject({ suspected: false });
  expect(
    policy.noteOutcome('request.finished', { url: REFRESH, pageKey: 3, resourceType: 'document' })
  ).toBeUndefined();
  expect(
    policy.noteOutcome('request.finished', { url: IDENTITY, pageKey: 3, status: 401 })
  ).toMatchObject({ event: 'auth.rotation-suspected', status: 401 });
  expect(policy.status().authRotation).toMatchObject({ suspected: true });

  // Without the field there is no detection at all (no guessing).
  const plain = new EngagementScopePolicy(base, { allowedHosts: ['app.test'] });
  expect(plain.status().authRotation).toBeUndefined();
  expect(
    plain.noteOutcome('request.finished', { url: IDENTITY, pageKey: 1, status: 401 })
  ).toBeUndefined();

  // A pattern that cannot compile is refused at construction, never a
  // silently-never-matching detection config.
  expect(
    () =>
      new EngagementScopePolicy(base, {
        allowedHosts: ['app.test'],
        authRotation: { refreshUrlPattern: '/(/', identityUrlPattern: '/ok/' },
      })
  ).toThrow(/authRotation/);
});

// A completed reseed answers the advisory: the hint clears and detection
// re-arms for the new credentials (ADR-033).
it('noteReseeded clears the sticky hint and re-arms detection', () => {
  const policy = new EngagementScopePolicy(
    { checkRequest: vi.fn(async () => {}) },
    {
      allowedHosts: ['app.test'],
      authRotation: {
        refreshUrlPattern: 'https://sso.test/auth/refresh',
        identityUrlPattern: 'https://app.test/api/*',
      },
    }
  );
  policy.noteOutcome('request.finished', { url: REFRESH, pageKey: 1, resourceType: 'document' });
  expect(
    policy.noteOutcome('request.finished', { url: IDENTITY, pageKey: 1, status: 401 })
  ).toMatchObject({ event: 'auth.rotation-suspected' });
  expect(policy.status().authRotation).toMatchObject({ suspected: true });
  policy.noteReseeded();
  expect(policy.status().authRotation).toMatchObject({ suspected: false });
  // Re-armed: a fresh signature fires again.
  policy.noteOutcome('request.finished', { url: REFRESH, pageKey: 2, resourceType: 'document' });
  expect(
    policy.noteOutcome('request.finished', { url: IDENTITY, pageKey: 2, status: 403 })
  ).toMatchObject({ event: 'auth.rotation-suspected', status: 403 });
});

// Without the field there is no detection at all (no guessing).
