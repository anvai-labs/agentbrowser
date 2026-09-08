import { describe, expect, it } from 'vitest';
import {
  type GatewayPolicySnapshot,
  NetworkPolicy,
  NetworkPolicyError,
  SessionHostPolicy,
} from './network-policy.js';

describe('immutable TCP destination policy views', () => {
  it('intersects operator ports even when a custom provider ignores its options', async () => {
    class Custom extends NetworkPolicy {
      override snapshotForGateway() {
        return new NetworkPolicy().snapshotForGateway({ allowedPorts: [443, 8443] });
      }
    }
    const pair = new SessionHostPolicy(new Custom(), {}).snapshotForGateway({
      allowedPorts: [443],
    });
    await pair.destinationPolicy.checkDestination({ hostname: 'example.com', port: 443 });
    await expect(
      pair.destinationPolicy.checkDestination({ hostname: 'example.com', port: 8443 })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it.each(['coverage', 'request', 'destination', 'addresses'])(
    'rejects malformed custom %s capability',
    (mode) => {
      class Custom extends NetworkPolicy {
        override snapshotForGateway(): GatewayPolicySnapshot {
          const pair = new NetworkPolicy().snapshotForGateway();
          return {
            ...pair,
            ...(mode === 'coverage' ? { coverage: 'unreviewed' } : {}),
            ...(mode === 'request' ? { requestPolicy: {} } : {}),
            ...(mode === 'destination' ? { destinationPolicy: {} } : {}),
            ...(mode === 'addresses'
              ? { destinationPolicy: { checkDestination: async () => {} } }
              : {}),
          } as unknown as GatewayPolicySnapshot;
        }
      }
      expect(() => new SessionHostPolicy(new Custom(), {}).snapshotForGateway()).toThrowError(
        expect.objectContaining({ code: 'ENGINE_UNSUPPORTED' })
      );
    }
  );

  it('preserves a conservative custom path policy without inventing a request URL', async () => {
    const urls: Array<string | undefined> = [];
    class Custom extends NetworkPolicy {
      override async checkRequest(request: { hostname: string; url?: string }) {
        urls.push(request.url);
        if (request.hostname === 'restricted.invalid' && request.url?.endsWith('/private'))
          throw new NetworkPolicyError('POLICY_DENIED', 'Private path');
      }
      override snapshotForGateway(): GatewayPolicySnapshot {
        const fixed = new Custom();
        const standard = new NetworkPolicy().snapshotForGateway();
        return {
          ...standard,
          requestPolicy: fixed,
          destinationPolicy: {
            ...standard.destinationPolicy,
            async checkDestination(destination) {
              if (destination.hostname === 'restricted.invalid')
                throw new NetworkPolicyError(
                  'POLICY_DENIED',
                  'Cannot enforce paths on an opaque stream'
                );
              await standard.destinationPolicy.checkDestination(destination);
            },
          },
        };
      }
    }
    const pair = new SessionHostPolicy(new Custom(), {}).snapshotForGateway();
    await expect(
      pair.requestPolicy.checkRequest({
        hostname: 'restricted.invalid',
        url: 'https://restricted.invalid/private',
      })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await pair.requestPolicy.checkRequest({
      hostname: 'restricted.invalid',
      url: 'https://restricted.invalid/public',
    });
    await expect(
      pair.destinationPolicy.checkDestination({ hostname: 'restricted.invalid', port: 443 })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await pair.destinationPolicy.checkDestination({ hostname: 'example.com', port: 443 });
    await pair.requestPolicy.checkRequest({
      hostname: 'example.com',
      url: 'https://example.com/private',
    });
    expect(urls).toEqual([
      'https://restricted.invalid/private',
      'https://restricted.invalid/public',
      'https://example.com/private',
    ]);
  });
  it('limits destinations to 443 without changing HTTP request semantics', async () => {
    const pair = new NetworkPolicy().snapshotForGateway();
    expect(pair.coverage).toBe('tcp-destination-only');
    await pair.destinationPolicy.checkDestination({ hostname: 'example.com', port: 443 });
    await expect(
      pair.destinationPolicy.checkDestination({ hostname: 'example.com', port: 80 })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await pair.requestPolicy.checkRequest({ hostname: 'example.com', url: 'http://example.com/' });
  });

  it('captures both views, ports and session rules before caller mutation', async () => {
    const base = new NetworkPolicy({ maxResponseSize: 4 });
    const ports = [8443];
    const allowedHosts = ['localhost'];
    const session = new SessionHostPolicy(base, { allowedHosts });
    const old = session.snapshotForGateway({ allowedPorts: ports });
    base.updateConfig({ blockLoopback: true, maxResponseSize: 100 });
    ports[0] = 443;
    allowedHosts[0] = 'other.invalid';
    await old.destinationPolicy.checkDestination({ hostname: 'localhost', port: 8443 });
    await old.requestPolicy.checkRequest({ hostname: 'localhost', url: 'http://localhost/' });
    await expect(old.requestPolicy.checkBodySize(5)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    await expect(
      old.destinationPolicy.checkDestination({ hostname: 'localhost', port: 443 })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(
      session
        .snapshotForGateway()
        .destinationPolicy.checkDestination({ hostname: 'localhost', port: 443 })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it.each([
    ['example.com', true],
    ['EXAMPLE.COM', true],
    ['sub.example.com', true],
    ['bad.example.com', false],
    ['notexample.com', false],
    ['example.com.other', false],
  ])('shares exact/suffix and deny-first matching for %s', async (hostname, allowed) => {
    const pair = new SessionHostPolicy(new NetworkPolicy(), {
      allowedHosts: ['example.com', '.example.com'],
      blockedHosts: ['bad.example.com'],
    }).snapshotForGateway();
    const request = pair.requestPolicy.checkRequest({
      hostname,
      url: `https://${hostname}/actual`,
    });
    const destination = pair.destinationPolicy.checkDestination({ hostname, port: 443 });
    if (allowed) await Promise.all([request, destination]);
    else
      await Promise.all(
        [request, destination].map((p) =>
          expect(p).rejects.toMatchObject({ code: 'POLICY_DENIED' })
        )
      );
  });

  it('preserves empty-allowlist behavior and cannot weaken base address rules', async () => {
    const pair = new SessionHostPolicy(
      new NetworkPolicy({ blockLoopback: true, blockPrivateIPs: true }),
      {
        allowedHosts: [],
      }
    ).snapshotForGateway();
    await pair.destinationPolicy.checkDestination({ hostname: 'example.com', port: 443 });
    await expect(
      pair.destinationPolicy.checkDestination({ hostname: '::ffff:127.0.0.1', port: 443 })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(
      pair.destinationPolicy.checkResolvedAddresses(['93.184.216.34', '10.0.0.1'])
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it.each(
    [
      [],
      [0],
      [65536],
      [1.5],
      [Number.NaN],
      Array<number>(1),
      [443, 443],
      Array.from({ length: 65 }, (_, i) => i + 1),
    ].map((allowedPorts) => ({ allowedPorts }))
  )('rejects invalid or unbounded port configuration $allowedPorts', ({ allowedPorts }) => {
    expect(() => new NetworkPolicy().snapshotForGateway({ allowedPorts })).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' })
    );
  });

  it.each([
    'checkRequest',
    'checkResolvedAddresses',
    'checkResponse',
    'checkBodySize',
    'checkRedirectChain',
    'snapshot',
    'getConfig',
  ])('does not silently drop an overridden %s hook', (method) => {
    const base = new NetworkPolicy();
    Object.defineProperty(base, method, { value: () => new NetworkPolicy() });
    expect(() => base.snapshotForGateway()).toThrowError(
      expect.objectContaining({ code: 'ENGINE_UNSUPPORTED' })
    );
  });

  it('requires a distinct explicit custom adapter, not just a download snapshot', async () => {
    class Custom extends NetworkPolicy {
      override snapshot() {
        return new Custom();
      }
      override async checkRequest(request: { hostname: string; url?: string }) {
        if (request.url?.endsWith('/private'))
          throw new NetworkPolicyError('POLICY_DENIED', 'Private path');
      }
    }
    const base = new Custom();
    await expect(
      base.snapshot().checkRequest({ hostname: 'example.com', url: 'https://example.com/private' })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(() => base.snapshotForGateway()).toThrowError(
      expect.objectContaining({ code: 'ENGINE_UNSUPPORTED' })
    );
  });
});
