import { NetworkPolicy } from '@agentbrowser/policy';
import { describe, expect, it } from 'vitest';
import { policyCheck } from './check.js';
import {
  CedarAuthorizer,
  egressExceptionsOf,
  LegacyAuthorizer,
  policyDocumentFromLegacyConfig,
} from './index.js';

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

describe('policyCheck: parity with policies conditioning on ask context (review 3)', () => {
  /** Each cedar text is its own policy; the @rule id must match its ruleId. */
  const docWith = (...cedarTexts: string[]) => ({
    version: 'agentbrowser-policy/v1' as const,
    unknownRisk: 'allow' as const,
    approvalRules: [],
    policies: cedarTexts.map((cedar, i) => ({
      key: `operator.x#${i + 1}`,
      ruleId: /@rule\("([^"]+)"\)/.exec(cedar)?.[1] ?? 'operator.x',
      cedar,
    })),
  });
  const policy = (...cedarTexts: string[]) =>
    new NetworkPolicy({
      blockLoopback: true,
      blockPrivateIPs: true,
      blockMetadata: true,
      exceptions: egressExceptionsOf(new CedarAuthorizer({ document: docWith(...cedarTexts) })),
    });
  const checkFor = (cedarTexts: string[], target: string) => {
    const answer = policyCheck(new CedarAuthorizer({ document: docWith(...cedarTexts) }), {
      action: 'request',
      target,
    });
    expect(answer).toHaveLength(1);
    const first = answer[0];
    expect(first?.answer.kind).toBe('decision');
    return first?.answer.kind === 'decision' ? first.answer.decision.allowed : undefined;
  };

  it('a phase-conditioned loopback permit matches enforcement on 127.0.0.1', async () => {
    // Enforcement asks literals at the hostname phase; check must too.
    const cedar =
      '@rule("operator.l") permit(principal, action == AgentBrowser::Action::"request.loopback", resource) when { context.phase == "hostname" };';
    await expect(policy(cedar).checkRequest({ hostname: '127.0.0.1' })).resolves.toBeUndefined();
    expect(checkFor([cedar], '127.0.0.1')).toBe(true);
  });

  it('an addressClasses-conditioned policy sees the full class set', async () => {
    // 0.0.0.0 is loopback AND private: enforcement asks BOTH actions with the
    // full class set, so both permits are needed and both surfaces agree.
    const both = [
      '@rule("operator.l") permit(principal, action == AgentBrowser::Action::"request.loopback", resource) when { context.addressClasses == ["loopback", "private"] };',
      '@rule("operator.p") permit(principal, action == AgentBrowser::Action::"request.private", resource) when { context.addressClasses == ["loopback", "private"] };',
    ];
    await expect(policy(...both).checkRequest({ hostname: '0.0.0.0' })).resolves.toBeUndefined();
    expect(checkFor(both, '0.0.0.0')).toBe(true);
    // A loopback-only condition never matches 0.0.0.0 on either surface.
    const narrow =
      '@rule("operator.l") permit(principal, action == AgentBrowser::Action::"request.loopback", resource) when { context.addressClasses == ["loopback"] };';
    await expect(policy(narrow).checkRequest({ hostname: '0.0.0.0' })).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    expect(checkFor([narrow], '0.0.0.0')).toBe(false);
  });
});

describe('policyCheck: invalid literals and prefixes (review 4)', () => {
  it('refuses what enforcement refuses', () => {
    for (const target of [
      '127.0.0.1:8080',
      '010.1.2.3',
      'fe80::1%eth0',
      '[::1]junk',
      '10.0.0.0/8',
    ]) {
      const answers = policyCheck(legacy(), { action: 'request', target });
      expect(answers).toHaveLength(1);
      expect(answers[0]?.classSet).toBe('invalid');
      expect(answers[0]?.answer.kind).toBe('decision');
      if (answers[0]?.answer.kind === 'decision') {
        expect(answers[0].answer.decision).toMatchObject({
          allowed: false,
          ruleMatched: 'floor.invalid-ip',
        });
      }
    }
  });
});
