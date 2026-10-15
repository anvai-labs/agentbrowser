import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicyFile } from '@agentbrowser/policy-engine';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentBrowserService } from './service.js';

/**
 * TD-15 phase-7 docs review, finding 2: the approval seam is tenant-bound
 * when keys configure tenants. A per-tenant act rule must match enforcement,
 * and enforcement must agree with the check route's answer.
 */

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'approval-tenant-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
const sha = (key: string) => createHash('sha256').update(key).digest('hex');

it('a per-tenant act rule decides enforcement for that tenant only', async () => {
  const path = join(dir, 'per-tenant-act.json');
  await writeFile(
    path,
    JSON.stringify({
      version: 'agentbrowser-policy/v1',
      unknownRisk: 'allow',
      approvalRules: [],
      policies: [
        {
          key: 'operator.ci-strict#1',
          ruleId: 'operator.ci-strict',
          cedar:
            '@rule("operator.ci-strict") forbid(principal, action == AgentBrowser::Action::"act", resource) when { principal in AgentBrowser::Tenant::"ci" };',
        },
        {
          key: 'operator.default#2',
          ruleId: 'operator.default',
          cedar:
            '@rule("operator.default") permit(principal, action in [AgentBrowser::Action::"act", AgentBrowser::Action::"act.unattended"], resource) when { !(principal in AgentBrowser::Tenant::"ci") };',
        },
      ],
    })
  );
  const loaded = await loadPolicyFile(path, { apiKeysConfigured: true });
  const service = new AgentBrowserService({
    engine: new FakeEngine(),
    authorizer: loaded.authorizer,
    policyVersion: loaded.authorizer.version,
    tenantsConfigured: true,
  });
  try {
    // Tenant "other": act flows normally (an unknown-risk action is allowed).
    const other = await service.createSession({ tenantId: 'other' });
    const otherPage = (await service.createPage(other.sessionId)).pageId;
    // 'wait' needs no element ref; every action still passes the approval seam.
    await service.act(other.sessionId, otherPage, { action: 'wait', condition: { until: 'load' } });
    await service.closeSession(other.sessionId);

    // Tenant "ci": every act is denied by the per-tenant rule.
    const ci = await service.createSession({ tenantId: 'ci' });
    const ciPage = (await service.createPage(ci.sessionId)).pageId;
    await expect(
      service.act(ci.sessionId, ciPage, { action: 'wait', condition: { until: 'load' } })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await service.closeSession(ci.sessionId);
  } finally {
    await service.shutdown();
  }
});
