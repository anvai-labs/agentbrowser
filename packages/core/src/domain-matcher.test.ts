import { describe, expect, it } from 'vitest';
import {
  cookieDomain,
  cookieKey,
  covers,
  registrableParents,
  usableHost,
} from './domain-matcher.js';

/** TD-BROWSER-16 phase 3 (ADR-025 §3): the cookie-domain relation, per the TD's table. */

describe('covers', () => {
  it('github.com matches .github.com and host-only gist.github.com', () => {
    expect(covers('github.com', 'github.com').ok).toBe(true);
    expect(covers('.github.com', 'gist.github.com').ok).toBe(true);
    expect(covers('github.com', 'gist.github.com').ok).toBe(true);
  });
  it('gist.github.com does not match .github.com (child never covers the parent)', () => {
    expect(covers('gist.github.com', 'github.com').ok).toBe(false);
    expect(covers('gist.github.com', 'other.github.com').ok).toBe(false);
  });
  it('github.io, vercel.app, co.uk and com are refused (public suffixes)', () => {
    for (const suffix of ['github.io', 'vercel.app', 'co.uk', 'com']) {
      expect(covers(suffix, `x.${suffix}`).ok).toBe(false);
      expect(covers(`.${suffix}`, `x.${suffix}`).ok).toBe(false);
    }
  });
  it('notgithub.com does not match (no shared-label surprises)', () => {
    expect(covers('notgithub.com', 'github.com').ok).toBe(false);
    expect(covers('github.com', 'notgithub.com').ok).toBe(false);
  });
});

describe('usableHost and cookieDomain', () => {
  it('IPs and public-suffix hosts are refused', () => {
    expect(usableHost('10.1.2.3').ok).toBe(false);
    expect(usableHost('[::1]').ok).toBe(false);
    expect(usableHost('github.io').ok).toBe(false);
    expect(usableHost('com').ok).toBe(false);
    expect(usableHost('localhost').ok).toBe(false);
    expect(cookieDomain('10.1.2.3')).toBeNull();
    expect(cookieDomain('github.io')).toBeNull();
  });
  it('host-only binding is the host itself; a registrable parent may be requested', () => {
    expect(cookieDomain('gist.github.com')).toBe('gist.github.com');
    expect(cookieDomain('gist.github.com', 'github.com')).toBe('github.com');
    // A non-parent request, or a suffix parent, refuses.
    expect(cookieDomain('gist.github.com', 'other.com')).toBeNull();
    expect(cookieDomain('x.github.io', 'github.io')).toBeNull();
  });
  it('suffix-only hosts under a private suffix are real hosts', () => {
    expect(cookieDomain('x.blogspot.com')).toBe('x.blogspot.com');
    expect(cookieDomain('x.blogspot.com', 'blogspot.com')).toBeNull(); // suffix, not registrable
  });
});

describe('the dedup fix', () => {
  it('host-only and .domain cookies with the same name and path are distinct', () => {
    const hostOnly = cookieKey({ name: 'sid', domain: 'github.com', path: '/' });
    const domain = cookieKey({ name: 'sid', domain: '.github.com', path: '/' });
    expect(hostOnly).not.toBe(domain);
    // Same form, same key; a different path differs.
    expect(cookieKey({ name: 'sid', domain: '.github.com', path: '/' })).toBe(domain);
    expect(cookieKey({ name: 'sid', domain: '.github.com', path: '/app' })).not.toBe(domain);
  });
});

describe('registrableParents', () => {
  it('lists registrable parents only (subdomains are not registrable), never suffixes', () => {
    expect(registrableParents('a.b.example.com')).toEqual(['example.com']);
    expect(registrableParents('x.github.io')).toEqual([]); // its only parent, github.io, is a suffix
    expect(registrableParents('gist.github.com')).toEqual(['github.com']);
  });
});

describe('review of phase 3: covers invariants', () => {
  it('a suffix entry matches subdomains only, and never covers the apex', () => {
    expect(covers('.example.com', 'example.com').ok).toBe(false);
    expect(covers('.example.com', 'a.example.com').ok).toBe(true);
    // And the plain apex form still covers the apex (list it alongside).
    expect(covers('example.com', 'example.com').ok).toBe(true);
  });
  it('suffixes, IPs and localhost never cover anything, not even themselves', () => {
    for (const bad of ['github.io', '.github.io', 'com', '10.1.2.3', '[::1]', 'localhost', '']) {
      const verdict = covers(bad, bad);
      if (bad === '') {
        expect(verdict.ok).toBe(false);
        continue;
      }
      expect({ bad, ok: verdict.ok }).toEqual({ bad, ok: false });
    }
  });
  it('a deep usable host covers its subtree (ADR section 3 hosts under a registrable domain)', () => {
    expect(covers('a.b.example.com', 'c.a.b.example.com').ok).toBe(true);
    expect(covers('a.b.example.com', 'x.b.example.com').ok).toBe(false);
    expect(covers('a.b.github.io', 'c.a.b.github.io').ok).toBe(true);
  });
  it('ports and trailing dots are refused, and do not fork the identity', () => {
    expect(usableHost('example.com:443').ok).toBe(false);
    expect(usableHost('example.com.').ok).toBe(false);
    expect(usableHost('example.com..').ok).toBe(false);
    expect(cookieDomain('example.com:443')).toBeNull();
    expect(cookieDomain('example.com.')).toBeNull();
  });
  it('requesting the host itself works for deep hosts too', () => {
    expect(cookieDomain('a.b.example.com', 'a.b.example.com')).toBe('a.b.example.com');
    expect(cookieDomain('gist.github.com', 'github.com')).toBe('github.com');
    // A host under a registrable domain is a valid request too (ADR section 3).
    expect(cookieDomain('a.b.example.com', 'b.example.com')).toBe('b.example.com');
  });
});
