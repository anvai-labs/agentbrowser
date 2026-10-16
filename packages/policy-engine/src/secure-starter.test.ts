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
    ['unknown', 'required'],
  ] as const)('an action with effect %s is %s', (effect, mode) => {
    expect(approvalModeOf(loaded.authorizer, { effect })).toBe(mode);
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

  it('keeps every rule id in the operator namespace and declares unknownRisk required', () => {
    expect(loaded.document.unknownRisk).toBe('required');
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
