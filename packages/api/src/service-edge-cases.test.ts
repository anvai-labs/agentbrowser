/**
 * Edge-branch coverage for AgentBrowserService: crash paths on every
 * capture surface, event-pump resilience to misbehaving listeners, popup
 * adoption guard rails, orchestration envelopes, wait deadlines and
 * validation corners that the main suites do not reach.
 */

import { ArtifactStore, MetricsRegistry, SecretManager } from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentBrowserService,
  type ServiceActRequest,
  ServiceError,
  type ServiceSessionRequest,
} from './service.js';

/** Capture a ServiceError from a rejecting promise; anything else is a bug. */
async function capture(run: () => Promise<unknown>): Promise<ServiceError | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    return error;
  }
}

async function basic(service: AgentBrowserService, tenantId = 't1') {
  const sessionId = (await service.createSession({ tenantId })).sessionId;
  const pageId = (await service.createPage(sessionId)).pageId;
  await service.navigate(sessionId, pageId, { url: 'https://example.com/' });
  return { sessionId, pageId };
}

/** Full harness with direct handles onto the fake page for fault injection. */
async function harness() {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({ engine });
  const { sessionId, pageId } = await basic(service);
  const engineSessionId = engine.getSessionIds()[0] as string;
  const fakePage = engine.getFakePage(engineSessionId, pageId);
  if (!fakePage) throw new Error('no fake page');
  const fakeSession = engine.getSession(engineSessionId);
  if (!fakeSession) throw new Error('no fake session');
  return { engine, service, sessionId, pageId, fakePage, fakeSession };
}

function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
  return vi.waitFor(async () => {
    const value = await probe();
    if (value === undefined) throw new Error('condition not met yet');
    return value;
  });
}

/** Give the event pump ample spaced time to process (or drop) events before a must-NOT-happen assertion. */
async function letPumpSettle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Minimal shape of a testkit FakePage handle used for fault injection. */
interface FakePageLike {
  setElements(elements: Array<Record<string, unknown>>): void;
  [key: string]: unknown;
}

describe('AgentBrowserService edge branches', () => {
  describe('session defaults and plumbing', () => {
    it('applies the deployment default idle timeout when the request omits one', async () => {
      const service = new AgentBrowserService({
        engine: new FakeEngine(),
        defaultIdleTimeoutMs: 1_234_567,
      });
      const session = await service.createSession({ tenantId: 't1' });
      expect(session.idleTimeoutMs).toBe(1_234_567);
      await service.shutdown();
    });

    it('honors a request-scoped idleTimeoutMs over the default', async () => {
      const service = new AgentBrowserService({
        engine: new FakeEngine(),
        defaultIdleTimeoutMs: 60_000,
      });
      const session = await service.createSession({ tenantId: 't1', idleTimeoutMs: 999_999 });
      expect(session.idleTimeoutMs).toBe(999_999);
      const fallback = await service.createSession({ tenantId: 't2' });
      expect(fallback.idleTimeoutMs).toBe(60_000);
      await service.shutdown();
    });

    it('survives a misbehaving subscriber when sweeping an expired session', async () => {
      const service = new AgentBrowserService({
        engine: new FakeEngine(),
        sweepIntervalMs: 5,
      });
      const sessionId = (await service.createSession({ tenantId: 't1', ttlMs: 50 })).sessionId;
      const seen: string[] = [];
      service.subscribe(sessionId, () => {
        throw new Error('listener exploded');
      });
      service.subscribe(sessionId, (event) => {
        seen.push(`${event.type}:${String((event.data as { reason?: string }).reason)}`);
      });

      await waitFor(() => (seen.length > 0 ? seen : undefined));
      expect(seen).toContain('page.destroyed:session-expired');
      expect(service.getSession(sessionId)).toBeUndefined();
      await service.shutdown();
    });
  });

  describe('event pump resilience', () => {
    it('keeps delivering engine events after a listener throws', async () => {
      const { service, sessionId, fakePage } = await harness();
      const good: string[] = [];
      service.subscribe(sessionId, () => {
        throw new Error('boom');
      });
      service.subscribe(sessionId, (event) => good.push(event.type));
      fakePage.emitEvent('console.log', { text: 'still alive' });
      await waitFor(() => (good.includes('console.log') ? good : undefined));
      expect(good).toContain('console.log');
      await service.shutdown();
    });

    it('keeps delivering the synthesized page.destroyed after a listener throws', async () => {
      const { engine, service, sessionId, pageId, fakePage } = await harness();
      const good: Array<{ type: string; data?: unknown }> = [];
      service.subscribe(sessionId, () => {
        throw new Error('boom');
      });
      service.subscribe(sessionId, (event) => good.push({ type: event.type, data: event.data }));

      const popup = await fakePage.openPopup();
      const view = await waitFor(async () => {
        const pages = await service.listPages(sessionId);
        return pages.find((p) => p.openerPageId === pageId);
      });
      const popupPage = engine.getFakePage(engine.getSessionIds()[0] as string, view.pageId);
      if (!popupPage) throw new Error('popup fake page missing');

      // The popup's stream ends without a page.destroyed event: the pump
      // fans a synthesized one, and the throwing listener must not break it.
      popupPage.endStream();
      await waitFor(() =>
        good.some((e) => e.type === 'page.destroyed' && e.data !== undefined) ? good : undefined
      );
      expect(popup).toBeDefined();
      await service.shutdown();
    });
  });

  describe('popup adoption guard rails', () => {
    it('ignores page.created events without a usable payload', async () => {
      const { service, sessionId, fakePage } = await harness();
      fakePage.emitEvent('page.created');
      fakePage.emitEvent('page.created', { openerPageId: 7, pageId: null } as never);
      await letPumpSettle();
      expect((await service.listPages(sessionId)).map((p) => p.openerPageId)).toEqual([undefined]);
      await service.shutdown();
    });

    it('ignores popups whose opener is not tracked', async () => {
      const { service, sessionId, fakePage } = await harness();
      fakePage.emitEvent('page.created', {
        openerPageId: 'fake-page-does-not-exist',
        pageId: 'fake-page-999',
      });
      await letPumpSettle();
      expect(await service.listPages(sessionId)).toHaveLength(1);
      await service.shutdown();
    });

    it('never double-registers a replayed page.created', async () => {
      const { engine, service, sessionId, pageId, fakePage } = await harness();
      const popup = await fakePage.openPopup();
      const adopted = await waitFor(async () => {
        const pages = await service.listPages(sessionId);
        return pages.find((p) => p.openerPageId === pageId);
      });
      // Replay with the engine-side ids the event carries on a real engine.
      fakePage.emitEvent('page.created', { openerPageId: fakePage.id, pageId: popup.id });
      await letPumpSettle();
      const pages = await service.listPages(sessionId);
      expect(pages.filter((p) => p.openerPageId === pageId)).toHaveLength(1);
      expect(adopted.pageId).toBeTruthy();
      expect(engine.getSessionIds().length).toBeGreaterThan(0);
      await service.shutdown();
    });

    it('closes an over-cap popup engine-side even when close refuses', async () => {
      const { engine, service, sessionId, pageId, fakePage } = await harness();
      for (let index = 0; index < 20; index += 1) {
        await fakePage.openPopup();
      }
      await waitFor(async () => {
        const pages = await service.listPages(sessionId);
        return pages.filter((p) => p.openerPageId === pageId).length >= 20 ? pages : undefined;
      });
      // Every FakePage shares one prototype: make close refuse, so the cap
      // branch's engine-side sweep must swallow the failure.
      const handles =
        engine.getSession(engine.getSessionIds()[0] as string)?.getPageHandles() ?? [];
      const proto = Object.getPrototypeOf(handles[0]) as { close?: () => Promise<void> };
      const originalClose = proto.close;
      proto.close = async () => {
        throw new Error('close refused');
      };
      try {
        const overflow = await fakePage.openPopup();
        await vi.waitFor(() => {
          const created = service.getSessionEvents(sessionId, 'page.created');
          if (created.length < 21) throw new Error('event not replayed yet');
        });
        await letPumpSettle();
        const registered = (await service.listPages(sessionId)).map((p) => p.pageId);
        expect(registered.some((id) => id.endsWith(`_${overflow.id}`))).toBe(false);
      } finally {
        proto.close = originalClose;
      }
      await service.shutdown();
    }, 15000);

    it('abandons adoption silently when the engine session is gone', async () => {
      const { service, sessionId, fakePage, fakeSession } = await harness();
      (fakeSession as { pages: () => Promise<unknown> }).pages = async () => {
        throw new Error('engine gone');
      };
      fakePage.emitEvent('page.created', {
        openerPageId: fakePage.id,
        pageId: 'fake-page-brand-new',
      });
      await letPumpSettle();
      expect(await service.listPages(sessionId)).toHaveLength(1);
      await service.shutdown();
    });

    it('abandons adoption when the popup id never existed engine-side', async () => {
      const { service, sessionId, fakePage } = await harness();
      fakePage.emitEvent('page.created', {
        openerPageId: fakePage.id,
        pageId: 'fake-page-ghost',
      });
      await letPumpSettle();
      expect(await service.listPages(sessionId)).toHaveLength(1);
      await service.shutdown();
    });
  });

  describe('engine crash surfaces', () => {
    async function crashHarness() {
      const engine = new FakeEngine();
      const service = new AgentBrowserService({ engine, metrics: new MetricsRegistry() });
      const sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await service.createPage(sessionId)).pageId;
      const fakePage = engine.getFakePage(engine.getSessionIds()[0] as string, pageId);
      fakePage?.crash('capture crashed mid-read');
      return {
        service,
        sessionId,
        pageId,
        fakePage: fakePage as FakePageLike,
      };
    }

    it('maps a crash during html export to ENGINE_CRASHED and terminates the session', async () => {
      const { service, sessionId, pageId } = await crashHarness();
      const error = await capture(() => service.exportHtml(sessionId, pageId));
      expect(error?.code).toBe('ENGINE_CRASHED');
      expect(error?.retryable).toBe(false);
      expect(error?.details?.errorDetail).toBe('capture crashed mid-read');
      expect(service.getSession(sessionId)).toBeUndefined();
      expect(service.getCrashLog()[0]).toMatchObject({
        sessionId,
        reason: 'exportHtml: engine crashed',
      });
      await service.shutdown();
    });

    it('maps a crash during pdf capture to ENGINE_CRASHED', async () => {
      const { service, sessionId, pageId, fakePage } = await crashHarness();
      // FakePage.pdf does not check crash state; inject the crash on the
      // capture seam itself the way a real engine would fail.
      (fakePage as { pdf: () => Promise<unknown> }).pdf = async () => {
        throw new Error('pdf capture crashed mid-read');
      };
      const error = await capture(() => service.pdf(sessionId, pageId, {}));
      expect(error?.code).toBe('ENGINE_CRASHED');
      expect(error?.details?.errorDetail).toBe('pdf capture crashed mid-read');
      expect(service.getCrashLog()[0]?.reason).toBe('pdf: engine crashed');
      await service.shutdown();
    });

    it('maps a crash during extraction to ENGINE_CRASHED', async () => {
      const { service, sessionId, pageId } = await crashHarness();
      const error = await capture(() => service.extract(sessionId, pageId, { format: 'text' }));
      expect(error?.code).toBe('ENGINE_CRASHED');
      expect(service.getCrashLog()[0]?.reason).toBe('extract: engine crashed');
      await service.shutdown();
    });

    it('maps a crash during screenshot capture to ENGINE_CRASHED', async () => {
      const { service, sessionId, pageId, fakePage } = await crashHarness();
      (fakePage as { screenshot: () => Promise<unknown> }).screenshot = async () => {
        throw new Error('screenshot capture crashed mid-read');
      };
      const error = await capture(() => service.screenshot(sessionId, pageId, {}));
      expect(error?.code).toBe('ENGINE_CRASHED');
      expect(service.getCrashLog()[0]?.reason).toBe('screenshot: engine crashed');
      await service.shutdown();
    });
  });

  describe('orchestration envelopes', () => {
    it('rejects a batch envelope nested inside a plan step', async () => {
      const { service, sessionId, pageId } = await harness();
      const plan = await service.executePlan(sessionId, pageId, [
        { steps: [{ action: 'press', key: 'Tab' }] } as unknown as ServiceActRequest,
      ]);
      expect(plan.ok).toBe(false);
      expect(plan.completed).toBe(0);
      expect(plan.error).toEqual({
        code: 'PLAN_STEP_FAILED',
        message: "'steps' cannot be nested inside a plan step.",
      });
      expect(plan.results[0]).toMatchObject({ step: 0, ok: false });
      await service.shutdown();
    });

    it('reports PLAN_WAIT_TIMEOUT when a waited-for label never becomes actionable', async () => {
      const { service, sessionId, pageId, fakePage } = await harness();
      // The raw engine stream never produces the waited-for element at all.
      fakePage.setElements([{ role: 'generic', name: 'Unrelated' }]);
      const plan = await service.executePlan(sessionId, pageId, [
        { action: 'click', waitForLabel: 'Phantom Submit', waitMs: 150 },
      ]);
      expect(plan.ok).toBe(false);
      expect(plan.error?.code).toBe('PLAN_WAIT_TIMEOUT');
      expect(plan.error?.message).toMatch(/no element matching 'Phantom Submit' appeared/);
      await service.shutdown();
    });

    it('rejects an unparseable outcome run request', async () => {
      const { service, sessionId, pageId } = await harness();
      const error = await capture(() => service.executeOutcome(sessionId, pageId, { nope: 1 }));
      expect(error).toMatchObject({
        code: 'INVALID_REQUEST',
        message: 'Invalid outcome run request.',
      });
      await service.shutdown();
    });

    it('refuses outcome runs when verification is not configured', async () => {
      const { service, sessionId, pageId } = await harness();
      const error = await capture(() =>
        service.executeOutcome(sessionId, pageId, {
          actions: [{ action: 'press', key: 'Tab' }],
          verification: { verifier: { id: 'some.verifier', version: '1' }, input: 1 },
        })
      );
      expect(error?.code).toBe('INVALID_REQUEST');
      expect(error?.message).toBe('Outcome verification is not configured.');
      await service.shutdown();
    });
  });

  describe('application surface validation', () => {
    it('rejects an application bind body without adapter and resource', async () => {
      const { service, sessionId } = await harness();
      const error = await capture(() =>
        service.applicationBind(sessionId, { actor: 'operator', tenant: 't1' }, {})
      );
      expect(error?.code).toBe('INVALID_REQUEST');
      expect(error?.message).toMatch(/^Invalid application bind request: /);
      await service.shutdown();
    });

    it('rejects an application execute body missing required fields', async () => {
      const { service, sessionId } = await harness();
      const error = await capture(() =>
        service.applicationExecute(sessionId, { actor: 'operator', tenant: 't1' }, {})
      );
      expect(error?.code).toBe('INVALID_REQUEST');
      expect(error?.message).toMatch(/^Invalid application execute request: /);
      await service.shutdown();
    });
  });

  describe('page and navigation edges', () => {
    it('rejects a non-string url at page creation', async () => {
      const { service, sessionId } = await harness();
      const error = await capture(() =>
        service.createPage(sessionId, { url: 42 as unknown as string })
      );
      expect(error?.code).toBe('INVALID_REQUEST');
      expect(error?.message).toBe('url must be a string');
      await service.shutdown();
    });

    it('propagates a non-crash navigation failure and keeps the session alive', async () => {
      const { service, sessionId, pageId, fakePage } = await harness();
      (fakePage as { navigate: () => Promise<unknown> }).navigate = async () => {
        throw new Error('navigation boom');
      };
      await expect(
        service.navigate(sessionId, pageId, { url: 'https://example.com/next' })
      ).rejects.toThrow('navigation boom');
      expect(service.getSession(sessionId)).toBeDefined();
      await service.shutdown();
    });

    it('requires a positive integer sinceRevision', async () => {
      const { service, sessionId, pageId } = await harness();
      await service.observe(sessionId, pageId, {});
      for (const bad of [0, -3, 2.5]) {
        const error = await capture(() =>
          service.observe(sessionId, pageId, { sinceRevision: bad })
        );
        expect(error?.code).toBe('INVALID_REQUEST');
        expect(error?.message).toContain('Invalid sinceRevision');
      }
      await service.shutdown();
    });

    it('reports SESSION_NOT_FOUND (not page NOT_FOUND) once the session is gone', async () => {
      const { service, sessionId, pageId } = await harness();
      await service.closeSession(sessionId);
      const error = await capture(() => service.observe(sessionId, pageId, {}));
      expect(error?.code).toBe('SESSION_NOT_FOUND');
      expect(error?.message).toBe(`Session ${sessionId} does not exist.`);
      await service.shutdown();
    });
  });

  describe('action validation and secrets', () => {
    it('rejects an undelivered action with the validation issues attached', async () => {
      const { service, sessionId, pageId } = await harness();
      await service.observe(sessionId, pageId, {});
      const error = await capture(() =>
        service.act(sessionId, pageId, { action: 'teleport' } as unknown as ServiceActRequest)
      );
      expect(error?.code).toBe('INVALID_REQUEST');
      expect(error?.message).toMatch(/^Invalid action: /);
      expect(Array.isArray(error?.details?.issues)).toBe(true);
      await service.shutdown();
    });

    it('maps a non-SecretError vault failure to INTERNAL without leaking the fill', async () => {
      class BrokenVault extends SecretManager {
        override isReference(): boolean {
          return true;
        }

        override async resolve(): Promise<string> {
          throw new Error('vault offline');
        }
      }
      const engine = new FakeEngine();
      const service = new AgentBrowserService({ engine, secretManager: new BrokenVault() });
      const sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await service.createPage(sessionId)).pageId;
      await service.navigate(sessionId, pageId, { url: 'https://example.com/' });
      const observation = await service.observe(sessionId, pageId, {});
      const ref = observation.elements[0]?.ref as string;

      const error = await capture(() =>
        service.act(sessionId, pageId, {
          action: 'fill',
          target: { ref },
          value: 'vault://db/password',
        })
      );
      expect(error?.code).toBe('INTERNAL');
      expect(error?.message).toBe('Error: vault offline');
      await service.shutdown();
    });
  });

  describe('opt-in remap with no surviving candidate', () => {
    it('refuses with an explicit zero-candidate detail instead of guessing', async () => {
      const { service, sessionId, pageId, fakePage } = await harness();
      const observation = await service.observe(sessionId, pageId, {});
      const staleRef = observation.elements[0]?.ref as string;
      // The revision bump makes the stale ref a healable binding refusal;
      // removing the element entirely leaves zero remap candidates.
      await service.navigate(sessionId, pageId, { url: 'https://example.com/next' });
      fakePage.setElements([{ role: 'button', name: 'Something Else' }]);
      await service.observe(sessionId, pageId, {});

      const error = await capture(() =>
        service.act(sessionId, pageId, {
          action: 'click',
          target: { ref: staleRef },
          remap: true,
        })
      );
      expect(error?.code).toBe('STALE_TARGET');
      expect(error?.retryable).toBe(true);
      expect(error?.message).toMatch(/no element matching role 'button'/);
      expect(error?.message).toMatch(/the control is gone/);
      expect(error?.details?.candidates).toBe(0);
      await service.shutdown();
    });
  });

  describe('post-action wait deadlines', () => {
    async function waitHarness() {
      const built = await harness();
      await built.service.observe(built.sessionId, built.pageId, {});
      const ref = (await built.service.observe(built.sessionId, built.pageId, {})).elements[0]
        ?.ref as string;
      return { ...built, ref };
    }

    it('reports settled even when the engine cannot confirm a quiet window', async () => {
      const { service, sessionId, pageId, ref, fakePage } = await waitHarness();
      (fakePage as { waitForLoadState?: () => Promise<void> }).waitForLoadState = async () => {
        throw new Error('busy page');
      };
      const result = (await service.act(sessionId, pageId, {
        action: 'click',
        target: { ref },
        wait: { until: 'settled', timeoutMs: 50 },
      })) as { status: string; waitReason?: string };
      expect(result.status).toBe('success');
      expect(result.waitReason).toBe('settled');
      await service.shutdown();
    });

    it('surfaces ACTION_TIMEOUT when a load-state wait misses its deadline', async () => {
      const { service, sessionId, pageId, ref, fakePage } = await waitHarness();
      (fakePage as { waitForLoadState?: () => Promise<void> }).waitForLoadState = async () => {
        throw new Error('still loading');
      };
      const error = await capture(() =>
        service.act(sessionId, pageId, {
          action: 'click',
          target: { ref },
          wait: { until: 'load', timeoutMs: 50 },
        })
      );
      expect(error?.code).toBe('ACTION_TIMEOUT');
      expect(error?.retryable).toBe(true);
      expect(error?.details).toMatchObject({ until: 'load', timeoutMs: 50 });
      await service.shutdown();
    });

    it('surfaces ACTION_TIMEOUT when a minElements wait cannot observe at all', async () => {
      const { service, sessionId, pageId, ref, fakePage } = await waitHarness();
      (fakePage as { observe: () => Promise<unknown> }).observe = async () => {
        throw new Error('detached frame');
      };
      const error = await capture(() =>
        service.act(sessionId, pageId, {
          action: 'click',
          target: { ref },
          wait: { until: 'minElements', count: 1, timeoutMs: 1 },
        })
      );
      expect(error?.code).toBe('ACTION_TIMEOUT');
      expect(error?.details).toMatchObject({ until: 'minElements', count: 1, observed: 0 });
      await service.shutdown();
    });

    it('omits the timeout diagnostic screenshot when the capture carries no bytes', async () => {
      const { service, sessionId, pageId, ref, fakePage } = await waitHarness();
      (fakePage as { waitForLoadState?: () => Promise<void> }).waitForLoadState = async () => {
        throw new Error('never settles');
      };
      (fakePage as { screenshot: () => Promise<unknown> }).screenshot = async () => ({
        contentType: 'image/png',
      });
      const error = await capture(() =>
        service.act(sessionId, pageId, {
          action: 'click',
          target: { ref },
          wait: { until: 'load', timeoutMs: 50 },
        })
      );
      expect(error?.code).toBe('ACTION_TIMEOUT');
      expect(error?.details?.screenshotArtifactId).toBeUndefined();
      await service.shutdown();
    });
  });

  describe('capture capability boundaries', () => {
    it('refuses pdf capture on an engine without pdf support', async () => {
      const { service, sessionId, pageId, fakePage } = await harness();
      (fakePage as { pdf?: unknown }).pdf = undefined;
      const error = await capture(() => service.pdf(sessionId, pageId, {}));
      expect(error?.code).toBe('ENGINE_UNSUPPORTED');
      expect(error?.message).toMatch(/does not support PDF capture/);
      await service.shutdown();
    });
  });

  describe('download artifact failure mapping', () => {
    const downloader = async () => ({
      bytes: new TextEncoder().encode('payload'),
      contentType: 'text/plain',
    });

    async function downloadHarness(artifactStore: ArtifactStore) {
      const engine = new FakeEngine();
      const service = new AgentBrowserService({ engine, artifactStore, downloader });
      const sessionId = (
        await service.createSession({
          tenantId: 't1',
          allowDownloads: true,
        } as Partial<ServiceSessionRequest>)
      ).sessionId;
      const pageId = (await service.createPage(sessionId)).pageId;
      return { service, sessionId, pageId };
    }

    it('maps ARTIFACT_TOO_LARGE from the artifact store to DOWNLOAD_BLOCKED', async () => {
      class TooLargeStore extends ArtifactStore {
        override put(): ReturnType<ArtifactStore['put']> {
          throw Object.assign(new Error('too large'), { code: 'ARTIFACT_TOO_LARGE' });
        }
      }
      const { service, sessionId, pageId } = await downloadHarness(new TooLargeStore());
      const error = await capture(() =>
        service.download(sessionId, pageId, { url: 'https://files.example.com/a.txt' })
      );
      expect(error?.code).toBe('DOWNLOAD_BLOCKED');
      expect(error?.message).toBe('too large');
      await service.shutdown();
    });

    it('maps an unexpected artifact-store failure to INTERNAL', async () => {
      class BrokenStore extends ArtifactStore {
        override put(): ReturnType<ArtifactStore['put']> {
          throw new Error('disk on fire');
        }
      }
      const { service, sessionId, pageId } = await downloadHarness(new BrokenStore());
      const error = await capture(() =>
        service.download(sessionId, pageId, { url: 'https://files.example.com/a.txt' })
      );
      expect(error?.code).toBe('INTERNAL');
      expect(error?.message).toBe('disk on fire');
      await service.shutdown();
    });
  });

  describe('collected downloads', () => {
    function withTakeDownload(
      fakeSession: object,
      impl: () => { bytes: Uint8Array; filename?: string } | undefined
    ): void {
      (fakeSession as { takeDownload: unknown }).takeDownload = async () => impl();
    }

    async function downloadHarness(maxDownloadBytes?: number) {
      const engine = new FakeEngine();
      const service = new AgentBrowserService({ engine });
      const sessionId = (
        await service.createSession({
          tenantId: 't1',
          allowDownloads: true,
          ...(maxDownloadBytes !== undefined ? { maxDownloadBytes } : {}),
        } as Partial<ServiceSessionRequest>)
      ).sessionId;
      const pageId = (await service.createPage(sessionId)).pageId;
      const fakeSession = engine.getSession(engine.getSessionIds()[0] as string);
      if (!fakeSession) throw new Error('no fake session');
      return { service, sessionId, pageId, fakeSession };
    }

    it('blocks a captured download over the session byte limit', async () => {
      const { service, sessionId, pageId, fakeSession } = await downloadHarness(4);
      withTakeDownload(fakeSession, () => ({ bytes: new Uint8Array(10) }));
      const error = await capture(() => service.collectDownload(sessionId, pageId, 'big.bin'));
      expect(error?.code).toBe('DOWNLOAD_BLOCKED');
      expect(error?.message).toMatch(/exceeds the session byte limit/);
      await service.shutdown();
    });

    it('derives the artifact content type from the captured filename', async () => {
      const { service, sessionId, pageId, fakeSession } = await downloadHarness();
      withTakeDownload(fakeSession, () => ({
        bytes: new TextEncoder().encode('{"a":1}'),
        filename: 'export.json',
      }));
      const jsonArtifact = await service.collectDownload(sessionId, pageId, 'ignored');
      expect(jsonArtifact.contentType).toBe('application/json');

      withTakeDownload(fakeSession, () => ({
        bytes: new Uint8Array([0, 1, 2]),
        filename: 'blob.bin',
      }));
      const binaryArtifact = await service.collectDownload(sessionId, pageId, 'ignored');
      expect(binaryArtifact.contentType).toBe('application/octet-stream');
      await service.shutdown();
    });
  });

  describe('approval flow without a cached page url', () => {
    it('falls back to a live observation for the approval context url', async () => {
      const { service, sessionId, pageId, fakePage } = await harness();
      fakePage.setElements([{ role: 'button', name: 'Pay now', risk: 'transaction' }]);
      // No synchronous url cache: checkApproval must observe to classify.
      (fakePage as { getUrl?: unknown }).getUrl = undefined;
      const observation = await service.observe(sessionId, pageId, {});
      const ref = observation.elements[0]?.ref as string;

      const error = await capture(() =>
        service.act(sessionId, pageId, { action: 'click', target: { ref } })
      );
      expect(error?.code).toBe('APPROVAL_REQUIRED');
      expect(error?.details?.tokenId).toEqual(expect.any(String));
      expect(error?.details?.effect).toBe('transaction');
      await service.shutdown();
    });
  });

  describe('non-crash engine failures rethrow unchanged', () => {
    it('propagates a plain observation failure through html export and extraction', async () => {
      const { service, sessionId, pageId, fakePage } = await harness();
      (fakePage as { observe: () => Promise<unknown> }).observe = async () => {
        throw new Error('plain observe boom');
      };
      await expect(service.exportHtml(sessionId, pageId)).rejects.toThrow('plain observe boom');
      await expect(service.extract(sessionId, pageId, { format: 'text' })).rejects.toThrow(
        'plain observe boom'
      );
      // Neither path treated it as a crash: the session survives.
      expect(service.getSession(sessionId)).toBeDefined();
      await service.shutdown();
    });

    it('propagates a plain pdf failure without terminating the session', async () => {
      const { service, sessionId, pageId, fakePage } = await harness();
      (fakePage as { pdf: () => Promise<unknown> }).pdf = async () => {
        throw new Error('plain pdf boom');
      };
      await expect(service.pdf(sessionId, pageId, {})).rejects.toThrow('plain pdf boom');
      expect(service.getSession(sessionId)).toBeDefined();
      await service.shutdown();
    });

    it('propagates a plain screenshot failure without terminating the session', async () => {
      const { service, sessionId, pageId, fakePage } = await harness();
      (fakePage as { screenshot: () => Promise<unknown> }).screenshot = async () => {
        throw new Error('plain screenshot boom');
      };
      await expect(service.screenshot(sessionId, pageId, {})).rejects.toThrow(
        'plain screenshot boom'
      );
      expect(service.getSession(sessionId)).toBeDefined();
      await service.shutdown();
    });
  });

  describe('page creation races', () => {
    it('rejects page creation when the session ends while the engine page opens', async () => {
      const { service, sessionId, fakePage, fakeSession } = await harness();
      const originalNewPage = fakeSession.newPage.bind(fakeSession);
      (fakeSession as { newPage: () => Promise<unknown> }).newPage = async () => {
        const page = await originalNewPage();
        await service.closeSession(sessionId);
        void fakePage;
        return page;
      };
      const error = await capture(() => service.createPage(sessionId));
      expect(error?.code).toBe('SESSION_NOT_FOUND');
      expect(error?.message).toBe('Session ended during page creation');
      expect(service.getSession(sessionId)).toBeUndefined();
      await service.shutdown();
    });

    it('tears the page down and reports the navigate failure even when close refuses', async () => {
      const { service, sessionId, fakePage, fakeSession } = await harness();
      const originalNewPage = fakeSession.newPage.bind(fakeSession);
      let sabotaged: { close: () => Promise<void> } | undefined;
      (fakeSession as { newPage: () => Promise<unknown> }).newPage = async () => {
        const page = (await originalNewPage()) as {
          navigate: () => Promise<unknown>;
          close: () => Promise<void>;
        };
        page.navigate = async () => {
          throw new Error('refused');
        };
        page.close = async () => {
          throw new Error('close refused');
        };
        sabotaged = page;
        return page;
      };
      void fakePage;
      try {
        await expect(
          service.createPage(sessionId, { url: 'https://x.example.com/' })
        ).rejects.toThrow('refused');
        // The failed page was deregistered despite the refusing close.
        expect(await service.listPages(sessionId)).toHaveLength(1);
      } finally {
        // Undo the close sabotage so engine teardown can reap the page.
        if (sabotaged) {
          const proto = Object.getPrototypeOf(sabotaged) as { close: () => Promise<void> };
          sabotaged.close = proto.close.bind(sabotaged);
        }
      }
      await service.shutdown();
    });
  });

  describe('remap without a retained baseline', () => {
    it('refuses a future-revision ref without guessing', async () => {
      const { service, sessionId, pageId } = await harness();
      await service.observe(sessionId, pageId, {});
      // e9_9 was never minted: the executor refuses the binding, and the
      // heal finds no retained baseline for the ref's revision.
      const error = await capture(() =>
        service.act(sessionId, pageId, {
          action: 'click',
          target: { ref: 'e9_9' },
          remap: true,
        })
      );
      expect(error?.code).toBe('STALE_TARGET');
      expect(error?.retryable).toBe(false);
      expect(error?.message).toMatch(/e9_9 belongs to revision 9/);
      await service.shutdown();
    });
  });

  describe('executor timeout diagnostics', () => {
    it('omits the diagnostic screenshot when the capture has no payload', async () => {
      const { service, sessionId, pageId, fakePage } = await harness();
      const observation = await service.observe(sessionId, pageId, {});
      const ref = observation.elements[0]?.ref as string;
      (fakePage as { act: () => Promise<unknown> }).act = async () => {
        throw new Error('engine act timed out');
      };
      (fakePage as { screenshot: () => Promise<unknown> }).screenshot = async () => ({
        contentType: 'image/png',
      });
      const error = await capture(() =>
        service.act(sessionId, pageId, { action: 'click', target: { ref } })
      );
      expect(error?.code).toBe('ACTION_TIMEOUT');
      expect(error?.message).toMatch(/timed out/);
      expect(error?.details?.screenshotArtifactId).toBeUndefined();
      await service.shutdown();
    });
  });

  describe('extraction request bounds', () => {
    it('rejects oversized records and schema payloads', async () => {
      const { service, sessionId, pageId } = await harness();
      const giantField = 'y'.repeat(70_000);

      const recordsError = await capture(() =>
        service.extract(sessionId, pageId, {
          format: 'records',
          records: { container: 'main', fields: { name: giantField } },
        })
      );
      expect(recordsError?.code).toBe('INVALID_REQUEST');
      expect(recordsError?.message).toBe('records exceeds the 64 KiB bound.');

      const schemaError = await capture(() =>
        service.extract(sessionId, pageId, {
          format: 'schema',
          schema: { properties: { name: { type: giantField } } },
        })
      );
      expect(schemaError?.code).toBe('INVALID_REQUEST');
      expect(schemaError?.message).toBe('schema exceeds the 64 KiB bound.');
      await service.shutdown();
    });

    it('validates the records container before any page work', async () => {
      const { service, sessionId, pageId } = await harness();
      for (const container of [undefined, '', '   ']) {
        const error = await capture(() =>
          service.extract(sessionId, pageId, {
            format: 'records',
            records: { container: container as string, fields: { name: 'h1' } },
          })
        );
        expect(error?.code).toBe('INVALID_REQUEST');
        expect(error?.message).toBe("records 'container' must be a non-empty CSS selector.");
      }
      await service.shutdown();
    });

    it('validates the schema required list', async () => {
      const { service, sessionId, pageId } = await harness();
      for (const required of ['name', [1, 2]]) {
        const error = await capture(() =>
          service.extract(sessionId, pageId, {
            format: 'schema',
            schema: { properties: { name: { type: 'string' } }, required: required as never },
          })
        );
        expect(error?.code).toBe('INVALID_REQUEST');
        expect(error?.message).toBe("schema 'required' must be an array of strings.");
      }
      await service.shutdown();
    });
  });
});
