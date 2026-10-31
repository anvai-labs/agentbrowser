import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentBrowserService } from './service.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const state = {
  cookies: [{ name: 'auth', value: 'cookie-credential-value', domain: 'app.test', path: '/' }],
  origins: [
    {
      origin: 'https://app.test',
      localStorage: [{ name: 'auth', value: 'storage-credential-value' }],
    },
  ],
};
const request = {
  scope: { allowedHosts: ['app.test'], ledger: true },
  origins: ['https://app.test'],
};
const principal = { actor: 'human-operator' as const, tenant: 'one' };

async function fixture(
  seed = vi.fn(async () => {}),
  capture: () => Promise<typeof state> = async () => structuredClone(state)
) {
  const directory = await mkdtemp(join(tmpdir(), 'evidence-pass-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const engine = new FakeEngine();
  const original = engine.createSession.bind(engine);
  vi.spyOn(engine, 'createSession').mockImplementation(async (options) => {
    const session = await original(options);
    return Object.assign(session, { captureEvidenceState: capture, seedEvidenceState: seed });
  });
  const service = new AgentBrowserService({
    engine,
    engagement: { directory, maxBytes: 1024 * 1024 },
    authorizer: {
      version: 'test',
      decide: () => ({ allowed: true, reason: 'test', rulesMatched: [] }),
    },
  });
  cleanup.push(() => service.shutdown());
  const source = await service.createSession({ tenantId: 'one' });
  return { service, source, seed, directory };
}

it('requires human operator authority and same-tenant source', async () => {
  const { service, source, seed } = await fixture();
  await expect(
    service.createEvidenceSession(source.sessionId, request, { actor: 'operator', tenant: 'one' })
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(
    service.createEvidenceSession(source.sessionId, request, {
      actor: 'human-operator',
      tenant: 'other',
    })
  ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  await expect(
    service.createEvidenceSession(
      source.sessionId,
      { ...request, scope: { ...request.scope, ledger: false } },
      principal
    )
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(seed).not.toHaveBeenCalled();
});

it('copies both state classes and writes hash/count evidence without credential values', async () => {
  const { service, source, seed, directory } = await fixture();
  const target = await service.createEvidenceSession(source.sessionId, request, principal);
  expect(seed).toHaveBeenCalledWith(state);
  await expect(service.getSessionCookies(target.sessionId)).rejects.toMatchObject({
    code: 'HANDOFF_COOKIES_NOT_EXPORTABLE',
  });
  await service.closeSession(target.sessionId);
  const files = await readdir(directory, { recursive: true });
  const ledger = await readFile(join(directory, files.find((f) => f.endsWith('.jsonl'))!), 'utf8');
  expect(ledger).toContain('state.transfer.prepared');
  expect(ledger).toContain('state.transfer.completed');
  expect(ledger).not.toMatch(/cookie-credential-value|storage-credential-value/);
});

it('hides the target until seeding completes and closes it on partial failure', async () => {
  let enter!: () => void;
  let fail!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const release = new Promise<void>((resolve) => {
    fail = resolve;
  });
  const f = await fixture(
    vi.fn(async () => {
      enter();
      await release;
      throw new Error('private-token');
    })
  );
  const creating = f.service.createEvidenceSession(f.source.sessionId, request, principal);
  const rejected = expect(creating).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  await entered;
  expect(f.service.listSessions().map((s) => s.sessionId)).toEqual([f.source.sessionId]);
  fail();
  await rejected;
  expect(f.service.listSessions().map((s) => s.sessionId)).toEqual([f.source.sessionId]);
});

it('aborts a hung capture when the source closes and leaves no hidden target', async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = await fixture(
    vi.fn(async () => {}),
    async () => {
      entered();
      return new Promise(() => {});
    }
  );
  const creating = f.service.createEvidenceSession(f.source.sessionId, request, principal);
  const rejected = expect(creating).rejects.toMatchObject({ code: 'ACTION_TIMEOUT' });
  await ready;
  await f.service.closeSession(f.source.sessionId);
  await rejected;
  expect(f.service.listSessions()).toEqual([]);
});
