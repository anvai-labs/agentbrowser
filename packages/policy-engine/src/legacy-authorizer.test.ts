import { type ApprovalMode, legacyApprovalMode } from '@agentbrowser/core';
import type { ActionEffectType } from '@agentbrowser/protocol';
import { describe, expect, it } from 'vitest';
import { approvalModeOf } from './authorizer.js';
import { LegacyAuthorizer } from './legacy-authorizer.js';

// TD-BROWSER-15 phase 1: today's operator approval outcome, behind the
// Authorizer seam, as ADR-024 §5's two questions (act, act.unattended).

const EFFECTS: Array<ActionEffectType | 'unknown'> = [
  'read',
  'write-local',
  'transaction',
  'account-security',
  'external-message',
  'destructive',
  'unknown',
];
const DECISIONS: Array<ApprovalMode | undefined> = [undefined, 'allow', 'required', 'deny'];

describe('LegacyAuthorizer', () => {
  it('reproduces legacyApprovalMode for every effect, rule decision and unknownRisk', () => {
    for (const unknownRisk of ['allow', 'required'] as const) {
      const authorizer = new LegacyAuthorizer({ unknownRisk });
      for (const effect of EFFECTS) {
        for (const decision of DECISIONS) {
          const rule = decision === undefined ? { id: 'rule-0' } : { id: 'pay-button', decision };
          for (const matched of [undefined, rule]) {
            const context = { effect, ...(matched ? { rule: matched } : {}) };
            const expected = legacyApprovalMode(effect, matched?.decision, unknownRisk);
            expect(approvalModeOf(authorizer, context)).toBe(expected);
          }
        }
      }
    }
  });

  it('names the deciding rule: an operator rule, unknownRisk, or the effect default', () => {
    const authorizer = new LegacyAuthorizer({ unknownRisk: 'required' });
    expect(
      authorizer.decide({
        action: 'act',
        context: { effect: 'transaction', rule: { id: 'pay-button', decision: 'deny' } },
      })
    ).toEqual({
      allowed: false,
      reason: 'operator rule pay-button: deny',
      ruleMatched: 'env.approval.pay-button',
    });
    expect(
      authorizer.decide({ action: 'act.unattended', context: { effect: 'unknown' } })
    ).toMatchObject({ allowed: false, ruleMatched: 'env.approval.unknown-risk' });
    expect(
      authorizer.decide({ action: 'act.unattended', context: { effect: 'destructive' } })
    ).toMatchObject({ allowed: false, ruleMatched: 'env.approval.high-risk' });
    expect(
      authorizer.decide({ action: 'act.unattended', context: { effect: 'read' } })
    ).toMatchObject({ allowed: true, ruleMatched: 'env.approval.default' });
  });

  it('allows every action to run unless an operator rule denies it', () => {
    const authorizer = new LegacyAuthorizer({});
    for (const effect of EFFECTS) {
      expect(authorizer.decide({ action: 'act', context: { effect } }).allowed).toBe(true);
    }
  });

  it('has a stable version', () => {
    expect(new LegacyAuthorizer({}).version).toBe('legacy');
  });
});

describe('LegacyAuthorizer capability grants', () => {
  it('grants every capability a session requests, as today', () => {
    const authorizer = new LegacyAuthorizer({});
    for (const action of [
      'downloads',
      'serviceWorkers',
      'cookie.seed',
      'cookie.export',
      'session.headed',
    ] as const) {
      expect(authorizer.decide({ action, context: { tenantId: 't1' } })).toEqual({
        allowed: true,
        reason: 'granted on request; no policy file is loaded',
        ruleMatched: 'env.capability.default',
      });
    }
  });
});
