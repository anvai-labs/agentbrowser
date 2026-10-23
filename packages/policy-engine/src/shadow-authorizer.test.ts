import { describe, expect, it, vi } from 'vitest';
import type { AuthorizationRequest, Authorizer } from './authorizer.js';
import { CedarAuthorizer } from './cedar-authorizer.js';
import { MemoizedAuthorizer } from './memoized-authorizer.js';
import { ShadowAuthorizer } from './shadow-authorizer.js';
import { TenantBindingAuthorizer } from './tenant-binding.js';

const req = (action: AuthorizationRequest['action']): AuthorizationRequest =>
  action === 'downloads' || action === 'cdp.attach'
    ? { action, context: {} }
    : action === 'act'
      ? { action, context: { effect: 'read' } }
      : {
          action,
          context: { phase: 'resolved', target: 'x', addressClasses: [], privateSources: [] },
        };

const fake = (
  decide: (r: AuthorizationRequest) => { allowed: boolean; ruleMatched: string }
): Authorizer => ({
  version: 'fake',
  decide,
});

describe('ShadowAuthorizer', () => {
  it('legacy decides; agreement is silent', () => {
    const warn = vi.fn();
    const legacy = fake(() => ({ allowed: true, ruleMatched: 'env.approval.default' }));
    const shadow = fake(() => ({ allowed: true, ruleMatched: 'env.approval.default' }));
    const a = new ShadowAuthorizer(legacy, shadow, warn);
    expect(a.decide(req('act'))).toMatchObject({
      allowed: true,
      ruleMatched: 'env.approval.default',
    });
    expect(warn).not.toHaveBeenCalled();
  });
  it('a divergence warns with both rule ids and keeps the legacy decision', () => {
    const warn = vi.fn();
    const legacy = fake(() => ({ allowed: true, ruleMatched: 'a' }));
    const shadow = fake(() => ({ allowed: false, ruleMatched: 'b' }));
    const a = new ShadowAuthorizer(legacy, shadow, warn);
    expect(a.decide(req('downloads'))).toMatchObject({ allowed: true, ruleMatched: 'a' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/legacy true\/a, cedar false\/b; legacy decided/)
    );
  });
  it('a throwing shadow warns and never breaks the legacy decision', () => {
    const warn = vi.fn();
    const legacy = fake(() => ({ allowed: true, ruleMatched: 'a' }));
    const shadow = fake(() => {
      throw new Error('boom');
    });
    const a = new ShadowAuthorizer(legacy, shadow, warn);
    expect(a.decide(req('downloads'))).toMatchObject({ allowed: true, ruleMatched: 'a' });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/shadow threw/));
  });
  it('reports shadow health from the healthy flag when present', () => {
    const legacy = fake(() => ({ allowed: true, ruleMatched: 'a' }));
    const healthy = fake(() => ({ allowed: true, ruleMatched: 'a' })) as Authorizer & {
      healthy: boolean;
    };
    healthy.healthy = true;
    const a = new ShadowAuthorizer(legacy, healthy, vi.fn());
    expect(a.shadowHealthy).toBe(true);
    healthy.healthy = false;
    expect(a.shadowHealthy).toBe(false);
  });
});

describe('MemoizedAuthorizer', () => {
  it('answers from the cache for repeated requests', () => {
    let calls = 0;
    const inner = fake(() => {
      calls += 1;
      return { allowed: true, ruleMatched: 'x' };
    });
    const memo = new MemoizedAuthorizer(inner);
    memo.decide(req('downloads'));
    memo.decide(req('downloads'));
    expect(calls).toBe(1);
    expect(memo.size).toBe(1);
  });
  it('different requests are different keys', () => {
    const inner = fake(() => ({ allowed: true, ruleMatched: 'x' }));
    const memo = new MemoizedAuthorizer(inner);
    memo.decide({ action: 'act', context: { effect: 'read' } });
    memo.decide({ action: 'act', context: { effect: 'transaction' } });
    expect(memo.size).toBe(2);
  });
  it('evicts the least recently used past the bound and refreshes on use', () => {
    const inner = fake((_r) => ({ allowed: true, ruleMatched: 'x' }));
    const memo = new MemoizedAuthorizer(inner, 2);
    const a = req('downloads');
    const b = { action: 'act' as const, context: { effect: 'read' as const } };
    const c = { action: 'act' as const, context: { effect: 'write-local' as const } };
    memo.decide(a);
    memo.decide(b);
    memo.decide(a); // refresh a
    memo.decide(c); // evicts b, not a
    expect(memo.size).toBe(2);
    memo.decide(b); // b was evicted: a real decide again
    expect(memo.size).toBe(2);
  });
  it('clears at close', () => {
    const inner = fake(() => ({ allowed: true, ruleMatched: 'x' }));
    const memo = new MemoizedAuthorizer(inner);
    memo.decide(req('downloads'));
    memo.clear();
    expect(memo.size).toBe(0);
  });
});

describe('TenantBindingAuthorizer with CedarAuthorizer (TD-15 phase 4)', () => {
  // A pure operator document: no baseline, no generated defaults — an
  // operator policy file replaces the environment-derived decisions.
  const perTenantDocument = () => ({
    version: 'agentbrowser-policy/v1' as const,
    unknownRisk: 'allow' as const,
    approvalRules: [],
    policies: [
      {
        key: 'operator.loopback#1',
        ruleId: 'operator.loopback',
        cedar:
          '@rule("operator.loopback") permit(principal, action == AgentBrowser::Action::"request.loopback", resource) when { principal in AgentBrowser::Tenant::"a" };',
      },
    ],
  });

  it('tenant A reaches the fixture; tenant B is denied with default.deny', () => {
    const cedar = new CedarAuthorizer({ document: perTenantDocument() });
    const loopback = {
      action: 'request.loopback' as const,
      context: {
        phase: 'hostname' as const,
        target: 'localhost',
        addressClasses: ['loopback' as const],
        privateSources: [],
      },
    };
    expect(new TenantBindingAuthorizer(cedar, 'a').decide(loopback)).toMatchObject({
      allowed: true,
      ruleMatched: 'operator.loopback',
    });
    expect(new TenantBindingAuthorizer(cedar, 'b').decide(loopback)).toMatchObject({
      allowed: false,
      ruleMatched: 'default.deny',
    });
    // Unbound: the implicit tenant decides, and it is not "a".
    expect(cedar.decide(loopback)).toMatchObject({ allowed: false, ruleMatched: 'default.deny' });
  });

  it('a caller-supplied tenantId is never trusted over the binding', () => {
    const cedar = new CedarAuthorizer({ document: perTenantDocument() });
    const bound = new TenantBindingAuthorizer(cedar, 'b');
    const loopback = {
      action: 'request.loopback' as const,
      context: {
        phase: 'hostname' as const,
        target: 'localhost',
        addressClasses: ['loopback' as const],
        privateSources: [],
        tenantId: 'a',
      },
    };
    expect(bound.decide(loopback)).toMatchObject({ allowed: false, ruleMatched: 'default.deny' });
  });
});
