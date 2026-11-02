import { expect, it } from 'vitest';
import { parseCookieSeedFile } from './cookie-seed.js';

const file = {
  format: 'agentbrowser-cookie-seed/v1',
  cookies: [{ name: 'sid', value: 'PRIVATE-COOKIE', domain: 'example.com', path: '/' }],
  provenance: {
    source: 'operator-cdp',
    sourceContext: 'incognito',
    extractedAt: '2026-11-01T12:00:00.000Z',
    domainFilters: ['example.com'],
    cookieClasses: ['session'],
  },
};
it('detaches bounded canonical seed metadata and cookie rows', () => {
  const parsed = parseCookieSeedFile(file);
  expect(parsed).toEqual(file);
  parsed.cookies[0]!.value = 'changed';
  parsed.provenance.domainFilters.push('other.com');
  expect(file.cookies[0]!.value).toBe('PRIVATE-COOKIE');
  expect(file.provenance.domainFilters).toEqual(['example.com']);
});
it.each([
  { ...file, unknownConstraint: true },
  { ...file, provenance: { ...file.provenance, unknown: 'PRIVATE-METADATA' } },
  { ...file, provenance: { ...file.provenance, sourceContext: 'any-profile' } },
  { ...file, provenance: { ...file.provenance, extractedAt: '2026-02-30T12:00:00Z' } },
  { ...file, provenance: { ...file.provenance, cookieClasses: ['session', 'session'] } },
  { ...file, provenance: { ...file.provenance, domainFilters: ['https://example.com/'] } },
  { ...file, cookies: [{ ...file.cookies[0], partitionKey: 'https://example.com' }] },
  { ...file, cookies: Array.from({ length: 1001 }, () => file.cookies[0]) },
  { ...file, cookies: [{ ...file.cookies[0], value: 'PRIVATE-COOKIE'.repeat(100000) }] },
])(
  'refuses invalid, ambiguous or oversized file metadata without reflecting values %#',
  (input) => {
    expect(() => parseCookieSeedFile(input)).toThrow('Invalid bounded cookie seed file');
    try {
      parseCookieSeedFile(input);
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE');
    }
  }
);
