import { expect, it } from 'vitest';
import { cookieSeedClasses, cookieSeedWarnings } from './cookie-seed-hints.js';

it('warns about fingerprint-bound seeds without values or arbitrary cookie names', () => {
  const warnings = cookieSeedWarnings([
    { name: 'cf_clearance', value: 'SECRET-CLEARANCE' },
    { name: 'datadome', value: 'SECRET-DATADOME' },
    { name: 'private-user-cookie-name', value: 'SECRET-SESSION' },
  ]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('fingerprint-bound');
  expect(warnings[0]).toContain('cf_clearance');
  expect(warnings[0]).toContain('datadome');
  expect(warnings.join(' ')).not.toMatch(/SECRET|private-user-cookie-name/);
});

it('does not promise transferability or a lifetime for provider session cookies', () => {
  const warnings = cookieSeedWarnings([{ name: 'SID', domain: '.google.com', value: 'SECRET' }]);
  expect(warnings.join(' ')).toContain('rotate');
  expect(warnings.join(' ')).not.toContain('SECRET');
  expect(cookieSeedWarnings([{ name: 'SID', domain: 'google.com.attacker.org' }])).toEqual([]);
  expect(cookieSeedWarnings([{ name: 'ordinary', domain: '.google.com' }])).toEqual([]);
  expect(cookieSeedWarnings(undefined)).toEqual([]);
});

it('derives classes from actual rows without relying on a caller portability claim', () => {
  expect(
    cookieSeedClasses([
      { name: 'cf_clearance' },
      { name: 'SID', domain: '.google.com', expires: 2000000000 },
    ])
  ).toEqual(['fingerprint-bound', 'persistent', 'provider-session', 'session']);
  expect(cookieSeedClasses([])).toEqual([]);
});

it('does not read credential values while producing warnings or classes', () => {
  const cookie = {
    name: 'cf_clearance',
    get value(): string {
      throw new Error('credential value was read');
    },
  };
  expect(cookieSeedWarnings([cookie]).join(' ')).toContain('fingerprint-bound');
  expect(cookieSeedClasses([cookie])).toEqual(['fingerprint-bound', 'session']);
});
