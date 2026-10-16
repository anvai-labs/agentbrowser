/**
 * The shipped secure starter policy (examples/policy/secure-starter.json) loads through the real
 * loader — strict Cedar validation and every startup refusal — and makes exactly the decisions
 * docs/policy.md promises operators. If a decision here changes, the docs table must change too.
 */
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { approvalModeOf, egressExceptionsOf } from './authorizer.js';
import { type LoadedPolicy, loadPolicyFile } from './policy-file.js';

const STARTER = fileURLToPath(
  new URL('../../../examples/policy/secure-starter.json', import.meta.url)
);

let loaded: LoadedPolicy;
beforeAll(async () => {
  loaded = await loadPolicyFile(STARTER, { apiKeysConfigured: false }, {});
});

describe('secure starter policy', () => {
  it.each([
    ['read', 'allow'],
    ['write-local', 'allow'],
    ['transaction', 'required'],
    ['account-security', 'required'],
    ['external-message', 'required'],
    ['destructive', 'required'],
    ['unknown', 'allow'],
  ] as const)('an action with effect %s is %s', (effect, mode) => {
    expect(approvalModeOf(loaded.authorizer, { effect })).toBe(mode);
  });

  it('names the deciding rule for unattended high-risk actions and egress exceptions', () => {
    const unattended = loaded.authorizer.decide({
      action: 'act.unattended',
      context: { effect: 'transaction' },
    });
    expect(unattended.allowed).toBe(false);
    expect(JSON.stringify(unattended)).toContain('operator.act.high-risk-needs-approval');
    const loopback = loaded.authorizer.decide({
      action: 'request.loopback',
      context: {
        phase: 'resolved',
        target: '127.0.0.1',
        addressClasses: ['loopback'],
        privateSources: [],
      } as never,
    });
    expect(JSON.stringify(loopback)).toContain('operator.no-loopback');
    const privateRange = loaded.authorizer.decide({
      action: 'request.private',
      context: {
        phase: 'resolved',
        target: '10.1.2.3',
        addressClasses: ['private'],
        privateSources: [{ address: '10.1.2.3', type: 'ipv4' }],
      } as never,
    });
    expect(JSON.stringify(privateRange)).toContain('operator.no-private');
  });

  it('refuses loopback and private egress (no exceptions granted)', () => {
    const egress = egressExceptionsOf(loaded.authorizer);
    expect(
      egress.allowLoopback({
        phase: 'resolved',
        target: '127.0.0.1',
        addressClasses: ['loopback'],
        privateSources: [],
      } as never)
    ).toBe(false);
    expect(
      egress.allowPrivate({
        phase: 'resolved',
        target: '10.1.2.3',
        addressClasses: ['private'],
        privateSources: [{ address: '10.1.2.3', type: 'ipv4' }],
        ip: '10.1.2.3',
      } as never)
    ).toBe(false);
  });

  it.each([
    ['session.headed', true, 'operator.capability.headed'],
    ['cookie.seed', true, 'operator.capability.cookie-seed'],
    ['cookie.export', false, 'operator.capability.no-cookie-export'],
    ['serviceWorkers', false, 'operator.capability.no-service-workers'],
    ['downloads', false, 'operator.capability.no-downloads'],
    ['cdp.attach', false, 'operator.capability.no-cdp-attach'],
  ] as const)('capability %s → allowed=%s by %s', (action, allowed, rule) => {
    const decision = loaded.authorizer.decide({ action, context: {} });
    expect(decision.allowed).toBe(allowed);
    expect(JSON.stringify(decision)).toContain(rule);
  });

  it('refuses cookie handoff for every domain until an operator permits one', () => {
    const decision = loaded.authorizer.decide({
      action: 'cookie.handoff',
      context: { domain: 'example.com' },
    });
    expect(decision.allowed).toBe(false);
    expect(JSON.stringify(decision)).toContain('operator.capability.no-cookie-handoff');
  });

  it('keeps every rule id in the operator namespace', () => {
    expect(loaded.document.policies.every((p) => p.ruleId.startsWith('operator.'))).toBe(true);
  });
});

describe('the documented loosening recipes (docs/policy.md) work as written', () => {
  const loadWith = async (
    edit: (policies: Array<{ key: string; ruleId: string; cedar: string }>) => void,
    options: { apiKeysConfigured: boolean; keyTenants?: string[] }
  ) => {
    const { readFile, writeFile, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const doc = JSON.parse(await readFile(STARTER, 'utf8'));
    edit(doc.policies);
    const dir = await mkdtemp(join(tmpdir(), 'starter-'));
    try {
      const path = join(dir, 'policy.json');
      await writeFile(path, JSON.stringify(doc));
      return await loadPolicyFile(path, options, {});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  const replace = (
    policies: Array<{ key: string; ruleId: string; cedar: string }>,
    ruleId: string,
    cedar: string
  ) => {
    const entry = policies.find((p) => p.ruleId === ruleId);
    if (!entry) throw new Error(`no ${ruleId}`);
    entry.cedar = cedar;
  };

  it('downloads for tenant qa only: narrow the forbid, add a permit', async () => {
    const A = 'AgentBrowser::Action::';
    const qa = 'principal in AgentBrowser::Tenant::"qa"';
    const policy = await loadWith(
      (policies) => {
        replace(
          policies,
          'operator.capability.no-downloads',
          `@rule("operator.capability.no-downloads") forbid(principal, action == ${A}"downloads", resource) unless { ${qa} };`
        );
        policies.push({
          key: 'operator.qa.downloads',
          ruleId: 'operator.qa.downloads',
          cedar: `@rule("operator.qa.downloads") permit(principal, action == ${A}"downloads", resource) when { ${qa} };`,
        });
      },
      { apiKeysConfigured: true, keyTenants: ['qa', 'ops'] }
    );
    expect(
      policy.authorizer.decide({ action: 'downloads', context: { tenantId: 'qa' } }).allowed
    ).toBe(true);
    expect(
      policy.authorizer.decide({ action: 'downloads', context: { tenantId: 'ops' } }).allowed
    ).toBe(false);
  });

  it('one internal subnet: narrow operator.no-private by the same range, add a permit', async () => {
    const A = 'AgentBrowser::Action::';
    const range = 'context has ip && context.ip.isInRange(ip("10.20.0.0/16"))';
    const policy = await loadWith(
      (policies) => {
        replace(
          policies,
          'operator.no-private',
          `@rule("operator.no-private") forbid(principal, action == ${A}"request.private", resource) unless { ${range} };`
        );
        policies.push({
          key: 'operator.internal-subnet',
          ruleId: 'operator.internal-subnet',
          cedar: `@rule("operator.internal-subnet") permit(principal, action == ${A}"request.private", resource) when { ${range} };`,
        });
      },
      { apiKeysConfigured: false }
    );
    const egress = egressExceptionsOf(policy.authorizer);
    const at = (address: string) =>
      egress.allowPrivate({
        phase: 'resolved',
        target: address,
        addressClasses: ['private'],
        privateSources: [{ address, type: 'ipv4' }],
      } as never);
    expect(at('10.20.3.4')).toBe(true);
    expect(at('10.21.0.1')).toBe(false);
    expect(at('192.168.1.1')).toBe(false);
  });
});

describe('approval rules with a decision in a hand-written file', () => {
  const write = async (doc: unknown) => {
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'starter-decision-'));
    const path = join(dir, 'policy.json');
    await writeFile(path, JSON.stringify(doc));
    return path;
  };

  it('refuses a decision no policy reads (it would be silently ignored)', async () => {
    const { readFile } = await import('node:fs/promises');
    const doc = JSON.parse(await readFile(STARTER, 'utf8'));
    doc.approvalRules = [
      { id: 'no-tab', action: 'press', effect: 'write-local', decision: 'deny' },
    ];
    await expect(
      loadPolicyFile(await write(doc), { apiKeysConfigured: false }, {})
    ).rejects.toThrow(/"no-tab" carry a decision but no policy reads context\.matchedRule/);
  });

  it('accepts it once a policy keys on context.matchedRule, and the decision then applies', async () => {
    const { readFile } = await import('node:fs/promises');
    const doc = JSON.parse(await readFile(STARTER, 'utf8'));
    doc.approvalRules = [
      { id: 'no-tab', action: 'press', effect: 'write-local', decision: 'deny' },
    ];
    doc.policies.push({
      key: 'operator.rule.no-tab',
      ruleId: 'operator.rule.no-tab',
      cedar:
        '@rule("operator.rule.no-tab") forbid(principal, action in [AgentBrowser::Action::"act", AgentBrowser::Action::"act.unattended"], resource) when { context.matchedRule == "no-tab" };',
    });
    const policy = await loadPolicyFile(await write(doc), { apiKeysConfigured: false }, {});
    expect(
      approvalModeOf(policy.authorizer, {
        effect: 'write-local',
        rule: { id: 'no-tab', decision: 'deny' },
      })
    ).toBe('deny');
  });
});
