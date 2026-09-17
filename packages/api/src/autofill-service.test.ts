import { SecretManager } from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { AgentBrowserService } from './service.js';

function requireFakePage(engine: FakeEngine, pageId: string) {
  const sessionId = engine.getSessionIds()[0];
  if (!sessionId) throw new Error('Expected one engine session');
  const page = engine.getFakePage(sessionId, pageId);
  if (!page) throw new Error('Expected an engine page');
  return page;
}

it('reports approval refusal before engine dispatch as a known field failure', async () => {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({ engine, approvalPolicy: { unknownRisk: 'required' } });
  try {
    const session = await service.createSession({ tenantId: 'owner' });
    const page = await service.createPage(session.sessionId);
    const raw = requireFakePage(engine, page.pageId);
    raw.seedElements([
      {
        ref: 'company',
        role: 'textbox',
        name: 'Company',
        attributes: {
          tag: 'input',
          type: 'text',
          'autofill-node': 'company',
          'autofill-block': '',
        },
      },
    ]);
    const writes = vi.spyOn(raw, 'act');
    const report = await service.autofill(session.sessionId, page.pageId, {
      fields: [{ match: { label: 'Company' }, value: 'blocked' }],
      policy: { settleMs: 0 },
    });
    expect(report).toMatchObject({
      ok: false,
      receipts: [{ status: 'failed', verified: false }],
    });
    expect(writes).not.toHaveBeenCalled();
  } finally {
    await service.shutdown();
  }
});

it('reports an engine rejection after the dispatch seam as uncertain', async () => {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({ engine });
  try {
    const session = await service.createSession({ tenantId: 'owner' });
    const page = await service.createPage(session.sessionId);
    const raw = requireFakePage(engine, page.pageId);
    raw.seedElements([
      {
        ref: 'company',
        role: 'textbox',
        name: 'Company',
        attributes: {
          tag: 'input',
          type: 'text',
          'autofill-node': 'company',
          'autofill-block': '',
        },
      },
    ]);
    const writes = vi.spyOn(raw, 'act').mockRejectedValue(new Error('engine transport closed'));
    const report = await service.autofill(session.sessionId, page.pageId, {
      fields: [{ match: { label: 'Company' }, value: 'possibly written' }],
      policy: { settleMs: 0 },
    });
    expect(report).toMatchObject({
      ok: false,
      receipts: [{ status: 'uncertain', verified: false }],
    });
    expect(writes).toHaveBeenCalledOnce();
  } finally {
    await service.shutdown();
  }
});

it('does not confuse redacted display values with private verification evidence', async () => {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({
    engine,
    secretManager: new SecretManager({ 'vault://test': 'registered-secret' }),
  });
  try {
    const session = await service.createSession({ tenantId: 'owner' });
    const page = await service.createPage(session.sessionId);
    const raw = requireFakePage(engine, page.pageId);
    raw.seedElements([
      {
        ref: 'company',
        role: 'textbox',
        name: 'Company',
        attributes: {
          tag: 'input',
          type: 'text',
          'autofill-node': 'company',
          'autofill-block': '',
        },
      },
    ]);
    const original = raw.act.bind(raw);
    const writes = vi
      .spyOn(raw, 'act')
      .mockImplementation((action) => original({ ...action, value: 'registered-secret' }));
    const report = await service.autofill(session.sessionId, page.pageId, {
      fields: [{ match: { label: 'Company' }, value: '***' }],
      policy: { settleMs: 0 },
    });
    expect(report.ok).toBe(false);
    expect(report.receipts[0]).toMatchObject({ status: 'failed', verified: false, actual: '***' });
    expect(JSON.stringify(report)).not.toContain('registered-secret');
    expect(writes).toHaveBeenCalledOnce();
  } finally {
    await service.shutdown();
  }
});

it('stops the suffix and withholds output when the human takes over during a field', async () => {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({ engine });
  const operator = { actor: 'operator' as const, tenant: 'owner' };
  const session = await service.createSession({ tenantId: 'owner', controlMode: 'delegated' });
  try {
    const page = await service.authority.run(session.sessionId, operator, {}, () =>
      service.createPage(session.sessionId)
    );
    if ('replay' in page) throw new Error('Unexpected replay');
    const raw = requireFakePage(engine, page.pageId);
    raw.seedElements([
      {
        ref: 'company',
        role: 'textbox',
        name: 'Company',
        attributes: {
          tag: 'input',
          type: 'text',
          'autofill-node': 'company',
          'autofill-block': '',
        },
      },
    ]);
    const original = raw.act.bind(raw);
    const writes = vi.spyOn(raw, 'act').mockImplementation(async (action) => {
      const result = await original(action);
      service.authority.takeover(session.sessionId);
      return result;
    });
    const control = service.authority.get(session.sessionId);
    if (!control) throw new Error('Expected session control');
    const review = control.prepareResume();
    const grant = service.authority.delegate(session.sessionId, review.epoch);
    const principal = service.authority.authenticate(grant.token);
    if (!principal) throw new Error('Expected delegated principal');
    await expect(
      service.authority.run(session.sessionId, principal, { id: 'bulk', fingerprint: 'bulk' }, () =>
        service.autofill(session.sessionId, page.pageId, {
          fields: [
            { match: { label: 'Company' }, value: 'first' },
            { match: { label: 'Company' }, value: 'second' },
          ],
          policy: { settleMs: 0 },
        })
      )
    ).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
    expect(writes).toHaveBeenCalledOnce();
  } finally {
    await service.shutdown();
  }
});

it('resolves vault fill references for private comparison before any browser I/O', async () => {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({
    engine,
    secretManager: new SecretManager({ 'vault://candidate-email': 'candidate@example.test' }),
  });
  try {
    const session = await service.createSession({ tenantId: 'owner' });
    const page = await service.createPage(session.sessionId);
    const raw = requireFakePage(engine, page.pageId);
    raw.seedElements([
      {
        ref: 'email',
        role: 'textbox',
        name: 'Email',
        attributes: { tag: 'input', type: 'email', 'autofill-node': 'email', 'autofill-block': '' },
      },
    ]);
    const writes = vi.spyOn(raw, 'act');
    const report = await service.autofill(session.sessionId, page.pageId, {
      fields: [{ match: { label: 'Email' }, value: 'vault://candidate-email' }],
      policy: { settleMs: 0 },
    });
    expect(report).toMatchObject({ ok: true, receipts: [{ verified: true, actual: '***' }] });
    expect(writes).toHaveBeenCalledOnce();
    writes.mockClear();
    const observes = vi.spyOn(raw, 'observe');
    await expect(
      service.autofill(session.sessionId, page.pageId, {
        fields: [
          { match: { label: 'Email' }, value: 'normal' },
          { match: { label: 'Email' }, value: 'vault://missing' },
        ],
      })
    ).rejects.toThrow();
    expect(writes).not.toHaveBeenCalled();
    expect(observes).not.toHaveBeenCalled();
  } finally {
    await service.shutdown();
  }
});
