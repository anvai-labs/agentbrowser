import { describe, expect, it, vi } from 'vitest';
import {
  createRequestOriginGuard,
  requestOriginGuardFromEnvironment,
} from './request-origin-guard.js';

const loopback = createRequestOriginGuard({ bindHost: '127.0.0.1' });

describe('request origin guard: Host allowlist (DNS rebinding)', () => {
  it('accepts loopback Host names on a loopback bind', () => {
    for (const host of [
      '127.0.0.1:5709',
      'localhost:5709',
      'LOCALHOST',
      '[::1]:5709',
      '127.0.0.2',
    ]) {
      expect(loopback.check({ host })).toEqual({ allowed: true });
    }
  });

  it('refuses a rebound attacker hostname on a loopback bind', () => {
    const verdict = loopback.check({ host: 'attacker.example:5709' });
    expect(verdict.allowed).toBe(false);
  });

  it('refuses a missing Host header while the Host check is active', () => {
    expect(loopback.check({}).allowed).toBe(false);
  });

  it('does not check Host on a keyed wide bind without an allowlist (the key is the barrier)', () => {
    const keyed = createRequestOriginGuard({ bindHost: '0.0.0.0', authenticated: true });
    expect(keyed.check({ host: 'agentbrowser.internal:5709' })).toEqual({ allowed: true });
  });

  it('warns at startup when a wide bind runs without API keys', () => {
    const warn = vi.fn();
    createRequestOriginGuard({ bindHost: '0.0.0.0' }, warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('AGENTBROWSER_ALLOWED_HOSTS'));
    const quiet = vi.fn();
    createRequestOriginGuard({ bindHost: '0.0.0.0', authenticated: true }, quiet);
    createRequestOriginGuard({ bindHost: '127.0.0.1' }, quiet);
    expect(quiet).not.toHaveBeenCalled();
  });

  it('checks Host on every bind when no API keys are configured (review F1)', () => {
    // A rebound page over plain HTTP sends neither Origin (GET) nor fetch
    // metadata (not a trustworthy origin), exactly like a non-browser client:
    // only the Host name tells them apart.
    const open = createRequestOriginGuard({ bindHost: '0.0.0.0' });
    expect(open.check({ host: 'attacker.example:5709' }).allowed).toBe(false);
    expect(open.check({ host: 'localhost:5709' })).toEqual({ allowed: true });
    expect(open.check({ host: '127.0.0.1:5709' })).toEqual({ allowed: true });
  });

  it('applies operator-allowed hostnames on any bind', () => {
    const exposed = createRequestOriginGuard({
      bindHost: '0.0.0.0',
      allowedHosts: ['agentbrowser.internal'],
    });
    expect(exposed.check({ host: 'agentbrowser.internal:5709' })).toEqual({ allowed: true });
    expect(exposed.check({ host: 'localhost:5709' })).toEqual({ allowed: true });
    expect(exposed.check({ host: 'other.internal' }).allowed).toBe(false);
  });
});

describe('request origin guard: browser origins (drive-by requests)', () => {
  it('accepts non-browser clients that send no Origin', () => {
    expect(loopback.check({ host: '127.0.0.1:5709' })).toEqual({ allowed: true });
  });

  it('refuses a cross-origin browser request', () => {
    const verdict = loopback.check({ host: '127.0.0.1:5709', origin: 'https://evil.example' });
    expect(verdict.allowed).toBe(false);
  });

  it('refuses another local port (a dev server page is not this service)', () => {
    const verdict = loopback.check({ host: 'localhost:5709', origin: 'http://localhost:3000' });
    expect(verdict.allowed).toBe(false);
  });

  it('refuses the opaque "null" origin', () => {
    expect(loopback.check({ host: '127.0.0.1:5709', origin: 'null' }).allowed).toBe(false);
  });

  it('accepts same-origin requests from the operator console', () => {
    expect(
      loopback.check({
        host: '127.0.0.1:5709',
        origin: 'http://127.0.0.1:5709',
        'sec-fetch-site': 'same-origin',
      })
    ).toEqual({ allowed: true });
  });

  it('never trusts same-origin on an unchecked hostname (rebinding on a wide bind)', () => {
    const exposed = createRequestOriginGuard({ bindHost: '0.0.0.0' });
    const verdict = exposed.check({
      host: 'rebind.example:5709',
      origin: 'http://rebind.example:5709',
    });
    expect(verdict.allowed).toBe(false);
  });

  it('refuses cross-site and same-site fetch metadata without an Origin header', () => {
    for (const site of ['cross-site', 'same-site']) {
      expect(loopback.check({ host: '127.0.0.1:5709', 'sec-fetch-site': site }).allowed).toBe(
        false
      );
    }
    expect(loopback.check({ host: '127.0.0.1:5709', 'sec-fetch-site': 'none' })).toEqual({
      allowed: true,
    });
  });

  it('refuses same-origin fetch metadata on an unlisted name even when keyed', () => {
    const keyed = createRequestOriginGuard({ bindHost: '0.0.0.0', authenticated: true });
    const verdict = keyed.check({ host: 'attacker.example:5709', 'sec-fetch-site': 'same-origin' });
    expect(verdict.allowed).toBe(false);
  });

  it('accepts same-origin fetch metadata on a trusted name over a wide bind', () => {
    const exposed = createRequestOriginGuard({ bindHost: '0.0.0.0' });
    expect(exposed.check({ host: 'localhost:5709', 'sec-fetch-site': 'same-origin' })).toEqual({
      allowed: true,
    });
    const named = createRequestOriginGuard({
      bindHost: '0.0.0.0',
      allowedHosts: ['agentbrowser.internal'],
    });
    expect(
      named.check({ host: 'agentbrowser.internal:5709', 'sec-fetch-site': 'same-origin' })
    ).toEqual({ allowed: true });
  });

  it('keeps non-browser clients and typed navigations working on a wide bind', () => {
    const keyed = createRequestOriginGuard({ bindHost: '0.0.0.0', authenticated: true });
    expect(keyed.check({ host: 'agentbrowser:5709' })).toEqual({ allowed: true });
    expect(keyed.check({ host: 'agentbrowser:5709', 'sec-fetch-site': 'none' })).toEqual({
      allowed: true,
    });
    const named = createRequestOriginGuard({
      bindHost: '0.0.0.0',
      allowedHosts: ['agentbrowser'],
    });
    expect(named.check({ host: 'agentbrowser:5709' })).toEqual({ allowed: true });
  });

  it('refuses malformed, mis-cased or duplicated fetch metadata without an allowed Origin', () => {
    for (const site of ['Cross-Site', 'same-origin, cross-site', 'bogus']) {
      expect(loopback.check({ host: '127.0.0.1:5709', 'sec-fetch-site': site }).allowed).toBe(
        false
      );
    }
    expect(loopback.check({ host: '127.0.0.1:5709', 'sec-fetch-site': 'Same-Origin' })).toEqual({
      allowed: true,
    });
  });

  it('accepts operator-allowed origins, including cross-site fetch metadata', () => {
    const guard = createRequestOriginGuard({
      bindHost: '127.0.0.1',
      allowedOrigins: ['https://console.example'],
    });
    expect(
      guard.check({
        host: '127.0.0.1:5709',
        origin: 'https://console.example',
        'sec-fetch-site': 'cross-site',
      })
    ).toEqual({ allowed: true });
    expect(guard.corsOrigin).toEqual(['https://console.example']);
  });

  it('disables CORS entirely when no origin is allowed', () => {
    expect(loopback.corsOrigin).toBe(false);
  });
});

describe('request origin guard: configuration', () => {
  it('rejects malformed origins and hostnames at startup', () => {
    expect(() =>
      createRequestOriginGuard({ bindHost: '127.0.0.1', allowedOrigins: ['console.example'] })
    ).toThrow(/origin/i);
    expect(() =>
      createRequestOriginGuard({
        bindHost: '127.0.0.1',
        allowedOrigins: ['https://console.example/path'],
      })
    ).toThrow(/origin/i);
    expect(() =>
      createRequestOriginGuard({ bindHost: '127.0.0.1', allowedHosts: ['host:5709'] })
    ).toThrow(/host/i);
  });

  it("treats '*' as an explicit, loudly warned opt-out of origin checks", () => {
    const warn = vi.fn();
    const guard = createRequestOriginGuard({ bindHost: '127.0.0.1', allowedOrigins: ['*'] }, warn);
    expect(guard.check({ host: '127.0.0.1:5709', origin: 'https://any.example' })).toEqual({
      allowed: true,
    });
    expect(guard.check({ host: 'attacker.example' }).allowed).toBe(false);
    expect(guard.corsOrigin).toBe('*');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('AGENTBROWSER_CORS_ORIGINS'));
  });

  it('reads comma-separated origins and hosts from the environment', () => {
    const guard = requestOriginGuardFromEnvironment(
      {
        AGENTBROWSER_CORS_ORIGINS: 'https://a.example, https://b.example',
        AGENTBROWSER_ALLOWED_HOSTS: 'agentbrowser.internal',
      },
      '0.0.0.0'
    );
    expect(guard.corsOrigin).toEqual(['https://a.example', 'https://b.example']);
    expect(guard.check({ host: 'agentbrowser.internal' })).toEqual({ allowed: true });
  });

  it('merges programmatic corsOrigin with the environment list', () => {
    const guard = requestOriginGuardFromEnvironment(
      { AGENTBROWSER_CORS_ORIGINS: 'https://a.example' },
      '127.0.0.1',
      'https://b.example'
    );
    expect(guard.corsOrigin).toEqual(['https://a.example', 'https://b.example']);
  });

  it('rejects empty list entries rather than silently discarding them', () => {
    expect(() =>
      requestOriginGuardFromEnvironment(
        { AGENTBROWSER_CORS_ORIGINS: 'https://a.example,,' },
        '127.0.0.1'
      )
    ).toThrow(/empty/i);
  });
});
