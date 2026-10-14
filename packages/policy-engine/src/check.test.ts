import { NetworkPolicy } from '@agentbrowser/policy';
import { describe, expect, it } from 'vitest';
import { policyCheck } from './check.js';
import { CedarAuthorizer, LegacyAuthorizer, policyDocumentFromLegacyConfig } from './index.js';

/**
 * TD-BROWSER-15 phase 5: the check engine answers without DNS, agrees with
 * enforcement on IP literals, and works identically against the legacy and
 * Cedar authorizers.
 */

const legacy = (cidrs: string[] = [], allowLoopback = false) =>
  new LegacyAuthorizer({ allowedPrivateCIDRs: cidrs, allowLoopback });
const cedar = (cidrs: string[] = [], allowLoopback = false) =>
  new CedarAuthorizer({
    document: policyDocumentFromLegacyConfig({ allowedPrivateCIDRs: cidrs, allowLoopback }),
    defaultTenant: 'local',
  });

const single = (answer: ReturnType<typeof policyCheck>) => {
  expect(answer).toHaveLength(1);
  return answer[0]!;
};

describe('policyCheck: IP literals agree with enforcement', () => {
  const cases: Array<[string, string[], boolean]> = [
    ['10.1.2.3', ['10.0.0.0/8'], false],
    ['10.1.2.3', [], false],
    ['127.0.0.1', [], true],
    ['127.0.0.1', [], false],
    ['::1', [], true],
    ['192.168.1.5', ['::ffff:192.168.1.0/120'], false],
    ['8.8.8.8', [], false],
  ];
  for (const authorizer of [legacy, cedar]) {
    for (const [literal, cidrs, allowLoopback] of cases) {
      it(`${authorizer === legacy ? 'legacy' : 'cedar'}: ${literal} (cidrs=${cidrs.join(',') || 'none'}, loopback=${allowLoopback})`, async () => {
        const answer = single(
          policyCheck(authorizer(cidrs, allowLoopback), { action: 'request', target: literal })
        );
        expect(answer.answer.kind).toBe('decision');
        if (answer.answer.kind !== 'decision') return;
        // Enforcement's own answer for the same literal.
        const policy = new NetworkPolicy({
          blockLoopback: !allowLoopback,
          blockPrivateIPs: true,
          blockMetadata: true,
          allowedPrivateCIDRs: cidrs,
        });
        let enforced: 'allow' | 'deny' = 'allow';
        try {
          await policy.checkRequest({ hostname: literal });
        } catch {
          enforced = 'deny';
        }
        expect(answer.answer.decision.allowed).toBe(enforced === 'allow');
      });
    }
  }
});

describe('policyCheck: names and floors', () => {
  it('a metadata hostname is floor-denied without resolution', () => {
    const answer = single(
      policyCheck(legacy(), { action: 'request', target: 'metadata.google.internal' })
    );
    expect(answer.answer).toMatchObject({ kind: 'decision' });
    if (answer.answer.kind !== 'decision') return;
    expect(answer.answer.decision).toMatchObject({ allowed: false, ruleMatched: 'floor.metadata' });
  });
  it('a metadata IP literal is floor-denied', () => {
    const answer = single(policyCheck(legacy(), { action: 'request', target: '169.254.169.254' }));
    expect(answer.answer.kind).toBe('decision');
    if (answer.answer.kind !== 'decision') return;
    expect(answer.answer.decision).toMatchObject({ allowed: false, ruleMatched: 'floor.metadata' });
  });
  it('a loopback name answers the loopback question at the name level', () => {
    const denied = single(policyCheck(legacy(), { action: 'request', target: 'localhost' }));
    expect(denied.answer.kind).toBe('decision');
    if (denied.answer.kind !== 'decision') return;
    expect(denied.answer.decision).toMatchObject({
      allowed: false,
      ruleMatched: 'env.block-loopback',
    });
    const allowed = single(
      policyCheck(legacy([], true), { action: 'request', target: 'localhost' })
    );
    expect(allowed.answer.kind).toBe('decision');
    if (allowed.answer.kind !== 'decision') return;
    expect(allowed.answer.decision).toMatchObject({
      allowed: true,
      ruleMatched: 'env.allow-loopback',
    });
  });
  it('an ordinary hostname enumerates the class sets: public decided, the rest depend on resolution', () => {
    const answers = policyCheck(legacy(), { action: 'request', target: 'example.com' });
    expect(answers.map((a) => a.classSet)).toEqual([
      'public',
      'loopback',
      'private',
      'loopback+private',
    ]);
    expect(answers[0]?.answer.kind).toBe('decision');
    expect(answers[1]?.answer.kind).toBe('depends-on-resolution');
    expect(answers[2]?.answer.kind).toBe('depends-on-resolution');
    expect(answers[3]?.answer.kind).toBe('depends-on-resolution');
  });
});

describe('policyCheck: acts and capabilities', () => {
  it('act answers with the declared context', () => {
    const answer = single(policyCheck(legacy(), { action: 'act', context: { effect: 'read' } }));
    expect(answer.answer.kind).toBe('decision');
    if (answer.answer.kind !== 'decision') return;
    expect(answer.answer.decision).toMatchObject({
      allowed: true,
      ruleMatched: 'env.approval.default',
    });
  });
  it('capabilities answer through the authorizer', () => {
    const answer = single(policyCheck(legacy(), { action: 'downloads', tenantId: 't1' }));
    expect(answer.answer.kind).toBe('decision');
    if (answer.answer.kind !== 'decision') return;
    expect(answer.answer.decision).toMatchObject({
      allowed: true,
      ruleMatched: 'env.capability.default',
    });
  });
});
