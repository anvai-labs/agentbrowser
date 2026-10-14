import { describe, expect, it } from 'vitest';
import { CedarAuthorizer, documentVersion } from './cedar-authorizer.js';
import { policyDocumentFromLegacyConfig } from './cedar-generator.js';
import { assertEquivalentToLegacy, type LegacyConfig } from './differential.harness.js';

/**
 * TD-BROWSER-15 phase 3b's equivalence gate: `CedarAuthorizer`, loaded with
 * generated documents, must decide exactly as `LegacyAuthorizer` on generated
 * configurations — the phase-2 oracle, tables and mutant-grade strictness
 * included — because nothing turns Cedar on in production until phase 4, and
 * this is what earns it the right to be.
 */

const cedarFor = (config: LegacyConfig) =>
  new CedarAuthorizer({ document: policyDocumentFromLegacyConfig(config) });

describe('CedarAuthorizer passes the differential oracle', () => {
  for (const seed of [1, 42]) {
    it(`is equivalent to LegacyAuthorizer (seed ${seed})`, async () => {
      await assertEquivalentToLegacy(cedarFor, { numRuns: 300, seed });
    }, 300_000);
  }
});

describe('CedarAuthorizer loads documents strictly', () => {
  const base = () => policyDocumentFromLegacyConfig({ allowedPrivateCIDRs: ['10.0.0.0/8'] });

  it('rejects a policy that fails strict validation', () => {
    const document = base();
    document.policies.push({
      key: 'bad#1',
      ruleId: 'operator.bad',
      cedar: 'permit(principal, action, resource) when { context.nonexistent == "x" };',
    });
    expect(() => new CedarAuthorizer({ document })).toThrow(/Cedar validation failed/);
  });

  it('rejects a @rule annotation that does not match the ruleId', () => {
    const document = base();
    document.policies.push({
      key: 'bad#1',
      ruleId: 'operator.pay',
      cedar: '@rule("operator.other") permit(principal, action, resource);',
    });
    expect(() => new CedarAuthorizer({ document })).toThrow(/@rule annotation does not match/);
  });

  it('rejects reserved and malformed rule ids', () => {
    for (const ruleId of ['floor.cdp', 'default.deny', 'engine.error', 'BAD ID', '']) {
      const document = base();
      document.policies.push({
        key: 'bad#1',
        ruleId,
        cedar: 'permit(principal, action, resource);',
      });
      expect(() => new CedarAuthorizer({ document })).toThrow(/rule id/);
    }
  });

  it('rejects generated env.* rules on a document without a baseline', () => {
    const document = base();
    document.baseline = undefined;
    expect(() => new CedarAuthorizer({ document })).toThrow(/without a baseline/);
  });

  it('versions documents by content, key order and whitespace aside', () => {
    const a = policyDocumentFromLegacyConfig({
      rules: [{ id: 'pay', effect: 'transaction', decision: 'deny' }],
    });
    const b = policyDocumentFromLegacyConfig({
      rules: [{ id: 'pay', effect: 'transaction', decision: 'deny' }],
    });
    expect(documentVersion(a)).toBe(documentVersion(b));
    const c = policyDocumentFromLegacyConfig({
      rules: [{ id: 'pay', effect: 'transaction', decision: 'allow' }],
    });
    expect(documentVersion(a)).not.toBe(documentVersion(c));
  });
});

describe('CedarAuthorizer fails closed on traps', () => {
  // Strict validation statically flags any policy that would error for a
  // declared request shape, so the TD's "erroring forbid" case is enforced at
  // LOAD, before a decision can ever run: a mapped-form ip() literal and a
  // missing optional attribute both refuse construction. The trap path stays
  // for the reachable surfaces — a rejected request and a refused source —
  // and is fail-closed and sticky.
  it('the loader refuses statically erroring policies', () => {
    const cases = [
      '@rule("operator.x") permit(principal, action == AgentBrowser::Action::"request.private", resource) when { context.ip.isInRange(ip("::ffff:10.1.2.3")) };',
      '@rule("operator.x") permit(principal, action == AgentBrowser::Action::"act", resource) when { principal.engine == "chromium" };',
    ];
    for (const cedarText of cases) {
      const document = policyDocumentFromLegacyConfig({});
      document.policies.push({ key: 'operator.x#1', ruleId: 'operator.x', cedar: cedarText });
      expect(() => new CedarAuthorizer({ document })).toThrow(/Cedar validation failed/);
    }
  });

  it('a rejected request denies with engine.error and is sticky', () => {
    const authorizer = cedarFor({ allowLoopback: true });
    // A type-bypass caller: the context shape is wrong, so Cedar rejects the
    // request itself.
    const decision = authorizer.decide({
      action: 'act',
      context: { effect: 5 } as unknown as { effect: 'read' },
    });
    expect(decision).toMatchObject({ allowed: false, ruleMatched: 'engine.error' });
    expect(authorizer.healthy).toBe(false);
    for (const request of [
      { action: 'act' as const, context: { effect: 'read' as const } },
      { action: 'downloads' as const, context: {} },
    ]) {
      expect(authorizer.decide(request)).toMatchObject({
        allowed: false,
        ruleMatched: 'engine.error',
      });
    }
  });

  it('reports a forbidding id the old capability filter erased (review 3b F2)', () => {
    const document = policyDocumentFromLegacyConfig({});
    document.baseline = 'agentbrowser:baseline/v1';
    document.policies.push({
      key: 'env.capability.no-downloads#99',
      ruleId: 'env.capability.no-downloads',
      cedar:
        '@rule("env.capability.no-downloads") forbid(principal, action == AgentBrowser::Action::"downloads", resource);',
    });
    const decision = new CedarAuthorizer({ document }).decide({
      action: 'downloads',
      context: {},
    });
    expect(decision).toMatchObject({
      allowed: false,
      ruleMatched: 'env.capability.no-downloads',
    });
  });

  it('lists each deciding id once (review 3b F3)', () => {
    const authorizer = cedarFor({});
    const decision = authorizer.decide({ action: 'act.unattended', context: { effect: 'read' } });
    expect(decision.rulesMatched).toEqual(['env.approval.default']);
  });

  it('the vacuous private ask matches legacy', () => {
    const authorizer = cedarFor({ allowedPrivateCIDRs: [] });
    expect(
      authorizer.decide({
        action: 'request.private',
        context: {
          phase: 'hostname',
          target: 'localhost',
          addressClasses: ['private'],
          privateSources: [],
        },
      })
    ).toMatchObject({ allowed: true, ruleMatched: 'env.allowed-cidrs' });
  });

  it('a family-mismatched private source traps rather than grants', () => {
    const authorizer = cedarFor({ allowedPrivateCIDRs: ['10.0.0.0/8'] });
    expect(
      authorizer.decide({
        action: 'request.private',
        context: {
          phase: 'resolved',
          target: 'x',
          addressClasses: ['private'],
          privateSources: [{ address: 'fd12::1', type: 'ipv4' }],
        },
      })
    ).toMatchObject({ allowed: false, ruleMatched: 'engine.error' });
    expect(authorizer.healthy).toBe(false);
  });
});
