import { describe, expect, it } from 'vitest';
import type { Authorizer } from './authorizer.js';
import { assertEquivalentToLegacy, egressRequests } from './differential.harness.js';
import { LegacyAuthorizer } from './legacy-authorizer.js';

// TD-BROWSER-15 phase 2: the oracle is committed and green against
// LegacyAuthorizer itself before CedarAuthorizer (phase 3) becomes its subject.

describe('differential oracle', () => {
  it('holds for LegacyAuthorizer against itself', async () => {
    await assertEquivalentToLegacy(
      (c) =>
        new LegacyAuthorizer({
          allowLoopback: c.allowLoopback,
          allowedPrivateCIDRs: c.allowedPrivateCIDRs,
          unknownRisk: c.unknownRisk,
        }),
      { numRuns: 400 }
    );
  });

  it.each([
    [
      'ignores CIDRs entirely',
      (a: LegacyAuthorizer): Authorizer['decide'] =>
        (r) =>
          r.action === 'request.private'
            ? { allowed: false, reason: 'x', ruleMatched: 'env.block-private' }
            : a.decide(r),
    ],
    [
      'flips the loopback setting',
      (a: LegacyAuthorizer): Authorizer['decide'] =>
        (r) =>
          r.action === 'request.loopback'
            ? { ...a.decide(r), allowed: !a.decide(r).allowed }
            : a.decide(r),
    ],
    [
      'ignores a rule decision of deny',
      (a: LegacyAuthorizer): Authorizer['decide'] =>
        (r) =>
          r.action === 'act' && 'rule' in r.context && r.context.rule?.decision === 'deny'
            ? { allowed: true, reason: 'x', ruleMatched: 'env.approval.default' }
            : a.decide(r),
    ],
    [
      'treats unknown risk as allowed',
      (a: LegacyAuthorizer): Authorizer['decide'] =>
        (r) =>
          r.action === 'act.unattended' && 'effect' in r.context && r.context.effect === 'unknown'
            ? { allowed: true, reason: 'x', ruleMatched: 'env.approval.unknown-risk' }
            : a.decide(r),
    ],
    [
      'denies one capability',
      (a: LegacyAuthorizer): Authorizer['decide'] =>
        (r) =>
          r.action === 'serviceWorkers'
            ? { allowed: false, reason: 'x', ruleMatched: 'env.capability.default' }
            : a.decide(r),
    ],
  ])('catches a subject that %s', async (_name, broken) => {
    await expect(
      assertEquivalentToLegacy(
        (c) => {
          const legacy = new LegacyAuthorizer({
            allowLoopback: c.allowLoopback,
            allowedPrivateCIDRs: c.allowedPrivateCIDRs,
            unknownRisk: c.unknownRisk,
          });
          return { version: 'broken', decide: broken(legacy) };
        },
        { numRuns: 400, seed: 42 }
      )
    ).rejects.toThrow(/Divergence/);
  });

  it('captures egress contexts from the real NetworkPolicy path', async () => {
    const asked = await egressRequests(['localhost', '[::1]'], ['10.0.0.1', '64:ff9b::7f00:1']);
    expect(asked.map((r) => r.action)).toEqual([
      'request.loopback', // localhost by name
      'request.loopback', // [::1] is loopback...
      'request.private', // ...and private: both are asked, as in production
      'request.private', // 10.0.0.1
      'request.loopback', // NAT64 of 127.0.0.1
    ]);
  });
});
