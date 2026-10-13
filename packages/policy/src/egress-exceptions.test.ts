import { describe, expect, it, vi } from 'vitest';
import { type EgressExceptions, NetworkPolicy } from './network-policy.js';

// TD-BROWSER-15 phase 1 (egress): the loopback and private exceptions are
// decided by a hook, so an Authorizer can answer them. The default hook is
// today's flags and CIDRs.

describe('NetworkPolicy egress exceptions hook', () => {
  it('consults the hook with the address classes and private sources', async () => {
    const allowLoopback = vi.fn(() => false);
    const allowPrivate = vi.fn(() => true);
    const policy = new NetworkPolicy({
      blockLoopback: true,
      blockPrivateIPs: true,
      exceptions: { allowLoopback, allowPrivate },
    });
    await expect(policy.checkResolvedAddresses(['10.0.0.1'])).resolves.toBeUndefined();
    expect(allowPrivate).toHaveBeenCalledWith({
      phase: 'resolved',
      target: '10.0.0.1',
      addressClasses: ['private'],
      privateSources: [{ address: '10.0.0.1', type: 'ipv4' }],
    });
    await expect(policy.checkRequest({ hostname: 'localhost' })).rejects.toMatchObject({
      details: { rule: 'blockLoopback' },
    });
    expect(allowLoopback).toHaveBeenCalledWith({
      phase: 'hostname',
      target: 'localhost',
      addressClasses: ['loopback'],
      privateSources: [],
    });
  });

  it('only consults the hook when the corresponding block is on', async () => {
    const exceptions: EgressExceptions = {
      allowLoopback: vi.fn(() => false),
      allowPrivate: vi.fn(() => false),
    };
    const policy = new NetworkPolicy({ exceptions });
    await expect(policy.checkResolvedAddresses(['127.0.0.1', '10.0.0.1'])).resolves.toBeUndefined();
    expect(exceptions.allowLoopback).not.toHaveBeenCalled();
    expect(exceptions.allowPrivate).not.toHaveBeenCalled();
  });

  it('keeps the hook in the download snapshot and the gateway snapshot', async () => {
    const exceptions: EgressExceptions = { allowLoopback: () => true, allowPrivate: () => true };
    const policy = new NetworkPolicy({ blockLoopback: true, blockPrivateIPs: true, exceptions });
    await expect(policy.snapshot().checkResolvedAddresses(['127.0.0.1'])).resolves.toBeUndefined();
    const gateway = policy.snapshotForGateway();
    await expect(
      gateway.destinationPolicy.checkResolvedAddresses(['10.0.0.1'])
    ).resolves.toBeUndefined();
  });

  it('never lets the hook relax metadata', async () => {
    const policy = new NetworkPolicy({
      blockMetadata: true,
      blockPrivateIPs: true,
      exceptions: { allowLoopback: () => true, allowPrivate: () => true },
    });
    await expect(policy.checkResolvedAddresses(['169.254.169.254'])).rejects.toMatchObject({
      details: { rule: 'resolvedMetadata' },
    });
  });

  it('keeps the default exceptions of a snapshot immutable when the parent changes', async () => {
    const parent = new NetworkPolicy({
      blockPrivateIPs: true,
      allowedPrivateCIDRs: ['10.0.0.0/8'],
    });
    const snapshot = parent.snapshot();
    parent.updateConfig({ allowedPrivateCIDRs: [] });
    await expect(snapshot.checkResolvedAddresses(['10.0.0.1'])).resolves.toBeUndefined();
    await expect(parent.checkResolvedAddresses(['10.0.0.1'])).rejects.toMatchObject({
      details: { rule: 'resolvedPrivate' },
    });
    expect(() => snapshot.updateConfig({ allowedPrivateCIDRs: [] })).toThrow();
  });
});
