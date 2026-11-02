import { describe, expect, it } from 'vitest';
import { PageFetchLane, PROBE_NONCE_HEADER } from './page-fetch-lane.js';

describe('PageFetchLane', () => {
  it('attributes a claim only by its exact nonce', () => {
    const lane = new PageFetchLane();
    const claim = lane.register({
      method: 'PUT',
      url: 'https://vinted.com/api/items/1',
      origin: 'https://vinted.com',
    });
    expect(claim.nonce).toHaveLength(64);
    expect(lane.claimForHeaders({ [PROBE_NONCE_HEADER]: 'not-the-nonce' })).toBeUndefined();
    expect(lane.claimForHeaders({})).toBeUndefined();
    expect(lane.claimForHeaders({ [PROBE_NONCE_HEADER]: claim.nonce })).toBe(claim);
  });

  it('settles exactly once; later settlements are no-ops', async () => {
    const lane = new PageFetchLane();
    const claim = lane.register({
      method: 'GET',
      url: 'https://vinted.com/api',
      origin: 'https://vinted.com',
    });
    const first = claim.done;
    lane.settle(claim, {
      kind: 'admitted',
      status: 200,
      headers: [],
      body: Buffer.alloc(0),
      outcome: 'terminal',
    });
    lane.settle(claim, { kind: 'failed', detail: 'late' });
    expect(await first).toMatchObject({ kind: 'admitted', status: 200 });
    // Settled claims are forgotten: the nonce no longer attributes anything.
    expect(lane.claimForHeaders({ [PROBE_NONCE_HEADER]: claim.nonce })).toBeUndefined();
    expect(lane.hasLiveClaims()).toBe(false);
  });

  it('binds a network id once and never rebinds it to another claim', () => {
    const lane = new PageFetchLane();
    const first = lane.register({ method: 'PUT', url: 'https://a.com/x', origin: 'https://a.com' });
    const second = lane.register({
      method: 'PUT',
      url: 'https://a.com/x',
      origin: 'https://a.com',
    });
    lane.bindNetworkId(first, 'net-1');
    lane.bindNetworkId(second, 'net-1');
    expect(lane.claimForNetworkId('net-1')).toBe(first);
  });

  it('allows only same-origin redirect destinations', () => {
    const lane = new PageFetchLane();
    const claim = lane.register({
      method: 'PUT',
      url: 'https://vinted.com/api/items/1',
      origin: 'https://vinted.com',
    });
    expect(lane.allowsRedirect(claim, 'https://vinted.com/api/items/1')).toBe(true);
    expect(lane.allowsRedirect(claim, 'https://other.vinted.com/leak')).toBe(false);
    expect(lane.allowsRedirect(claim, 'not a url')).toBe(false);
  });

  it('notes and consumes denials by request shape', () => {
    const lane = new PageFetchLane();
    lane.noteDenied(
      'PUT',
      'https://vinted.com/api/items/1',
      'egress_policy',
      'SCOPE_METHOD_DENIED'
    );
    expect(lane.takeDenial('put', 'https://vinted.com/api/items/1?query=1')).toMatchObject({
      reason: 'egress_policy',
      scope: 'SCOPE_METHOD_DENIED',
    });
    // Consumed: a second take (the claim settled) returns nothing.
    expect(lane.takeDenial('PUT', 'https://vinted.com/api/items/1')).toBeUndefined();
    expect(lane.takeDenial('PUT', 'https://vinted.com/api/items/2')).toBeUndefined();
  });

  it('bounds live claims', () => {
    const lane = new PageFetchLane();
    for (let i = 0; i < 8; i += 1) {
      lane.register({ method: 'GET', url: `https://a.com/${i}`, origin: 'https://a.com' });
    }
    expect(() =>
      lane.register({ method: 'GET', url: 'https://a.com/9', origin: 'https://a.com' })
    ).toThrow('PROBE_LANE_FULL');
  });
});
