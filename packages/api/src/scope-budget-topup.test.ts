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
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'topup-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const engine = new FakeEngine();
  const create = vi.spyOn(engine, 'createSession');
  const service = new AgentBrowserService({ engine, engagement: { directory } });
  cleanups.push(() => service.shutdown());
  const session = await service.createSession({
    tenantId: 'one',
    scope: { allowedHosts: ['app.test'], allowedMethods: ['GET'], ledger: true, requestBudget: 1 },
  });
  const page = await service.createPage(session.sessionId);
  return { directory, engine, service, session, page, options: create.mock.calls[0]![0]! };
}
it('preserves live pages/spending, serializes grants, refuses API/cross-tenant/unknown inputs, and audits both phases', async () => {
  const f = await fixture();
  const request = { expectedRevision: 0, requestBudget: 10 };
  await f.options.requestPolicy!.checkRequest({
    hostname: 'app.test',
    url: 'https://app.test/',
    method: 'GET',
  });
  await expect(
    f.service.topUpScopeBudget(f.session.sessionId, request, { actor: 'operator', tenant: 'one' })
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(
    f.service.topUpScopeBudget(f.session.sessionId, request, { ...operator, tenant: 'two' })
  ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  await expect(
    f.service.topUpScopeBudget(
      f.session.sessionId,
      { ...request, allowedMethods: ['PUT'] } as never,
      operator
    )
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  const results = await Promise.allSettled([
    f.service.topUpScopeBudget(f.session.sessionId, request, operator),
    f.service.topUpScopeBudget(f.session.sessionId, request, operator),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(f.service.getScopeStatus(f.session.sessionId)).toMatchObject({
    revision: 1,
    budget: { limit: 10, spent: 1, remaining: 9 },
  });
  expect((await f.service.listPages(f.session.sessionId))[0]?.pageId).toBe(f.page.pageId);
  await expect(
    f.options.requestPolicy!.checkRequest({
      hostname: 'app.test',
      url: 'https://app.test/',
      method: 'PUT',
    })
  ).rejects.toMatchObject({ details: { scope: 'SCOPE_METHOD_DENIED' } });
  await f.service.closeSession(f.session.sessionId);
  const files = await readdir(f.directory, { recursive: true });
  const ledger = await readFile(
    join(f.directory, files.find((p) => p.endsWith('.jsonl'))!),
    'utf8'
  );
  expect(ledger).toContain('scope.budget.authorized');
  expect(ledger).toContain('scope.budget.completed');
});
it('does not grant on failed persistence and stops the scope', async () => {
  const f = await fixture();
  vi.spyOn(EngagementLedger.prototype, 'appendCritical').mockRejectedValue(new Error('disk'));
  await expect(
    f.service.topUpScopeBudget(
      f.session.sessionId,
      { expectedRevision: 0, requestBudget: 10 },
      operator
    )
  ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(f.service.getScopeStatus(f.session.sessionId)).toMatchObject({
    budget: { limit: 1 },
    stopped: expect.any(String),
  });
});
it('warns from page-attributed tenant history and exposes the denied method matrix', async () => {
  const f = await fixture();
  const other = await f.service.createPage(f.session.sessionId);
  const raw = f.engine.getFakePage(f.engine.getSessionIds()[0]!, f.page.pageId)!;
  const sibling = f.engine.getFakePage(f.engine.getSessionIds()[0]!, other.pageId)!;
  vi.spyOn(raw, 'navigate').mockImplementation(async () => {
    const delivered = new Promise<void>((resolve) => {
      const off = f.service.subscribe(f.session.sessionId, (event) => {
        if (event.pageId === f.page.pageId && event.data?.last) {
          off?.();
          resolve();
        }
      });
    });
    sibling.emitEvent('request.finished', { method: 'GET', url: 'https://app.test/other' });
    for (let i = 0; i < 150; i++)
      raw.emitEvent('request.finished', {
        method: 'GET',
        url: 'https://app.test/chunk',
        ...(i === 149 ? { last: true } : {}),
      });
    await delivered;
    return { status: 'success', url: 'https://app.test/', redirectChain: [] };
  });
  await f.service.navigate(f.session.sessionId, f.page.pageId, { url: 'https://app.test/' });
  f.options.requestRecorder!({
    type: 'request.failed',
    timestamp: new Date().toISOString(),
    data: { method: 'PUT', url: 'https://app.test/api', scope: 'SCOPE_METHOD_DENIED' },
  });
  expect(f.service.getScopeTraffic(f.session.sessionId).rows).toContainEqual({
    method: 'PUT',
    hostClass: 'program',
    requests: 1,
    denied: 1,
  });
  const next = await f.service.createSession({
    tenantId: 'one',
    scope: { allowedHosts: ['app.test'], requestBudget: 200 },
  });
  expect(next.warnings?.join('\n')).toContain('750');
  const isolated = await f.service.createSession({
    tenantId: 'two',
    scope: { allowedHosts: ['app.test'], requestBudget: 200 },
  });
  expect(isolated.warnings?.join('\n') ?? '').not.toContain('median');
});

it('discards expired navigation samples rather than falling back to the local tenant', async () => {
  const { SessionCoordinator } = await import('@agentbrowser/core');
  let now = 100000;
  const engine = new FakeEngine();
  const coordinator = new SessionCoordinator({ now: () => now, cleanupCheckIntervalMs: 3600000 });
  const service = new AgentBrowserService({ engine, coordinator, sweepIntervalMs: 0 });
  cleanups.push(() => service.shutdown());
  const session = await service.createSession({
    tenantId: 'private-tenant',
    ttlMs: 1000,
    scope: { allowedHosts: ['app.test'] },
  });
  const page = await service.createPage(session.sessionId);
  const raw = engine.getFakePage(engine.getSessionIds()[0]!, page.pageId)!;
  vi.spyOn(raw, 'navigate').mockImplementation(async () => {
    const delivered = new Promise<void>((resolve) => {
      const off = service.subscribe(session.sessionId, (event) => {
        if (event.pageId === page.pageId && event.data?.last) {
          off?.();
          resolve();
        }
      });
    });
    for (let i = 0; i < 150; i++) raw.emitEvent('request.finished', { last: i === 149 });
    await delivered;
    now += 2000;
    return { status: 'success', url: 'https://app.test/', redirectChain: [] };
  });
  await service.navigate(session.sessionId, page.pageId, { url: 'https://app.test/' });
  for (const tenantId of [undefined, 'private-tenant']) {
    const local = await service.createSession({
      ...(tenantId ? { tenantId } : {}),
      scope: { allowedHosts: ['app.test'], requestBudget: 100 },
    });
    expect(local.warnings?.join('\n') ?? '').not.toContain('median');
  }
});
it('refuses traffic fingerprinting on engines without request recording', async () => {
  const engine = new FakeEngine();
  const caps = await engine.capabilities();
  vi.spyOn(engine, 'capabilities').mockResolvedValue({ ...caps, requestRecording: false });
  const service = new AgentBrowserService({ engine });
  cleanups.push(() => service.shutdown());
  const session = await service.createSession({
    trace: 'off',
    scope: { allowedHosts: ['app.test'] },
  });
  expect(() => service.getScopeTraffic(session.sessionId)).toThrow(
    expect.objectContaining({ code: 'ENGINE_UNSUPPORTED' })
  );
});
