/**
 * F10: popup lifecycle. A page-initiated popup (window.open) is adopted
 * automatically: the service registers it with its opener, the lifecycle
 * events (page.created / page.destroyed) reach the session replay, and the
 * popup is fully operable (observe/act) without a client-side create-page
 * round trip.
 */
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it, vi } from 'vitest';
import { AgentBrowserService } from './service';

async function setup() {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({ engine });
  const session = await service.createSession({ tenantId: 't1' });
  const pageId = (await service.createPage(session.sessionId)).pageId;
  await service.navigate(session.sessionId, pageId, { url: 'https://example.com/' });
  const engineSessionId = engine.getSessionIds()[0];
  const fakePage = engine.getFakePage(engineSessionId as string, pageId);
  if (!fakePage) throw new Error('no fake page');
  return { engine, service, session, pageId, fakePage };
}

async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
  return vi.waitFor(async () => {
    const value = await probe();
    if (value === undefined) throw new Error('condition not met yet');
    return value;
  });
}

describe('popup lifecycle (F10)', () => {
  it('auto-registers a popup and reports its opener', async () => {
    const { service, session, pageId, fakePage } = await setup();

    await fakePage.openPopup();

    const view = await waitFor(() =>
      service
        .listPages(session.sessionId)
        .then((pages) => pages.find((p) => p.openerPageId === pageId))
    );
    expect(view.pageId).not.toBe(pageId);
    expect(view.status).toBe('active');
  });

  it('records page.created in the session replay', async () => {
    const { service, session, fakePage } = await setup();

    await fakePage.openPopup();

    await waitFor(() => {
      const created = service.getSessionEvents(session.sessionId, 'page.created');
      return created.length > 0 ? created : undefined;
    });
    const created = service.getSessionEvents(session.sessionId, 'page.created');
    expect(created[0]?.data).toMatchObject({ openerPageId: expect.any(String) });
  });

  it('operates the popup through the normal observe/act path', async () => {
    const { service, session, pageId, fakePage } = await setup();

    await fakePage.openPopup();
    const view = await waitFor(() =>
      service
        .listPages(session.sessionId)
        .then((pages) => pages.find((p) => p.openerPageId === pageId))
    );

    await service.navigate(session.sessionId, view.pageId, { url: 'https://example.com/' });
    const observation = await service.observe(session.sessionId, view.pageId, {
      mode: 'interactive',
    });
    const button = observation.elements[0]?.ref;
    if (!button) throw new Error('popup fixture elements missing');

    const result = await service.act(session.sessionId, view.pageId, {
      action: 'click',
      target: { ref: button },
    });
    expect(result.status).toBe('success');
  });

  it('announces page.destroyed and reaps the registry when the popup closes', async () => {
    const { engine, service, session, pageId, fakePage } = await setup();

    await fakePage.openPopup();
    const view = await waitFor(() =>
      service
        .listPages(session.sessionId)
        .then((pages) => pages.find((p) => p.openerPageId === pageId))
    );
    const engineSessionId = engine.getSessionIds()[0];
    const popupPage = engine.getFakePage(engineSessionId as string, view.pageId);
    if (!popupPage) throw new Error('popup fake page missing');

    await popupPage.close();

    await waitFor(() => {
      const destroyed = service.getSessionEvents(session.sessionId, 'page.destroyed');
      return destroyed.some((e) => e.pageId === view.pageId) ? destroyed : undefined;
    });
    const remaining = await service.listPages(session.sessionId);
    expect(remaining.find((p) => p.pageId === view.pageId)).toBeUndefined();
    expect(remaining.find((p) => p.pageId === pageId)).toBeDefined();
  });

  it('fans page.destroyed into replay when the engine stream ends silently', async () => {
    const { engine, service, session, pageId, fakePage } = await setup();

    await fakePage.openPopup();
    const view = await waitFor(() =>
      service
        .listPages(session.sessionId)
        .then((pages) => pages.find((p) => p.openerPageId === pageId))
    );
    const engineSessionId = engine.getSessionIds()[0];
    const popupPage = engine.getFakePage(engineSessionId as string, view.pageId);
    if (!popupPage) throw new Error('popup fake page missing');

    popupPage.endStream();

    const destroyed = await waitFor(() => {
      const events = service.getSessionEvents(session.sessionId, 'page.destroyed');
      return events.some((e) => e.pageId === view.pageId) ? events : undefined;
    });
    const synthesized = destroyed.find((e) => e.pageId === view.pageId);
    expect(synthesized?.data).toMatchObject({ reason: 'streamEnded' });
    await vi.waitFor(async () => {
      const remaining = await service.listPages(session.sessionId);
      if (remaining.some((p) => p.pageId === view.pageId)) {
        throw new Error('popup still registered');
      }
    });
    expect(
      (await service.listPages(session.sessionId)).find((p) => p.pageId === pageId)
    ).toBeDefined();
  });

  it('tears down both pumps when the session closes', async () => {
    const { service, session, pageId, fakePage } = await setup();

    await fakePage.openPopup();
    await waitFor(() =>
      service
        .listPages(session.sessionId)
        .then((pages) => pages.find((p) => p.openerPageId === pageId))
    );

    await expect(service.closeSession(session.sessionId)).resolves.toBeUndefined();
    // Give abandoned pumps a tick to observe the closed iterators.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.getPage(session.sessionId, pageId)).toBeUndefined();
  });

  it('adopts back-to-back popups without cross-wiring openers', async () => {
    const { service, session, pageId, fakePage } = await setup();

    const first = await fakePage.openPopup();
    const second = await fakePage.openPopup();

    const views = await waitFor(async () => {
      const pages = await service.listPages(session.sessionId);
      const adopted = pages.filter((p) => p.openerPageId === pageId);
      return adopted.length === 2 ? adopted : undefined;
    });
    const registryIds = views.map((v) => v.pageId);
    expect(new Set(registryIds).size).toBe(2);
    // Each registry entry wraps exactly one of the two engine popups.
    for (const popup of [first, second]) {
      expect(registryIds.some((id) => typeof id === 'string' && id.endsWith(`_${popup.id}`))).toBe(
        true
      );
    }
  });

  it('caps adopted popups per session and refuses the overflow', async () => {
    const { service, session, pageId, fakePage } = await setup();

    const popups: Awaited<ReturnType<typeof fakePage.openPopup>>[] = [];
    for (let index = 0; index < 21; index += 1) {
      popups.push(await fakePage.openPopup());
    }

    const adopted = await waitFor(async () => {
      const pages = await service.listPages(session.sessionId);
      const found = pages.filter((p) => p.openerPageId === pageId);
      return found.length >= 20 ? found : undefined;
    });
    expect(adopted.length).toBe(20);
    // Every page.created reached the replay; adoption (not the event) is capped.
    const created = service.getSessionEvents(session.sessionId, 'page.created');
    expect(created.length).toBe(21);
    // The 21st popup was never registered.
    const overflow = popups[20];
    expect(overflow).toBeDefined();
    const registryIds = (await service.listPages(session.sessionId)).map((p) => p.pageId);
    expect(
      registryIds.some((id) => typeof id === 'string' && id.endsWith(`_${overflow?.id}`))
    ).toBe(false);
  });

  it('does not resurrect the event ledger when an abandoned pump ends after close', async () => {
    const { service, session, pageId, fakePage } = await setup();

    await fakePage.openPopup();
    await waitFor(() =>
      service
        .listPages(session.sessionId)
        .then((pages) => pages.find((p) => p.openerPageId === pageId))
    );

    await service.closeSession(session.sessionId);
    // Abandoned pumps observe the closed iterators on their own tick; a
    // synthetic page.destroyed must not recreate the deleted ledger
    // (recordEvent creates on demand - the guard has to refuse).
    await new Promise((resolve) => setTimeout(resolve, 30));
    const ledgers = (service as unknown as { eventHistory: Map<string, unknown> }).eventHistory;
    expect(ledgers.has(session.sessionId)).toBe(false);
  });
});
