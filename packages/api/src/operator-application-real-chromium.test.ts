import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { ApplicationAdapter } from '@agentbrowser/control';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { FakeEngine } from '@agentbrowser/testkit';
import type { Page, Route } from 'playwright';
import { expect, it, vi } from 'vitest';
import { AgentBrowserClient } from '../../sdk-typescript/src/client.js';
import { buildServer } from './server.js';
import { createApplicationDraft } from './test-support/application-draft.js';

// Real browser for the operator document; the backend's browser port is a fake.
// Application authorization, control and discovery run through the real public server.
async function withPanel(run: (f: Awaited<ReturnType<typeof openPanel>>) => Promise<void>) {
  const f = await openPanel();
  try {
    await run(f);
  } finally {
    await f.uiEngine.close();
    await f.server.close();
  }
}
async function openPanel() {
  const draft = createApplicationDraft({ id: 'panel' });
  let allowed = true;
  let loseResult = false;
  const receipts = new Map<string, unknown>();
  // Test-owner instrumentation: preserve the real draft effect even when delivery fails.
  const update = draft.adapter.operations.update;
  if (!update) throw new Error('Draft fixture update operation missing');
  let commitGate: Promise<void> | undefined;
  const recordedUpdate: typeof update = {
    ...update,
    prepare(input) {
      const execute = update.prepare(input);
      return async (scope) => {
        const result = await execute(scope);
        if (result.status === 'committed' && scope.operationId) {
          receipts.set(scope.operationId, { operationId: scope.operationId, draft: draft.read() });
          if (commitGate) await commitGate;
          if (loseResult) {
            loseResult = false;
            throw new Error('fixture lost result');
          }
        }
        return result;
      };
    },
  };
  const adapter: ApplicationAdapter = {
    ...draft.adapter,
    authorize: (scope) => allowed && draft.adapter.authorize(scope),
    operations: {
      ...draft.adapter.operations,
      update: recordedUpdate,
      submit: draft.submissionOperation,
    },
    receipt: async (_scope, operationId) => receipts.get(operationId) ?? null,
  };
  const server = await buildServer({
    engine: new FakeEngine(),
    applicationAdapters: [adapter],
    apiKeys: new Map(
      ['owner', 'other'].map((key) => [createHash('sha256').update(key).digest('hex'), key])
    ),
  });
  const uiEngine = new PlaywrightChromiumEngine();
  try {
    await server.listen({ port: 0, host: '127.0.0.1' });
    const baseUrl = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
    const owner = new AgentBrowserClient({ baseUrl, apiKey: 'owner' });
    const native = await (await uiEngine.createSession({})).newPage();
    const ui = (native as unknown as { page: Page }).page;
    ui.setDefaultTimeout(5000);
    await ui.goto(`${baseUrl}/operator`);
    const connect = async (key = 'owner') => {
      await ui.getByLabel('Operator key', { exact: true }).fill(key);
      await ui.getByRole('button', { name: 'Connect', exact: true }).click();
    };
    const attach = async (id: string) => {
      await ui.getByLabel('Session ID', { exact: true }).fill(id);
      await ui.getByRole('button', { name: 'Attach', exact: true }).click();
    };
    await connect();
    const { sessionId } = await owner.sessions.create({ controlMode: 'delegated' });
    await attach(sessionId);
    await vi.waitFor(async () =>
      expect(await ui.locator('#status').textContent()).toContain('HUMAN_ACTIVE')
    );
    const bind = async (id = adapter.id, resource = 'panel') => {
      await ui.getByLabel('Application adapter ID', { exact: true }).fill(id);
      await ui.getByLabel('Application resource ID', { exact: true }).fill(resource);
      await ui.getByRole('button', { name: 'Bind application', exact: true }).click();
    };
    return {
      ui,
      uiEngine,
      server,
      owner,
      sessionId,
      adapter,
      draft,
      connect,
      attach,
      bind,
      holdNextResult: () => {
        let release!: () => void;
        commitGate = new Promise<void>((resolve) => {
          release = resolve;
        });
        return () => {
          commitGate = undefined;
          release();
        };
      },
      loseNextResult: () => {
        loseResult = true;
      },
      revoke: () => {
        allowed = false;
      },
    };
  } catch (error) {
    await uiEngine.close();
    await server.close();
    throw error;
  }
}
async function idle(ui: Page) {
  await vi.waitFor(async () => expect(await ui.locator('#attach').isDisabled()).toBe(false));
}
// Delay one actual response, not an invented authority result. Other requests pass.
async function delayResponse(ui: Page, pattern: string, method = 'GET', deny = false) {
  let release!: () => void;
  let captured!: () => void;
  let completed!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const done = new Promise<void>((resolve) => {
    completed = resolve;
  });
  let used = false;
  await ui.route(pattern, async (route: Route) => {
    if (used || route.request().method() !== method) return route.continue();
    used = true;
    const response = await route.fetch();
    captured();
    await gate;
    await route.fulfill(
      deny
        ? {
            response,
            status: 403,
            json: { error: { code: 'FORBIDDEN', message: 'Delayed denial' } },
          }
        : { response }
    );
    completed();
  });
  return {
    ready,
    release: async () => {
      release();
      await done;
    },
  };
}

it('binds, discovers review requirements and requires fresh review after binding changes in the operator panel', async () => {
  await withPanel(async (f) => {
    const { ui } = f;
    await vi.waitFor(async () =>
      expect(await ui.locator('#application').textContent()).toContain('No application bound')
    );
    await f.bind();
    await idle(ui);
    expect(await ui.locator('#application').textContent()).toContain(f.adapter.id);
    expect(await ui.locator('#application').textContent()).toContain('operator-submit');
    expect((await f.owner.sessions.applicationDiscover(f.sessionId))?.resource).toBe('panel');
    await ui.locator('#review').click();
    await idle(ui);
    expect(await ui.locator('#delegate').isDisabled()).toBe(false);
    await f.bind();
    await idle(ui);
    expect(await ui.locator('#delegate').isDisabled()).toBe(true);
    expect(await ui.locator('#pages').textContent()).toBe('');
    expect(await ui.locator('#grant').inputValue()).toBe('');
    // Native button keyboard activation needs no arrow keys.
    await ui.getByRole('button', { name: 'Unbind application', exact: true }).focus();
    await ui.keyboard.press('Enter');
    await idle(ui);
    expect(await f.owner.sessions.applicationDiscover(f.sessionId)).toBeNull();
    expect(await ui.locator('#application').textContent()).toContain('No application bound');
    await f.bind();
    await idle(ui);
    await ui.locator('#mode').selectOption('application');
    await ui.locator('#review').click();
    await idle(ui);
    await ui.locator('#delegate').click();
    await idle(ui);
    expect(await ui.locator('#grant').inputValue()).not.toBe('');
    expect(await ui.locator('#bind-application').isDisabled()).toBe(true);
    expect(await ui.locator('#unbind-application').isDisabled()).toBe(true);
    expect(await ui.locator('#application').textContent()).not.toContain(f.adapter.id);
    expect(f.draft.submissionCount()).toBe(0);
  });
}, 30000);

it('reports refused binding and revoked discovery without stale success or credentials', async () => {
  await withPanel(async (f) => {
    const { ui } = f;
    for (const [adapter, resource] of [
      ['missing', 'panel'],
      [f.adapter.id, 'foreign'],
    ]) {
      await f.bind(adapter, resource);
      await idle(ui);
      expect(await ui.locator('#message').textContent()).not.toBe('');
      expect(await f.owner.sessions.applicationDiscover(f.sessionId)).toBeNull();
      expect(await ui.locator('#delegate').isDisabled()).toBe(true);
    }
    await f.bind();
    await idle(ui);
    f.revoke();
    await vi.waitFor(
      async () => expect(await ui.locator('#application').textContent()).toContain('unavailable'),
      { timeout: 6000 }
    );
    expect(await ui.locator('#application').textContent()).not.toContain(f.adapter.id);
    await ui.locator('#forget').click();
    expect(await ui.locator('#adapter').inputValue()).toBe('');
    expect(await ui.locator('#resource').inputValue()).toBe('');
    await f.connect('other');
    await f.attach(f.sessionId);
    await idle(ui);
    expect(await ui.locator('#bind-application').isDisabled()).toBe(true);
    expect(await ui.locator('#status').textContent()).not.toContain('HUMAN_ACTIVE');
  });
}, 30000);

it('discards delayed discovery after attaching another session', async () => {
  await withPanel(async (f) => {
    await f.bind();
    await idle(f.ui);
    const delayed = await delayResponse(f.ui, `**/sessions/${f.sessionId}/application`);
    await delayed.ready;
    const other = await f.owner.sessions.create({ controlMode: 'delegated' });
    await f.attach(other.sessionId);
    await idle(f.ui);
    await delayed.release();
    await vi.waitFor(async () =>
      expect(await f.ui.locator('#application').textContent()).toContain('No application bound')
    );
    expect(await f.ui.locator('#application').textContent()).not.toContain(f.adapter.id);
  });
}, 30000);

it('forgets during an uncertain bind and discards its delayed response after reconnect', async () => {
  await withPanel(async (f) => {
    const delayed = await delayResponse(f.ui, `**/sessions/${f.sessionId}/application`, 'PUT');
    await f.bind();
    await delayed.ready;
    expect(await f.ui.locator('#forget').isDisabled()).toBe(false);
    await f.ui.locator('#forget').click();
    expect(await f.ui.locator('#adapter').inputValue()).toBe('');
    await f.connect('other');
    await f.attach(f.sessionId);
    await idle(f.ui);
    await delayed.release();
    expect(await f.ui.locator('#status').textContent()).not.toContain('HUMAN_ACTIVE');
    expect(await f.ui.locator('#application').textContent()).not.toContain(f.adapter.id);
    expect(await f.ui.locator('#grant').inputValue()).toBe('');
    // Forget does not undo a dispatched server mutation or automatically replay it.
    expect((await f.owner.sessions.applicationDiscover(f.sessionId))?.resource).toBe('panel');
  });
}, 30000);

it('stops a superseded create chain without clearing a newer pending action', async () => {
  await withPanel(async (f) => {
    const requests: string[] = [];
    f.ui.on('request', (request) => {
      if (request.method() === 'POST') requests.push(request.url());
    });
    const creating = await delayResponse(f.ui, '**/v1/sessions', 'POST');
    await f.ui.locator('#url').fill('https://example.com/old-intent');
    await f.ui.locator('#create').click();
    await creating.ready;
    await f.ui.locator('#forget').click();
    await f.connect();
    await f.attach(f.sessionId);
    await idle(f.ui);
    const reviewing = await delayResponse(f.ui, '**/control/prepare-resume', 'POST');
    await f.ui.locator('#review').click();
    await reviewing.ready;
    await creating.release();
    await f.ui.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    );
    expect(await f.ui.locator('#attach').isDisabled()).toBe(true);
    expect(requests.filter((url) => url.endsWith('/pages'))).toEqual([]);
    await reviewing.release();
    await idle(f.ui);
    expect(await f.ui.locator('#delegate').isDisabled()).toBe(false);
    expect(await f.ui.locator('#session').inputValue()).toBe(f.sessionId);
  });
}, 30000);

it('does not let an older control poll overwrite a fresh review', async () => {
  await withPanel(async (f) => {
    const delayed = await delayResponse(f.ui, `**/sessions/${f.sessionId}/control`);
    await delayed.ready;
    await f.ui.locator('#review').click();
    await idle(f.ui);
    await delayed.release();
    await f.ui.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    );
    expect(await f.ui.locator('#status').textContent()).toContain('RESUME_REVIEW');
    expect(await f.ui.locator('#delegate').isDisabled()).toBe(false);
  });
}, 30000);

it('renders discovery as text and hides it when the observed control is busy', async () => {
  await withPanel(async (f) => {
    await f.bind();
    await idle(f.ui);
    // Rendering negative control only; backend schema/authorization has separate coverage.
    await f.ui.route('**/application', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: { ...body, resource: '<img src=x onerror="window.injected=true">' },
      });
    });
    await vi.waitFor(
      async () => expect(await f.ui.locator('#application').textContent()).toContain('<img'),
      { timeout: 6000 }
    );
    expect(await f.ui.locator('#application img').count()).toBe(0);
    expect(await f.ui.evaluate(() => 'injected' in window)).toBe(false);
    // Busy-state projection negative control. Server busy/configuration denial is
    // independently covered by application-http and operator-binding-race tests.
    await f.ui.route('**/control', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), busy: true } });
    });
    await vi.waitFor(
      async () => expect(await f.ui.locator('#bind-application').isDisabled()).toBe(true),
      { timeout: 6000 }
    );
    expect(await f.ui.locator('#application').textContent()).toContain('unavailable');
  });
}, 30000);

it('clears the previous binding immediately while attaching a slow session', async () => {
  await withPanel(async (f) => {
    await f.bind();
    await idle(f.ui);
    await f.ui.locator('#review').click();
    await idle(f.ui);
    const other = await f.owner.sessions.create({ controlMode: 'delegated' });
    const delayed = await delayResponse(f.ui, `**/sessions/${other.sessionId}/control`);
    try {
      await f.attach(other.sessionId);
      await delayed.ready;
      expect(await f.ui.locator('#application').textContent()).not.toContain(f.adapter.id);
      expect(await f.ui.locator('#status').textContent()).not.toContain('RESUME_REVIEW');
      expect(await f.ui.locator('#pages').textContent()).toBe('');
      expect(await f.ui.locator('#grant').inputValue()).toBe('');
    } finally {
      await delayed.release();
    }
  });
}, 30000);

async function seedOperation(f: Awaited<ReturnType<typeof openPanel>>, id: string, lost = false) {
  await f.bind();
  await idle(f.ui);
  if (lost) f.loseNextResult();
  const execute = f.owner.sessions.applicationExecute(f.sessionId, {
    operation: 'update',
    operationId: id,
    expectedVersion: f.draft.read().version,
    input: { fullName: 'Synthetic operator lookup' },
  });
  if (lost) await expect(execute).rejects.toThrow();
  else await execute;
  expect(f.draft.read().fields.fullName).toBe('Synthetic operator lookup');
}
async function lookup(ui: Page, kind: 'status' | 'receipt') {
  await ui
    .getByRole('button', {
      name: kind === 'status' ? 'Look up status' : 'Look up application receipt',
      exact: true,
    })
    .click();
  await idle(ui);
}

for (const lost of [false, true])
  it(`reconciles separate ${lost ? 'unknown' : 'completed'} ledger and present receipt observations without executing`, async () => {
    await withPanel(async (f) => {
      await seedOperation(f, 'lookup-write', lost);
      const writes: string[] = [];
      f.ui.on('request', (request) => {
        if (request.method() !== 'GET') writes.push(request.url());
      });
      await f.ui.getByLabel('Operation ID', { exact: true }).fill('lookup-write');
      await lookup(f.ui, 'status');
      const status = lost ? 'outcome_unknown' : 'completed';
      expect(await f.ui.locator('#operation-result').textContent()).toContain(status);
      await lookup(f.ui, 'receipt');
      expect(await f.ui.locator('#receipt-result').textContent()).toContain(
        'Synthetic operator lookup'
      );
      expect(await f.ui.locator('#receipt-result').textContent()).toContain(f.adapter.id);
      expect(await f.ui.locator('#operation-result').textContent()).toContain(status);
      expect((await f.owner.sessions.operation(f.sessionId, 'lookup-write')).status).toBe(status);
      expect(writes).toEqual([]);
      await f.ui.locator('#forget').click();
      expect(await f.ui.locator('#operation-result').textContent()).toBe('');
      expect(await f.ui.locator('#receipt-result').textContent()).toBe('');
      expect(await f.ui.locator('#operation-id').inputValue()).toBe('');
    });
  }, 30000);

it('distinguishes missing ledger and null receipt, validates IDs, and renders receipt data as text', async () => {
  await withPanel(async (f) => {
    await f.bind();
    await idle(f.ui);
    await f.ui.getByLabel('Operation ID', { exact: true }).fill('missing');
    await lookup(f.ui, 'status');
    expect(await f.ui.locator('#operation-result').textContent()).toContain('not recorded');
    await lookup(f.ui, 'receipt');
    expect(await f.ui.locator('#receipt-result').textContent()).toContain('No receipt returned');
    for (const id of ['', 'bad id', '../bad']) {
      await f.ui.locator('#operation-id').fill(id);
      expect(await f.ui.locator('#lookup-status').isDisabled()).toBe(true);
      expect(await f.ui.locator('#lookup-receipt').isDisabled()).toBe(true);
    }
    await f.ui.locator('#operation-id').fill('x'.repeat(128));
    expect(await f.ui.locator('#lookup-status').isDisabled()).toBe(false);
    // Bypass HTML maxlength to exercise the shared protocol pattern too.
    await f.ui.locator('#operation-id').evaluate((node) => {
      (node as HTMLInputElement).value = 'x'.repeat(129);
      node.dispatchEvent(new Event('input'));
    });
    expect(await f.ui.locator('#lookup-status').isDisabled()).toBe(true);
    await f.ui.locator('#operation-id').fill('text-receipt');
    await f.ui.route('**/application/receipts/*', (route) =>
      route.fulfill({ json: '<img src=x onerror="window.injected=true">' })
    );
    await lookup(f.ui, 'receipt');
    expect(await f.ui.locator('#receipt-result').textContent()).toContain('<img');
    expect(await f.ui.locator('#receipt-result img').count()).toBe(0);
    expect(await f.ui.evaluate(() => 'injected' in window)).toBe(false);
  });
}, 30000);

for (const change of ['id', 'forget'] as const)
  it(`discards a delayed receipt after ${change} changes`, async () => {
    await withPanel(async (f) => {
      await seedOperation(f, 'old-result');
      await f.ui.locator('#operation-id').fill('old-result');
      const delayed = await delayResponse(f.ui, '**/application/receipts/old-result');
      await f.ui.locator('#lookup-receipt').click();
      await delayed.ready;
      if (change === 'id') await f.ui.locator('#operation-id').fill('new-result');
      else await f.ui.locator('#forget').click();
      await delayed.release();
      await f.ui.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      );
      expect(await f.ui.locator('#receipt-result').textContent()).toBe('');
      expect(await f.ui.locator('#operation-result').textContent()).toBe('');
      expect(await f.ui.locator('#message').textContent()).not.toContain(
        'Synthetic operator lookup'
      );
    });
  }, 30000);

it('looks up an active operation during busy control without enabling receipt reads', async () => {
  await withPanel(async (f) => {
    await f.bind();
    await idle(f.ui);
    const release = f.holdNextResult();
    const executing = f.owner.sessions.applicationExecute(f.sessionId, {
      operation: 'update',
      operationId: 'active-write',
      expectedVersion: 0,
      input: { fullName: 'Active synthetic draft' },
    });
    try {
      await vi.waitFor(
        async () => expect(await f.ui.locator('#use-operation').isDisabled()).toBe(false),
        { timeout: 6000 }
      );
      await f.ui.locator('#use-operation').focus();
      await f.ui.keyboard.press('Enter');
      expect(await f.ui.locator('#operation-id').inputValue()).toBe('active-write');
      expect(await f.ui.locator('#lookup-receipt').isDisabled()).toBe(true);
      await lookup(f.ui, 'status');
      expect(await f.ui.locator('#operation-result').textContent()).toContain('in_flight');
    } finally {
      release();
      await executing;
    }
  });
}, 30000);

it('discards receipt data when the server binding changes during lookup', async () => {
  await withPanel(async (f) => {
    await seedOperation(f, 'changed-binding');
    await f.ui.locator('#operation-id').fill('changed-binding');
    const delayed = await delayResponse(f.ui, '**/application/receipts/changed-binding');
    await f.ui.locator('#lookup-receipt').click();
    await delayed.ready;
    await f.owner.sessions.applicationUnbind(f.sessionId);
    await delayed.release();
    await idle(f.ui);
    expect(await f.ui.locator('#receipt-result').textContent()).toContain('Result discarded');
    expect(await f.ui.locator('#receipt-result').textContent()).not.toContain(
      'Synthetic operator lookup'
    );
    expect(await f.ui.locator('#lookup-receipt').isDisabled()).toBe(true);
  });
}, 30000);

it('keeps denied receipt reads distinct from null and clears displayed data on revocation', async () => {
  await withPanel(async (f) => {
    await seedOperation(f, 'private-result');
    await f.ui.locator('#operation-id').fill('private-result');
    await lookup(f.ui, 'receipt');
    expect(await f.ui.locator('#receipt-result').textContent()).toContain(
      'Synthetic operator lookup'
    );
    // Public error-envelope projection negative control, with stable surrounding authority.
    await f.ui.route('**/application/receipts/*', (route) =>
      route.fulfill({
        status: 403,
        json: { error: { code: 'FORBIDDEN', message: 'Receipt read denied' } },
      })
    );
    await lookup(f.ui, 'receipt');
    expect(await f.ui.locator('#receipt-result').textContent()).toContain('FORBIDDEN');
    expect(await f.ui.locator('#receipt-result').textContent()).not.toContain(
      'No receipt returned'
    );
    f.revoke();
    await vi.waitFor(
      async () => expect(await f.ui.locator('#receipt-result').textContent()).toBe(''),
      { timeout: 6000 }
    );
    expect(await f.ui.locator('#lookup-receipt').isDisabled()).toBe(true);
    expect(await f.ui.locator('#lookup-status').isDisabled()).toBe(false);
    await lookup(f.ui, 'status');
    expect(await f.ui.locator('#operation-result').textContent()).toContain('completed');
  });
}, 30000);

it('does not unlock a pending mutation when the operation input is edited', async () => {
  await withPanel(async (f) => {
    const delayed = await delayResponse(f.ui, '**/application', 'PUT');
    await f.bind();
    await delayed.ready;
    expect(await f.ui.locator('#operation-id').isDisabled()).toBe(true);
    await f.ui.locator('#operation-id').dispatchEvent('input');
    expect(await f.ui.locator('#attach').isDisabled()).toBe(true);
    await delayed.release();
    await idle(f.ui);
  });
}, 30000);

it('discards a late denied lookup without unlocking or replacing a newer pending lookup', async () => {
  await withPanel(async (f) => {
    await seedOperation(f, 'old-denied');
    await f.ui.locator('#operation-id').fill('old-denied');
    const old = await delayResponse(f.ui, '**/application/receipts/old-denied', 'GET', true);
    await f.ui.locator('#lookup-receipt').click();
    await old.ready;
    await f.ui.locator('#operation-id').fill('new-missing');
    const next = await delayResponse(f.ui, '**/application/receipts/new-missing');
    await f.ui.locator('#lookup-receipt').click();
    await next.ready;
    await old.release();
    await f.ui.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    );
    expect(await f.ui.locator('#attach').isDisabled()).toBe(true);
    expect(await f.ui.locator('#receipt-result').textContent()).toBe('');
    expect(await f.ui.locator('#message').textContent()).not.toContain('Delayed denial');
    await next.release();
    await idle(f.ui);
    expect(await f.ui.locator('#receipt-result').textContent()).toContain('No receipt returned');
    expect(await f.ui.locator('#receipt-result').textContent()).toContain('new-missing');
    expect(await f.ui.locator('#receipt-result').textContent()).not.toContain('old-denied');
  });
}, 30000);
