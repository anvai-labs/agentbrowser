/**
 * Network Policy Tests
 *
 * Following TDD principles, these tests define the expected security behavior
 * for network egress policy enforcement with SSRF defense.
 */

import { describe, expect, it } from 'vitest';
import { NetworkPolicy, NetworkPolicyError, SessionHostPolicy } from './network-policy';

describe('Network Policy', () => {
  describe('loopback protection', () => {
    it('should block localhost hostname', async () => {
      const policy = new NetworkPolicy({ blockLoopback: true });

      try {
        await policy.checkRequest({ hostname: 'localhost' });
        fail('Should have thrown NetworkPolicyError');
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkPolicyError);
        expect((error as NetworkPolicyError).code).toBe('POLICY_DENIED');
        expect((error as NetworkPolicyError).details?.rule).toBe('blockLoopback');
      }
    });

    it('should block 127.0.0.1', async () => {
      const policy = new NetworkPolicy({ blockLoopback: true });

      try {
        await policy.checkRequest({ hostname: '127.0.0.1' });
        fail('Should have thrown NetworkPolicyError');
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkPolicyError);
        expect((error as NetworkPolicyError).code).toBe('POLICY_DENIED');
      }
    });

    it('should block 127.0.0.2', async () => {
      const policy = new NetworkPolicy({ blockLoopback: true });

      try {
        await policy.checkRequest({ hostname: '127.0.0.2' });
        fail('Should have thrown NetworkPolicyError');
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkPolicyError);
        expect((error as NetworkPolicyError).code).toBe('POLICY_DENIED');
      }
    });

    it('should block 0.0.0.0', async () => {
      const policy = new NetworkPolicy({ blockLoopback: true });

      try {
        await policy.checkRequest({ hostname: '0.0.0.0' });
        fail('Should have thrown NetworkPolicyError');
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkPolicyError);
        expect((error as NetworkPolicyError).code).toBe('POLICY_DENIED');
      }
    });

    it('should allow external hostnames when loopback blocking enabled', async () => {
      const policy = new NetworkPolicy({ blockLoopback: true });

      await expect(policy.checkRequest({ hostname: 'example.com' })).resolves.toBeUndefined();
    });

    it('should allow loopback when disabled', async () => {
      const policy = new NetworkPolicy({ blockLoopback: false });

      await expect(policy.checkRequest({ hostname: 'localhost' })).resolves.toBeUndefined();
    });
  });

  describe('private IP protection', () => {
    it('should block 10.0.0.0/8', async () => {
      const policy = new NetworkPolicy({ blockPrivateIPs: true });

      try {
        await policy.checkRequest({ hostname: '10.0.0.1' });
        fail('Should have thrown NetworkPolicyError');
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkPolicyError);
        expect((error as NetworkPolicyError).code).toBe('POLICY_DENIED');
        expect((error as NetworkPolicyError).details?.rule).toBe('blockPrivateIPs');
      }
    });

    // Hygiene C3 (Phase 3): these ranges were previously ALLOWED through
    // blockPrivateIPs - each was a live SSRF bypass.
    it.each(
      [
        ['169.254.170.2', '169.254.0.0/16 link-local (ECS task metadata)'],
        ['169.254.0.1', '169.254.0.0/16 link-local'],
        ['100.64.0.1', '100.64.0.0/10 CGNAT'],
        ['100.127.255.254', '100.64.0.0/10 CGNAT upper bound'],
        ['0.1.2.3', '0.0.0.0/8 "this network" (non-zero)'],
        ['198.18.0.5', '198.18.0.0/15 benchmarking'],
        ['198.19.255.1', '198.18.0.0/15 benchmarking upper bound'],
        ['::1', 'IPv6 loopback'],
        ['[::1]', 'IPv6 loopback (bracketed URL form)'],
        ['fe80::1', 'IPv6 link-local'],
        ['fc00::1', 'IPv6 unique-local'],
        ['fd12:3456:789a::1', 'IPv6 unique-local fd'],
      ].map(([hostname]) => hostname)
    )('should block previously-allowed non-routable address %s', async (hostname: string) => {
      const policy = new NetworkPolicy({ blockPrivateIPs: true });
      await expect(policy.checkRequest({ hostname })).rejects.toThrow(/private/i);
    });

    it('still allows public addresses', async () => {
      const policy = new NetworkPolicy({ blockPrivateIPs: true });
      await expect(policy.checkRequest({ hostname: '93.184.216.34' })).resolves.toBeUndefined();
      await expect(policy.checkRequest({ hostname: 'example.com' })).resolves.toBeUndefined();
    });

    it('should block 172.16.0.0/12', async () => {
      const policy = new NetworkPolicy({ blockPrivateIPs: true });

      try {
        await policy.checkRequest({ hostname: '172.16.0.1' });
        fail('Should have thrown NetworkPolicyError');
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkPolicyError);
        expect((error as NetworkPolicyError).code).toBe('POLICY_DENIED');
      }
    });

    it('should block 192.168.0.0/16', async () => {
      const policy = new NetworkPolicy({ blockPrivateIPs: true });

      try {
        await policy.checkRequest({ hostname: '192.168.1.1' });
        fail('Should have thrown NetworkPolicyError');
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkPolicyError);
        expect((error as NetworkPolicyError).code).toBe('POLICY_DENIED');
      }
    });

    it('should allow public IPs when private IP blocking enabled', async () => {
      const policy = new NetworkPolicy({ blockPrivateIPs: true });

      await expect(policy.checkRequest({ hostname: '8.8.8.8' })).resolves.toBeUndefined();
    });
  });

  describe('cloud metadata protection', () => {
    it('should block AWS metadata service', async () => {
      const policy = new NetworkPolicy({ blockMetadata: true });

      try {
        await policy.checkRequest({ hostname: '169.254.169.254' });
        fail('Should have thrown NetworkPolicyError');
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkPolicyError);
        expect((error as NetworkPolicyError).code).toBe('POLICY_DENIED');
        expect((error as NetworkPolicyError).details?.rule).toBe('blockMetadata');
      }
    });

    it('should block GCP metadata service', async () => {
      const policy = new NetworkPolicy({ blockMetadata: true });

      try {
        await policy.checkRequest({ hostname: 'metadata.google.internal' });
        fail('Should have thrown NetworkPolicyError');
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkPolicyError);
        expect((error as NetworkPolicyError).code).toBe('POLICY_DENIED');
      }
    });

    it('should block Azure metadata service', async () => {
      const policy = new NetworkPolicy({ blockMetadata: true });

      try {
        await policy.checkRequest({ hostname: '169.254.169.254' });
        fail('Should have thrown NetworkPolicyError');
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkPolicyError);
        expect((error as NetworkPolicyError).code).toBe('POLICY_DENIED');
      }
    });

    it('should allow regular services when metadata blocking enabled', async () => {
      const policy = new NetworkPolicy({ blockMetadata: true });

      await expect(policy.checkRequest({ hostname: 'example.com' })).resolves.toBeUndefined();
    });
  });

  describe('redirect validation', () => {
    it('should enforce redirect limit', async () => {
      const policy = new NetworkPolicy({ maxRedirects: 3 });

      const requests = Array(5)
        .fill(null)
        .map((_, i) => ({
          url: `https://example.com/redirect${i}`,
        }));

      try {
        await policy.checkRedirectChain(requests);
        fail('Should have thrown NetworkPolicyError');
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkPolicyError);
        expect((error as NetworkPolicyError).code).toBe('MAX_REDIRECTS');
      }
    });

    it('should allow redirect chains within limit', async () => {
      const policy = new NetworkPolicy({ maxRedirects: 3 });

      const requests = Array(3)
        .fill(null)
        .map((_, i) => ({
          url: `https://example.com/redirect${i}`,
        }));

      await expect(policy.checkRedirectChain(requests)).resolves.toBeUndefined();
    });

    it('should detect redirect loops', async () => {
      const policy = new NetworkPolicy({ maxRedirects: 3 });

      const requests = [
        { url: 'https://example.com/page1' },
        { url: 'https://example.com/page2' },
        { url: 'https://example.com/page1' }, // Loop back to page1
      ];

      try {
        await policy.checkRedirectChain(requests);
        fail('Should have thrown NetworkPolicyError');
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkPolicyError);
        expect((error as NetworkPolicyError).code).toBe('REDIRECT_LOOP');
      }
    });
  });

  describe('response size limits', () => {
    it('should enforce max response size', async () => {
      const policy = new NetworkPolicy({ maxResponseSize: 1024 * 1024 }); // 1MB

      const response = {
        headers: { 'content-length': '2097152' }, // 2MB
      };

      try {
        await policy.checkResponse(response);
        fail('Should have thrown NetworkPolicyError');
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkPolicyError);
        expect((error as NetworkPolicyError).code).toBe('RESPONSE_TOO_LARGE');
      }
    });

    it('should allow responses within size limit', async () => {
      const policy = new NetworkPolicy({ maxResponseSize: 1024 * 1024 }); // 1MB

      const response = {
        headers: { 'content-length': '512000' }, // 500KB
      };

      await expect(policy.checkResponse(response)).resolves.toBeUndefined();
    });

    it('should handle missing content-length header', async () => {
      const policy = new NetworkPolicy({ maxResponseSize: 1024 });

      const response = {
        headers: {},
      };

      // Should allow when size is unknown
      await expect(policy.checkResponse(response)).resolves.toBeUndefined();
    });
  });

  describe('request logging', () => {
    it('should log all requests', async () => {
      const policy = new NetworkPolicy({
        blockLoopback: true,
        enableLogging: true,
      });

      const request = {
        hostname: 'example.com',
        url: 'https://example.com/page',
        timestamp: Date.now(),
      };

      // Log the request
      policy.logRequest(request);

      // Check that it was logged
      const logs = policy.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        hostname: 'example.com',
        url: 'https://example.com/page',
      });
    });

    it('should include timestamps in logs', async () => {
      const policy = new NetworkPolicy({ enableLogging: true });

      const before = Date.now();
      policy.logRequest({ hostname: 'example.com' });
      const after = Date.now();

      const logs = policy.getLogs();
      expect(logs[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(logs[0].timestamp).toBeLessThanOrEqual(after);
    });

    it('should clear logs when requested', async () => {
      const policy = new NetworkPolicy({ enableLogging: true });

      policy.logRequest({ hostname: 'example.com' });
      expect(policy.getLogs()).toHaveLength(1);

      policy.clearLogs();
      expect(policy.getLogs()).toHaveLength(0);
    });

    it('should cap retained logs at the configured maxLogEntries (TD-BROWSER-9, A4)', () => {
      const policy = new NetworkPolicy({ enableLogging: true, maxLogEntries: 3 });

      for (let i = 0; i < 10; i++) {
        policy.logRequest({ hostname: `host-${i}.example.com` });
      }

      const logs = policy.getLogs();
      expect(logs).toHaveLength(3);
      // Oldest entries evicted first: the retained set is the most recent three.
      expect(logs.map((entry) => entry.hostname)).toEqual([
        'host-7.example.com',
        'host-8.example.com',
        'host-9.example.com',
      ]);
    });

    it('should default maxLogEntries rather than growing without bound', () => {
      const policy = new NetworkPolicy({ enableLogging: true });

      for (let i = 0; i < 10_005; i++) {
        policy.logRequest({ hostname: `host-${i}.example.com` });
      }

      expect(policy.getLogs().length).toBeLessThanOrEqual(10_000);
    });
  });

  describe('policy configuration', () => {
    it('should use default configuration', () => {
      const policy = new NetworkPolicy();

      expect(policy).toBeDefined();
      // Should have safe defaults
      expect(() => policy.checkRequest({ hostname: 'localhost' })).not.toThrow();
    });

    it('should allow custom configuration', () => {
      const policy = new NetworkPolicy({
        blockLoopback: true,
        blockPrivateIPs: true,
        blockMetadata: true,
        maxRedirects: 5,
        maxResponseSize: 2048,
        enableLogging: true,
      });

      expect(policy).toBeDefined();
    });

    it('should validate redirect limit is positive', () => {
      expect(() => new NetworkPolicy({ maxRedirects: 0 })).not.toThrow();
      expect(() => new NetworkPolicy({ maxRedirects: -1 })).toThrow();
    });
  });

  describe('error handling', () => {
    it('should provide detailed error messages', async () => {
      const policy = new NetworkPolicy({ blockLoopback: true });

      try {
        await policy.checkRequest({ hostname: 'localhost' });
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkPolicyError);
        expect((error as NetworkPolicyError).code).toBe('POLICY_DENIED');
        expect((error as NetworkPolicyError).message).toContain('localhost');
        expect((error as NetworkPolicyError).retryable).toBe(false);
      }
    });

    it('should include hostname in error details', async () => {
      const policy = new NetworkPolicy({ blockPrivateIPs: true });

      try {
        await policy.checkRequest({ hostname: '192.168.1.1' });
        fail('Should have thrown');
      } catch (error) {
        expect((error as NetworkPolicyError).details).toEqual(
          expect.objectContaining({
            hostname: '192.168.1.1',
          })
        );
      }
    });
  });
});

describe('SessionHostPolicy (per-session composite)', () => {
  it('should allow only listed hosts when an allow-list is set', async () => {
    const base = new NetworkPolicy({ blockLoopback: true, blockMetadata: true });
    const chain = new SessionHostPolicy(base, {
      allowedHosts: ['api.example.com', '.trusted.example.com'],
    });

    await expect(
      chain.checkRequest({ hostname: 'api.example.com', url: 'https://api.example.com/' })
    ).resolves.toBeUndefined();
    await expect(
      chain.checkRequest({
        hostname: 'sub.trusted.example.com',
        url: 'https://sub.trusted.example.com/',
      })
    ).resolves.toBeUndefined();

    // A globally public host is denied: the allow-list is exhaustive.
    await expect(
      chain.checkRequest({ hostname: 'other.example.com', url: 'https://other.example.com/' })
    ).rejects.toThrow(/not in the session allow-list/);
  });

  it('should deny blocked hosts on top of the base policy', async () => {
    const base = new NetworkPolicy({ blockLoopback: false });
    const chain = new SessionHostPolicy(base, { blockedHosts: ['ads.example.com'] });

    await expect(
      chain.checkRequest({ hostname: 'ok.example.com', url: 'https://ok.example.com/' })
    ).resolves.toBeUndefined();
    await expect(
      chain.checkRequest({ hostname: 'ads.example.com', url: 'https://ads.example.com/' })
    ).rejects.toThrow(/blocked by the session/);
  });

  it('should still enforce the base SSRF policy', async () => {
    const base = new NetworkPolicy({ blockLoopback: true, blockMetadata: true });
    const chain = new SessionHostPolicy(base, { allowedHosts: ['localhost', '169.254.169.254'] });

    // The session allow-list cannot weaken the base SSRF defenses.
    await expect(
      chain.checkRequest({ hostname: 'localhost', url: 'http://localhost/' })
    ).rejects.toThrow();
    await expect(
      chain.checkRequest({ hostname: '169.254.169.254', url: 'http://169.254.169.254/' })
    ).rejects.toThrow();
  });

  it('should be a no-op wrapper with no session lists', async () => {
    const base = new NetworkPolicy({});
    const chain = new SessionHostPolicy(base, {});

    await expect(
      chain.checkRequest({ hostname: 'any.example.com', url: 'https://any.example.com/' })
    ).resolves.toBeUndefined();
  });
});
