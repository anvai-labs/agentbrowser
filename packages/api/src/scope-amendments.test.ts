import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { EngagementLedger } from './engagement-ledger.js';
import { AgentBrowserService } from './service.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
const operator = { actor: 'human-operator' as const, tenant: 'one' };
const amendment = {
  expectedRevision: 0,
  assetHosts: [{ host: 'cdn.test', class: 'asset' as const }],
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'scope-amend-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const engine = new FakeEngine();
  const capabilities = await engine.capabilities();
  vi.spyOn(engine, 'capabilities').mockResolvedValue({
    ...capabilities,
    assetRequestClassification: true,
  });
  const service = new AgentBrowserService({
    engine,
    engagement: { directory, maxBytes: 1024 * 1024 },
  });
  cleanups.push(() => service.shutdown());
  const session = await service.createSession({
    tenantId: 'one',
    scope: { allowedHosts: ['app.test'], ledger: true, requestBudget: 100 },
  });
  const page = await service.createPage(session.sessionId);
  return { service, session, page, directory };
}
it('rejects API authority, cross-tenant, unknown fields and stale/concurrent revisions', async () => {
  const f = await fixture();
  await expect(
    f.service.amendScopeAssets(f.session.sessionId, amendment, { actor: 'operator', tenant: 'one' })
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(
    f.service.amendScopeAssets(f.session.sessionId, amendment, {
      actor: 'human-operator',
      tenant: 'other',
    })
  ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  await expect(
    f.service.amendScopeAssets(
      f.session.sessionId,
      { ...amendment, allowedHosts: ['evil.test'] } as never,
      operator
    )
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  const results = await Promise.allSettled([
    f.service.amendScopeAssets(f.session.sessionId, amendment, operator),
    f.service.amendScopeAssets(
      f.session.sessionId,
      { expectedRevision: 0, assetHosts: [{ host: 'other.test', class: 'asset' }] },
      operator
    ),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(f.service.getScopeStatus(f.session.sessionId)).toMatchObject({
    revision: 1,
    allowedHosts: ['app.test'],
    budget: { limit: 100 },
  });
  expect((await f.service.listPages(f.session.sessionId))[0]?.pageId).toBe(f.page.pageId);
  await f.service.closeSession(f.session.sessionId);
  const files = await readdir(f.directory, { recursive: true });
  const ledger = await readFile(
    join(f.directory, files.find((p) => p.endsWith('.jsonl'))!),
    'utf8'
  );
  expect(ledger).toContain('scope.amendment.authorized');
  expect(ledger).toContain('scope.amendment.completed');
});
it('activates no host if the critical authorization write fails', async () => {
  const f = await fixture();
  vi.spyOn(EngagementLedger.prototype, 'appendCritical').mockRejectedValue(
    new Error('disk failed')
  );
  await expect(
    f.service.amendScopeAssets(f.session.sessionId, amendment, operator)
  ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(f.service.getScopeStatus(f.session.sessionId).assetHosts).toBeUndefined();
  expect(f.service.getScopeStatus(f.session.sessionId).stopped).toBeDefined();
});
