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
  const adapter: ApplicationAdapter = {
    ...draft.adapter,
    authorize: (scope) => allowed && draft.adapter.authorize(scope),
    operations: { ...draft.adapter.operations, submit: draft.submissionOperation },
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
async function delayResponse(ui: Page, pattern: string, method = 'GET') {
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
    await route.fulfill({ response });
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
