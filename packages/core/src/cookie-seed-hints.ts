import type { CookieSeedClass } from '@agentbrowser/protocol';

type SeedHintCookie = { name?: unknown; domain?: unknown; value?: unknown; expires?: unknown };
const FINGERPRINT_NAMES = new Set(['cf_clearance', 'datadome']);
const PROVIDER_NAMES = new Set([
  'SID',
  'HSID',
  'SSID',
  'APISID',
  'SAPISID',
  '__Secure-1PSID',
  '__Secure-3PSID',
]);
function providerSessionCookie(cookie: SeedHintCookie): boolean {
  if (typeof cookie.name !== 'string' || typeof cookie.domain !== 'string') return false;
  const domain = cookie.domain.toLowerCase().replace(/^\./, '').replace(/\.+$/, '');
  return (
    (domain === 'google.com' || domain.endsWith('.google.com')) && PROVIDER_NAMES.has(cookie.name)
  );
}

/** Derived from actual cookie rows; caller-supplied metadata cannot assert portability. */
export function cookieSeedClasses(cookies: readonly SeedHintCookie[]): CookieSeedClass[] {
  const classes = new Set<CookieSeedClass>();
  for (const cookie of cookies) {
    classes.add(
      typeof cookie.expires === 'number' && cookie.expires > 0 ? 'persistent' : 'session'
    );
    if (typeof cookie.name === 'string' && FINGERPRINT_NAMES.has(cookie.name.toLowerCase()))
      classes.add('fingerprint-bound');
    if (providerSessionCookie(cookie)) classes.add('provider-session');
  }
  return [...classes].sort();
}

/** Only fixed known names are reported. Values and arbitrary cookie names are never read. */
export function cookieSeedWarnings(cookies?: readonly SeedHintCookie[]): string[] {
  const fingerprint = new Set<string>();
  let providerSession = false;
  for (const cookie of cookies ?? []) {
    if (typeof cookie.name !== 'string') continue;
    const name = cookie.name.toLowerCase();
    if (FINGERPRINT_NAMES.has(name)) fingerprint.add(name);
    if (providerSessionCookie(cookie)) providerSession = true;
  }
  return [
    ...(fingerprint.size
      ? [
          `Seed contains fingerprint-bound cookies (${[...fingerprint].sort().join(', ')}); these may not transfer to another browser context. Extract immediately before use and verify authentication; cookie presence is not a challenge bypass.`,
        ]
      : []),
    ...(providerSession
      ? [
          'Seed contains Google session cookies that may rotate or be invalidated independently. Extract immediately before use and verify authentication; the seed does not establish a fixed session lifetime.',
        ]
      : []),
  ];
}
