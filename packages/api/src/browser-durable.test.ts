/**
 * T5 B-dur-2b: durable browser operations through the service, on a REAL journal store.
 *
 * The HTTP wrapper turns `executionRequirement: 'durable'` into a browser journal selection and
 * runs the route under it; these tests run the same selection directly so a hook can change the
 * page DURING the marker's storage wait (a delegating journal whose markDispatch runs a callback
 * before it is acknowledged). One record per operation; the recheck runs after the marker; a stale
 * target or approval crosses no effect; known failures keep their report.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationJournal } from '@agentbrowser/control';
import { ApprovalGate } from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { journalConfigFromEnvironment, openServiceJournal } from './journal-config.js';
import { AgentBrowserService, browserReportOutcomeUnknown } from './service.js';

const operator = { actor: 'operator' as const, tenant: 'owner' };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function fixture(options: { approvals?: boolean } = {}) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'bdur2b-'));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, 'store'), { mode: 0o700 });
  mkdirSync(join(base, 'anchor'), { mode: 0o700 });
  writeFileSync(join(base, 'key'), `key-1:${'2b'.repeat(32)}\n`, { mode: 0o600 });
  const config = await journalConfigFromEnvironment({
    AGENTBROWSER_JOURNAL_DIR: join(base, 'store'),
    AGENTBROWSER_JOURNAL_ANCHOR_DIR: join(base, 'anchor'),
    AGENTBROWSER_JOURNAL_KEY_FILE: join(base, 'key'),
    AGENTBROWSER_JOURNAL_RESTORE_GENERATION: 'generation-1',
    AGENTBROWSER_JOURNAL_ACCEPT_UNTIL: '2099-01-01T00:00:00Z',
    AGENTBROWSER_JOURNAL_INITIALIZE: '1',
  });
  if (!config) throw new Error('expected configuration');
  const opened = await openServiceJournal(config);
  const real = opened.journal;
  // A delegating view: the marker's storage wait can run a page change before it completes.
  let onMarker: (() => void | Promise<void>) | undefined;
  const journal: OperationJournal = Object.freeze({
    get namespace() {
      return real.namespace;
    },
    get health() {
      return real.health;
    },
    get pending() {
      return real.pending;
    },
    reserveIntent: real.reserveIntent.bind(real),
    markDispatch: (transition, signal) => {
      const call = (async () => {
        await onMarker?.();
        return real.markDispatch(transition, signal);
      })();
      return Object.assign(call, { settled: call.then(() => undefined) }) as never;
    },
    commitTerminal: real.commitTerminal.bind(real),
    lookup: real.lookup.bind(real),
    findByOperation: real.findByOperation.bind(real),
    close: real.close.bind(real),
  });
  const engine = new FakeEngine();
  const gate = new ApprovalGate();
  const service = new AgentBrowserService({
    engine,
    operationJournal: journal,
    approvalGate: gate,
    ...(options.approvals ? { approvalPolicy: { unknownRisk: 'required' as const } } : {}),
  });
  cleanup.push(async () => {
    await service.shutdown();
    await opened.close();
  });
  const { sessionId } = await service.createSession({
    tenantId: 'owner',
    controlMode: 'delegated',
  });
  const run = <T>(read: () => Promise<T>) =>
    service.authority.run(sessionId, operator, {}, read) as Promise<T>;
  const { pageId } = await run(() => service.createPage(sessionId));
  const raw = engine.getFakePage(engine.getSessionIds()[0] ?? '', pageId);
  if (!raw) throw new Error('Expected an engine page');
  await raw.navigate({ url: 'https://example.com/form' });
  const refOf = async (name: string) => {
    const view = await run(() => service.observe(sessionId, pageId, {}));
    const element = view.elements.find((candidate) => candidate.name === name);
    if (!element) throw new Error(`No element named ${name}`);
    return element.ref;
  };
  /** Runs `work` exactly as the HTTP wrapper runs a `durable` browser route. */
  const durable = <T>(
    kind: 'act' | 'plan' | 'autofill',
    id: string,
    work: () => Promise<T>,
    failed: () => boolean | 'rejected' = () => false
  ) =>
    service.authority.run(
      sessionId,
      operator,
      {
        id,
        fingerprint: `digest-${id}`,
        journal: {
          version: 1,
          application: { adapterId: 'browser', resourceId: kind, bindingGeneration: pageId },
          durable: true,
          browser: true,
        },
      },
      work,
      failed
    );
  const records = async (operationId: string) => {
    const found = await real.findByOperation({ tenantId: 'owner', operationId, limit: 16 });
    if (found.kind !== 'found') throw new Error('expected records');
    return found.records.map((record) => ({
      revision: record.revision,
      dispatched: record.dispatched,
      status: record.terminal?.status,
      kind: record.identity.application?.resourceId,
    }));
  };
  const setMarker = (hook: typeof onMarker) => {
    onMarker = hook;
  };
  return { service, gate, raw, sessionId, pageId, refOf, durable, records, setMarker, run };
}

describe('durable act (B-dur-2b)', () => {
  it('journals one browser/act record and dispatches once', async () => {
    const f = await fixture();
    f.raw.setElements([{ role: 'button', name: 'Save' }]);
    const ref = await f.refOf('Save');
    const dispatched: string[] = [];
    const act = f.raw.act.bind(f.raw);
    f.raw.act = async (action) => {
      dispatched.push(action.type);
      return act(action);
    };
    await f.durable('act', 'save-1', () =>
      f.service.act(f.sessionId, f.pageId, { action: 'click', target: { ref } })
    );
    expect(dispatched).toEqual(['click']);
    expect(await f.records('save-1')).toEqual([
      { revision: 3, dispatched: true, status: 'completed', kind: 'act' },
    ]);
  }, 60_000);

  it('a target changed during the marker wait crosses no effect: STALE_TARGET, failed dispatched', async () => {
    const f = await fixture();
    f.raw.setElements([{ role: 'button', name: 'Save' }]);
    const ref = await f.refOf('Save');
    let effects = 0;
    const act = f.raw.act.bind(f.raw);
    f.raw.act = async (action) => {
      effects += 1;
      return act(action);
    };
    f.setMarker(() => {
      // The page re-renders the target as a different control during the storage wait.
      f.raw.setElements([{ role: 'button', name: 'Delete account' }]);
    });
    await expect(
      f.durable('act', 'stale-1', () =>
        f.service.act(f.sessionId, f.pageId, { action: 'click', target: { ref } })
      )
    ).rejects.toMatchObject({ code: 'STALE_TARGET' });
    expect(effects).toBe(0);
    expect(await f.records('stale-1')).toEqual([
      { revision: 3, dispatched: true, status: 'failed', kind: 'act' },
    ]);
  }, 60_000);

  it('an approval round trip is decided before any marker: failed_before_dispatch', async () => {
    const f = await fixture({ approvals: true });
    f.raw.setElements([{ role: 'button', name: 'Pay', risk: 'transaction' }]);
    const ref = await f.refOf('Pay');
    let markers = 0;
    f.setMarker(() => {
      markers += 1;
    });
    await expect(
      f.durable('act', 'needs-approval', () =>
        f.service.act(f.sessionId, f.pageId, { action: 'click', target: { ref } })
      )
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(markers).toBe(0);
    expect(await f.records('needs-approval')).toEqual([
      { revision: 2, dispatched: false, status: 'failed', kind: 'act' },
    ]);
  }, 60_000);

  const approvalFixture = async () => {
    const f = await fixture({ approvals: true });
    f.raw.setElements([{ role: 'button', name: 'Pay', risk: 'transaction' }]);
    const ref = await f.refOf('Pay');
    const refused = await f
      .run(() => f.service.act(f.sessionId, f.pageId, { action: 'click', target: { ref } }))
      .then(
        () => undefined,
        (error: { details?: { tokenId?: string } }) => error
      );
    const tokenId = refused?.details?.tokenId;
    if (typeof tokenId !== 'string') throw new Error('expected an approval token');
    const order: string[] = [];
    const consume = f.gate.consumeApprovalToken.bind(f.gate);
    f.gate.consumeApprovalToken = async (id, request) => {
      order.push('consume');
      return consume(id, request);
    };
    let effects = 0;
    const act = f.raw.act.bind(f.raw);
    f.raw.act = async (action) => {
      effects += 1;
      order.push('effect');
      return act(action);
    };
    return { ...f, ref, tokenId, order, effects: () => effects };
  };

  it('the approval is consumed only AFTER the marker, then the effect runs', async () => {
    const f = await approvalFixture();
    f.setMarker(() => {
      f.order.push('marker');
    });
    await f.durable('act', 'pay-ok', () =>
      f.service.act(f.sessionId, f.pageId, {
        action: 'click',
        target: { ref: f.ref },
        approvalToken: f.tokenId,
      })
    );
    expect(f.order).toEqual(['marker', 'consume', 'effect']);
    expect(await f.records('pay-ok')).toEqual([
      { revision: 3, dispatched: true, status: 'completed', kind: 'act' },
    ]);
  }, 60_000);

  it('an approval spent during the marker wait crosses no effect: APPROVAL_REQUIRED, failed dispatched', async () => {
    const f = await approvalFixture();
    f.setMarker(async () => {
      // A concurrent use spends the token during the storage wait.
      await f.gate.useApprovalToken(f.tokenId);
    });
    await expect(
      f.durable('act', 'pay-spent', () =>
        f.service.act(f.sessionId, f.pageId, {
          action: 'click',
          target: { ref: f.ref },
          approvalToken: f.tokenId,
        })
      )
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(f.effects()).toBe(0);
    expect(await f.records('pay-spent')).toEqual([
      { revision: 3, dispatched: true, status: 'failed', kind: 'act' },
    ]);
  }, 60_000);
});

describe('durable plan (B-dur-2b)', () => {
  it('one record for a three-step plan; later steps ride the same marker', async () => {
    const f = await fixture();
    f.raw.setElements([
      { role: 'button', name: 'One' },
      { role: 'button', name: 'Two' },
      { role: 'button', name: 'Three' },
    ]);
    const refs = [await f.refOf('One')];
    let markers = 0;
    f.setMarker(() => {
      markers += 1;
    });
    const report = await f.durable(
      'plan',
      'plan-1',
      () =>
        f.service.executePlan(f.sessionId, f.pageId, [
          { action: 'click', target: { ref: refs[0] as string } },
          { action: 'scroll', direction: 'down' } as never,
          { action: 'scroll', direction: 'down' } as never,
        ]),
      () => 'rejected'
    );
    expect(report).toBeDefined();
    expect(markers).toBe(1);
    expect(await f.records('plan-1')).toHaveLength(1);
    expect((await f.records('plan-1'))[0]).toMatchObject({ dispatched: true, kind: 'plan' });
  }, 60_000);
});

describe('durable autofill (B-dur-2b)', () => {
  const company = (node: string) => ({
    ref: node,
    role: 'textbox',
    name: 'Company',
    attributes: { tag: 'input', type: 'text', 'autofill-node': node, 'autofill-block': '' },
  });
  const request = {
    fields: [{ match: { label: 'Company' }, value: 'Acme', strategy: 'native-input' as const }],
    policy: { settleMs: 0 },
  };

  it('journals one browser/autofill record for the whole fill', async () => {
    const f = await fixture();
    f.raw.seedElements([company('company')] as never);
    const report = await f.durable(
      'autofill',
      'fill-1',
      () => f.service.autofill(f.sessionId, f.pageId, request),
      () => false
    );
    expect(report).toMatchObject({ ok: true });
    expect(await f.records('fill-1')).toEqual([
      { revision: 3, dispatched: true, status: 'completed', kind: 'autofill' },
    ]);
  }, 60_000);

  it('a committed field replaced during the marker wait crosses no effect; the report is kept', async () => {
    const f = await fixture();
    f.raw.seedElements([company('company')] as never);
    let effects = 0;
    const act = f.raw.act.bind(f.raw);
    f.raw.act = async (action) => {
      effects += 1;
      return act(action);
    };
    f.setMarker(() => {
      // The control the run committed to is re-rendered as another node during the wait.
      f.raw.setElements([company('company-v2')] as never);
    });
    const report = (await f.durable(
      'autofill',
      'fill-stale',
      () => f.service.autofill(f.sessionId, f.pageId, request),
      () => 'rejected'
    )) as { ok: boolean };
    expect(report.ok).toBe(false);
    expect(effects).toBe(0);
    expect(await f.records('fill-stale')).toEqual([
      { revision: 3, dispatched: true, status: 'failed', kind: 'autofill' },
    ]);
  }, 60_000);
});

describe('reports that hide an unknown effect (B-dur-2b)', () => {
  it('a plan whose step lost its result is outcome-unknown; a known step refusal is not', async () => {
    const f = await fixture();
    f.raw.setElements([
      { role: 'button', name: 'One' },
      { role: 'button', name: 'Two' },
    ]);
    const one = await f.refOf('One');
    const act = f.raw.act.bind(f.raw);
    let calls = 0;
    f.raw.act = async (action) => {
      calls += 1;
      if (calls === 2) throw new Error('engine transport closed');
      return act(action);
    };
    const lost = await f.run(() =>
      f.service.executePlan(f.sessionId, f.pageId, [
        { action: 'click', target: { ref: one } },
        { action: 'scroll', direction: 'down' } as never,
      ])
    );
    expect(lost.ok).toBe(false);
    expect(browserReportOutcomeUnknown(lost)).toBe(true);

    const g = await fixture();
    g.raw.setElements([{ role: 'button', name: 'One' }]);
    await g.refOf('One');
    // A ref no observation minted, with no candidate to heal to: a typed refusal before dispatch.
    const known = await g.run(() =>
      g.service.executePlan(g.sessionId, g.pageId, [{ action: 'click', target: { ref: 'e999_7' } }])
    );
    expect(known.ok).toBe(false);
    expect(browserReportOutcomeUnknown(known)).toBe(false);
  }, 60_000);

  it('the act batch report and an uncertain autofill receipt carry the fact', async () => {
    const f = await fixture();
    f.raw.act = async () => {
      throw new Error('engine transport closed');
    };
    const batch = await f.run(() =>
      f.service.act(f.sessionId, f.pageId, {
        steps: [{ action: 'scroll', direction: 'down' }],
      } as never)
    );
    expect((batch as { status: string }).status).toBe('failed');
    expect(browserReportOutcomeUnknown(batch)).toBe(true);
    expect(browserReportOutcomeUnknown({ ok: false, receipts: [{ status: 'uncertain' }] })).toBe(
      true
    );
    expect(browserReportOutcomeUnknown({ ok: false, receipts: [{ status: 'failed' }] })).toBe(
      false
    );
  }, 60_000);
});
