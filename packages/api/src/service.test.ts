/**
 * TDD Tests for AgentBrowserService
 *
 * The service is the composition root that wires the real stack together:
 * SessionCoordinator for lifecycle, an injected BrowserEngine, the
 * ObservationNormalizer for semantic observations, the ActionExecutor for
 * ref-based actions, NetworkPolicy for navigation egress, and the ApprovalGate
 * for high-risk elements. Tests run against FakeEngine, which is the reference
 * contract implementation.
 */

import {
  ArtifactStore,
  InMemoryTracer,
  MetricsRegistry,
  SecretManager,
  StructuredLogger,
} from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentBrowserService } from './service';
import { ServiceError } from './service';

describe('AgentBrowserService', () => {
  let engine: FakeEngine;
  let service: AgentBrowserService;
  let serviceB: AgentBrowserService;

  beforeEach(() => {
    engine = new FakeEngine();
    const engineB = new FakeEngine();
    (engineB as unknown as { _name: string })._name = 'fake-engine-b';
    service = new AgentBrowserService({ engine });
    serviceB = new AgentBrowserService({
      engine,
      engines: { 'fake-engine-b': engineB },
    });
  });

  describe('session lifecycle', () => {
    it('should create a session through the coordinator', async () => {
      const session = await service.createSession({ tenantId: 'tenant_1' });

      expect(session.sessionId).toMatch(/^ses_/);
      expect(session.status).toBe('ready');
      expect(session.engine.name).toBe('fake-engine');
      expect(session.createdAt).toEqual(expect.any(String));
      expect(session.ttlMs).toBeGreaterThan(0);
    });

    it('should list created sessions', async () => {
      const a = await service.createSession({ tenantId: 't1' });
      const b = await service.createSession({ tenantId: 't2' });

      const ids = service.listSessions().map((s) => s.sessionId);
      expect(ids).toContain(a.sessionId);
      expect(ids).toContain(b.sessionId);
    });

    it('should get a session by id', async () => {
      const created = await service.createSession({ tenantId: 't1' });
      const found = service.getSession(created.sessionId);

      expect(found?.sessionId).toBe(created.sessionId);
    });

    it('should return undefined for an unknown session', () => {
      expect(service.getSession('ses_missing')).toBeUndefined();
    });

    it('should close a session and release its pages', async () => {
      const created = await service.createSession({ tenantId: 't1' });
      const page = await service.createPage(created.sessionId);

      await service.closeSession(created.sessionId);

      expect(service.getSession(created.sessionId)).toBeUndefined();
      expect(engine.hasSession(created.sessionId)).toBe(false);
      await expect(service.closePage(created.sessionId, page.pageId)).rejects.toThrow(ServiceError);
    });

    it('should reject closing an unknown session', async () => {
      await expect(service.closeSession('ses_missing')).rejects.toThrow(ServiceError);
    });
  });

  describe('engine registry (TD-BROWSER-7 Phase 1)', () => {
    it('routes by engine name to a registered auxiliary engine', async () => {
      const result = await serviceB.createSession({ tenantId: 't1', engine: 'fake-engine-b' });
      expect(result.engine.name).toBe('fake-engine-b');
    });

    it('defaults to the primary engine', async () => {
      const result = await service.createSession({ tenantId: 't1' });
      expect(result.engine.name).toBe('fake-engine');
    });

    it('fails loudly on an unknown engine name', async () => {
      await expect(service.createSession({ tenantId: 't1', engine: 'safari' })).rejects.toThrow(
        /ENGINE_NOT_FOUND/
      );
    });
  });

  describe('action plans (TD-BROWSER-8)', () => {
    it('executes a multi-step plan in one call', async () => {
      const session = await service.createSession({ tenantId: 't1' });
      const pageId = (await service.createPage(session.sessionId)).pageId;
      await service.navigate(session.sessionId, pageId, { url: 'https://example.com/' });
      const obs = (await service.observe(session.sessionId, pageId, {
        mode: 'interactive',
      })) as unknown as { elements: Array<{ ref: string }> };
      const ref = obs.elements[0].ref;

      const result = await service.executePlan(session.sessionId, pageId, [
        { action: 'click', target: { ref } },
        { action: 'click', target: { ref } },
      ]);
      expect(result.ok).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.results.every((r) => r.ok)).toBe(true);
    });

    it('pressure matrix row 1: a static 5-field form completes in one call with zero intermediate observations', async () => {
      const session = await service.createSession({ tenantId: 't1' });
      const pageId = (await service.createPage(session.sessionId)).pageId;
      await service.navigate(session.sessionId, pageId, { url: 'https://example.com/' });

      const engineSessionId = engine.getSessionIds()[engine.getSessionIds().length - 1];
      const fakePage = engine.getFakePage(engineSessionId as string, pageId);
      fakePage?.setElements([
        { role: 'textbox', name: 'Name' },
        { role: 'textbox', name: 'Email' },
        { role: 'textbox', name: 'Company' },
        { role: 'textbox', name: 'Role' },
        { role: 'button', name: 'Submit' },
      ]);
      const obs = (await service.observe(session.sessionId, pageId, {
        mode: 'interactive',
      })) as unknown as { elements: Array<{ ref: string }> };
      const refs = obs.elements.map((e) => e.ref);

      const result = await service.executePlan(session.sessionId, pageId, [
        { action: 'fill', target: { ref: refs[0] }, value: 'Ada' },
        { action: 'fill', target: { ref: refs[1] }, value: 'ada@example.com' },
        { action: 'fill', target: { ref: refs[2] }, value: 'Acme' },
        { action: 'fill', target: { ref: refs[3] }, value: 'Engineer' },
        { action: 'click', target: { ref: refs[4] } },
      ]);

      expect(result.ok).toBe(true);
      expect(result.completed).toBe(5);
      expect(result.results).toHaveLength(5);
      // Per-step results carry only the outcome, never an embedded
      // observation - that is only opted into via observe:'after'.
      for (const stepResult of result.results) {
        expect(Object.keys(stepResult).sort()).toEqual(['actionId', 'ok', 'step'].sort());
      }
      expect(typeof result.newRevision).toBe('number');
    });

    it('pressure matrix row 3: a re-rendering list under sustained churn never mis-clicks and stays in VERIFIED mode', async () => {
      // Note on churn arithmetic: a successful remap now decays its own
      // bump (the C3 fix), so a single stale-and-recovered step nets to
      // ZERO churn change - churn cannot climb from a clean baseline while
      // every step keeps succeeding (by design: resolved instability isn't
      // held against the session forever). This test instead reflects the
      // matrix's real intent under SUSTAINED high churn (comfortably above
      // the verified threshold, as real repeated flakiness would produce):
      // every step still finds the correct element by role+label - never
      // guessing under a re-rendering list - and the session stays pinned
      // in verified mode throughout, not just for one lucky step.
      const session = await service.createSession({ tenantId: 't1' });
      const pageId = (await service.createPage(session.sessionId)).pageId;
      await service.navigate(session.sessionId, pageId, { url: 'https://example.com/' });

      const engineSessionId = engine.getSessionIds()[engine.getSessionIds().length - 1];
      const fakePage = engine.getFakePage(engineSessionId as string, pageId);
      fakePage?.setElements([{ role: 'button', name: 'Item' }]);
      const obs = (await service.observe(session.sessionId, pageId, {
        mode: 'interactive',
      })) as unknown as { elements: Array<{ ref: string }> };
      const staleRef = obs.elements[0].ref;

      const churnKey = `${session.sessionId}:${pageId}`;
      const churn = (service as unknown as { churn: Map<string, number> }).churn;
      churn.set(churnKey, 5);

      await service.act(session.sessionId, pageId, { action: 'scroll', direction: 'down' });

      const result = await service.executePlan(session.sessionId, pageId, [
        { action: 'click', target: { ref: staleRef } },
        { action: 'click', target: { ref: staleRef } },
        { action: 'click', target: { ref: staleRef } },
      ]);

      expect(result.ok).toBe(true);
      expect(result.results.every((r) => r.ok)).toBe(true);
      expect(result.mode).toBe('verified');
      // Sustained, not runaway: each resolved step nets back to baseline.
      expect(churn.get(churnKey)).toBe(5);
    });

    it('pressure matrix row 4: snapshot bytes are bounded by maxElements/maxBytes', async () => {
      const session = await service.createSession({ tenantId: 't1' });
      const pageId = (await service.createPage(session.sessionId)).pageId;
      await service.navigate(session.sessionId, pageId, { url: 'https://example.com/' });

      const engineSessionId = engine.getSessionIds()[engine.getSessionIds().length - 1];
      const fakePage = engine.getFakePage(engineSessionId as string, pageId);
      fakePage?.setElements(
        Array.from({ length: 40 }, (_, i) => ({ role: 'button', name: `Item ${i}` }))
      );

      const full = await service.getSnapshot(session.sessionId, pageId);
      expect(full.fields.length).toBe(40);

      const bounded = await service.getSnapshot(session.sessionId, pageId, { maxElements: 5 });
      expect(bounded.fields.length).toBeLessThanOrEqual(5);
      expect(bounded.truncated).toBe(true);

      const byteBudget = Buffer.byteLength(JSON.stringify(full), 'utf8') - 200;
      const byteBounded = await service.getSnapshot(session.sessionId, pageId, {
        maxBytes: byteBudget,
      });
      expect(byteBounded.fields.length).toBeLessThan(40);
    });

    it('aborts on the first failing step and reports progress', async () => {
      const session = await service.createSession({ tenantId: 't1' });
      const pageId = (await service.createPage(session.sessionId)).pageId;
      const result = await service.executePlan(session.sessionId, pageId, [
        { action: 'click', target: { ref: 'e999999_999' } },
        { action: 'click', target: { ref: 'e1_0' } },
      ]);
      expect(result.ok).toBe(false);
      expect(result.completed).toBe(0);
      expect(result.error).toBeDefined();
    });

    it('waitForLabel waits for a click-revealed field before the next step runs (TD-BROWSER-8 Phase 2)', async () => {
      const session = await service.createSession({ tenantId: 't1' });
      const pageId = (await service.createPage(session.sessionId)).pageId;
      await service.navigate(session.sessionId, pageId, { url: 'https://example.com/' });

      const engineSessionId = engine.getSessionIds()[engine.getSessionIds().length - 1];
      const fakePage = engine.getFakePage(engineSessionId as string, pageId);
      fakePage?.setElements([{ role: 'button', name: 'Continue' }]);
      const obs = (await service.observe(session.sessionId, pageId, {
        mode: 'interactive',
      })) as unknown as { elements: Array<{ ref: string }> };
      const continueRef = obs.elements[0].ref;

      // The password field is NOT present yet; it appears asynchronously
      // as a consequence of the click (never synchronously - a
      // synchronous reveal would pass even without a real poll loop).
      fakePage?.revealAfterClick('Continue', [{ role: 'textbox', name: 'Password' }], 80);

      const result = await service.executePlan(session.sessionId, pageId, [
        { action: 'click', target: { ref: continueRef } },
        { action: 'fill', waitForLabel: 'Password', value: 'hunter2' } as never,
      ]);

      expect(result.ok).toBe(true);
      expect(result.results).toHaveLength(2);
    });

    it('waitForLabel surfaces a typed timeout instead of hanging when the label never appears', async () => {
      const session = await service.createSession({ tenantId: 't1' });
      const pageId = (await service.createPage(session.sessionId)).pageId;
      await service.navigate(session.sessionId, pageId, { url: 'https://example.com/' });

      const result = await service.executePlan(session.sessionId, pageId, [
        { action: 'click', waitForLabel: 'Never Appears', waitMs: 120 } as never,
      ]);

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('PLAN_WAIT_TIMEOUT');
      expect(result.error?.message).toMatch(/Never Appears/);
    });

    it('rejects garbage waitMs instantly instead of hanging the poll loop (v1.8.1 defect)', async () => {
      // Regression: waitMs arrives at waitForLabel unvalidated. "abc"
      // string-concatenates into a NaN deadline (Date.now() >= NaN is
      // always false -> the poll loop never exits); 1e308 does the same
      // via an Infinity deadline. Both wedged a request handler forever.
      const session = await service.createSession({ tenantId: 't1' });
      const pageId = (await service.createPage(session.sessionId)).pageId;
      await service.navigate(session.sessionId, pageId, { url: 'https://example.com/' });

      for (const bad of ['abc', 1e308, -1, 0, 61_000, Number.NaN]) {
        const result = await service.executePlan(session.sessionId, pageId, [
          { action: 'click', waitForLabel: 'Anything', waitMs: bad } as never,
        ]);
        expect(result.ok).toBe(false);
        // The pre-step gate wraps any waitForLabel throw in the
        // PLAN_WAIT_TIMEOUT envelope; the message distinguishes the
        // invalid-input rejection from a genuine poll timeout.
        expect(result.error?.code).toBe('PLAN_WAIT_TIMEOUT');
        expect(result.error?.message).toMatch(/waitMs must be a finite number/);
      }
    });

    it('decays churn on a successful remap-retry step, not just the primary path', async () => {
      // Without the fix, the stale->remap path bumps churn on every step
      // that goes stale but never decays it back down on a successful
      // retry - so a plan with several remapped-but-fine steps would climb
      // monotonically and stay pinned in verified mode even after the page
      // has actually stabilized. Two remapped-and-successful steps using
      // the SAME (increasingly stale) ref should net back to the
      // pre-plan churn level, not accumulate.
      const session = await service.createSession({ tenantId: 't1' });
      const pageId = (await service.createPage(session.sessionId)).pageId;
      await service.navigate(session.sessionId, pageId, { url: 'https://example.com/' });

      const engineSessionId = engine.getSessionIds()[engine.getSessionIds().length - 1];
      const fakePage = engine.getFakePage(engineSessionId as string, pageId);
      fakePage?.setElements([{ role: 'button', name: 'Submit' }]);
      const obs = (await service.observe(session.sessionId, pageId, {
        mode: 'interactive',
      })) as unknown as { elements: Array<{ ref: string }> };
      const ref = obs.elements[0].ref;

      const churnKey = `${session.sessionId}:${pageId}`;
      const churn = (service as unknown as { churn: Map<string, number> }).churn;
      churn.set(churnKey, 3);

      // Advance the revision so the ref is already stale before the plan
      // starts; the element still matches role+label so each remap succeeds.
      await service.act(session.sessionId, pageId, { action: 'scroll', direction: 'down' });

      const before = churn.get(churnKey) ?? 0;
      const result = await service.executePlan(session.sessionId, pageId, [
        { action: 'click', target: { ref } },
        { action: 'click', target: { ref } },
      ]);

      expect(result.ok).toBe(true);
      expect(churn.get(churnKey) ?? 0).toBe(before);
    });

    it('does not leak a churn-tracking entry after page/session teardown (TD-BROWSER-9, A8)', async () => {
      const session = await service.createSession({ tenantId: 't1' });
      const pageId = (await service.createPage(session.sessionId)).pageId;
      await service.navigate(session.sessionId, pageId, { url: 'https://example.com/' });
      const obs = (await service.observe(session.sessionId, pageId, {
        mode: 'interactive',
      })) as unknown as { elements: Array<{ ref: string }> };
      const ref = obs.elements[0].ref;

      // Reusing the same ref across two steps forces the second step's ref
      // to go stale after the first step advances the revision, exercising
      // the self-heal remap path that bumps churn for this session:page.
      await service.executePlan(session.sessionId, pageId, [
        { action: 'click', target: { ref } },
        { action: 'click', target: { ref } },
      ]);

      const churn = (service as unknown as { churn: Map<string, number> }).churn;
      const churnKey = `${session.sessionId}:${pageId}`;
      expect(churn.has(churnKey)).toBe(true);

      await service.closePage(session.sessionId, pageId);
      expect(churn.has(churnKey)).toBe(false);

      // Same check via closeSession, on a fresh page.
      const pageId2 = (await service.createPage(session.sessionId)).pageId;
      await service.navigate(session.sessionId, pageId2, { url: 'https://example.com/' });
      const obs2 = (await service.observe(session.sessionId, pageId2, {
        mode: 'interactive',
      })) as unknown as { elements: Array<{ ref: string }> };
      await service.executePlan(session.sessionId, pageId2, [
        { action: 'click', target: { ref: obs2.elements[0].ref } },
        { action: 'click', target: { ref: obs2.elements[0].ref } },
      ]);
      const churnKey2 = `${session.sessionId}:${pageId2}`;
      expect(churn.has(churnKey2)).toBe(true);

      await service.closeSession(session.sessionId);
      expect(churn.has(churnKey2)).toBe(false);
    });

    it('self-heals under verified mode when the ordinal-matched element still matches role+label', async () => {
      const session = await service.createSession({ tenantId: 't1' });
      const pageId = (await service.createPage(session.sessionId)).pageId;
      await service.navigate(session.sessionId, pageId, { url: 'https://example.com/' });

      const engineSessionId = engine.getSessionIds()[engine.getSessionIds().length - 1];
      const fakePage = engine.getFakePage(engineSessionId as string, pageId);
      fakePage?.setElements([{ role: 'button', name: 'Submit' }]);
      const obs = (await service.observe(session.sessionId, pageId, {
        mode: 'interactive',
      })) as unknown as { elements: Array<{ ref: string }> };
      const ref = obs.elements[0].ref;

      // Force verified mode directly - this test is about the
      // disambiguation logic itself, not the churn-accumulation mechanics
      // (covered separately above).
      const churn = (service as unknown as { churn: Map<string, number> }).churn;
      churn.set(`${session.sessionId}:${pageId}`, 3);

      // Advance the revision without touching lastObservation (mirrors a
      // real multi-step plan where an earlier step's action moves the page
      // past a still-unused ref from the same original observation).
      await service.act(session.sessionId, pageId, { action: 'scroll', direction: 'down' });

      const result = await service.executePlan(session.sessionId, pageId, [
        { action: 'click', target: { ref } },
      ]);

      expect(result.mode).toBe('verified');
      expect(result.ok).toBe(true);
    });

    it('refuses to guess-remap under verified mode when a different element now occupies the ordinal', async () => {
      const session = await service.createSession({ tenantId: 't1' });
      const pageId = (await service.createPage(session.sessionId)).pageId;
      await service.navigate(session.sessionId, pageId, { url: 'https://example.com/' });

      const engineSessionId = engine.getSessionIds()[engine.getSessionIds().length - 1];
      const fakePage = engine.getFakePage(engineSessionId as string, pageId);
      fakePage?.setElements([{ role: 'button', name: 'Submit' }]);
      const obs = (await service.observe(session.sessionId, pageId, {
        mode: 'interactive',
      })) as unknown as { elements: Array<{ ref: string }> };
      const ref = obs.elements[0].ref;

      const churn = (service as unknown as { churn: Map<string, number> }).churn;
      churn.set(`${session.sessionId}:${pageId}`, 3);

      await service.act(session.sessionId, pageId, { action: 'scroll', direction: 'down' });

      // The page reordered: a semantically different element now sits at
      // the same ordinal position. lastObservation (the baseline) still
      // remembers the old button - captured above, before this replaces the
      // live element - so the role/label check must catch this.
      fakePage?.setElements([{ role: 'checkbox', name: 'Agree to terms' }]);

      const result = await service.executePlan(session.sessionId, pageId, [
        { action: 'click', target: { ref } },
      ]);

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('AMBIGUOUS_REMAP');
    });

    it('remaps later stale refs of a plan from their mint-time revision, not just the first (regression: self-heal re-observe used to invalidate the baseline)', async () => {
      const session = await service.createSession({ tenantId: 't1' });
      const pageId = (await service.createPage(session.sessionId)).pageId;
      await service.navigate(session.sessionId, pageId, { url: 'https://example.com/' });

      const engineSessionId = engine.getSessionIds()[engine.getSessionIds().length - 1];
      const fakePage = engine.getFakePage(engineSessionId as string, pageId);
      fakePage?.setElements([{ role: 'button', name: 'Submit' }]);
      const obs = (await service.observe(session.sessionId, pageId, {
        mode: 'interactive',
      })) as unknown as { elements: Array<{ ref: string }> };
      const ref = obs.elements[0].ref;

      const churn = (service as unknown as { churn: Map<string, number> }).churn;
      churn.set(`${session.sessionId}:${pageId}`, 3);

      await service.act(session.sessionId, pageId, { action: 'scroll', direction: 'down' });

      // The exact flow browser_snapshot + browser_plan recommend: one plan
      // addressing the same stale ref twice. Step 1's self-heal re-observes,
      // replacing lastObservation - step 2's baseline must come from the
      // mint-time revision history, or verified mode aborts a plan that
      // stable mode completes.
      const result = await service.executePlan(session.sessionId, pageId, [
        { action: 'click', target: { ref } },
        { action: 'click', target: { ref } },
      ]);

      expect(result.ok).toBe(true);
      expect(result.mode).toBe('verified');
      expect(result.results.every((r) => r.ok)).toBe(true);
    });

    it('matches remap candidates on the redacted form of the baseline so secret-bearing labels still match', async () => {
      const secreted = new AgentBrowserService({
        engine,
        secretManager: new SecretManager({ 'vault://p': 'hunter2' }),
      });
      const session = await secreted.createSession({ tenantId: 't1' });
      const pageId = (await secreted.createPage(session.sessionId)).pageId;
      await secreted.navigate(session.sessionId, pageId, { url: 'https://example.com/' });

      const engineSessionId = engine.getSessionIds()[engine.getSessionIds().length - 1];
      const fakePage = engine.getFakePage(engineSessionId as string, pageId);
      fakePage?.setElements([{ role: 'button', name: 'Submit hunter2' }]);
      const obs = (await secreted.observe(session.sessionId, pageId, {
        mode: 'interactive',
      })) as unknown as { elements: Array<{ ref: string }> };
      const ref = obs.elements[0].ref;

      const churn = (secreted as unknown as { churn: Map<string, number> }).churn;
      churn.set(`${session.sessionId}:${pageId}`, 3);

      await secreted.act(session.sessionId, pageId, { action: 'scroll', direction: 'down' });

      // The remap candidates arrive redacted ("Submit ***"); the history
      // baseline is unredacted ("Submit hunter2"). Comparing raw would never
      // match the element to itself.
      const result = await secreted.executePlan(session.sessionId, pageId, [
        { action: 'click', target: { ref } },
      ]);

      expect(result.ok).toBe(true);
      expect(result.mode).toBe('verified');
    });

    it('reports PLAN_STEP_FAILED, not AMBIGUOUS_REMAP, when the element is gone in verified mode', async () => {
      const session = await service.createSession({ tenantId: 't1' });
      const pageId = (await service.createPage(session.sessionId)).pageId;
      await service.navigate(session.sessionId, pageId, { url: 'https://example.com/' });

      const engineSessionId = engine.getSessionIds()[engine.getSessionIds().length - 1];
      const fakePage = engine.getFakePage(engineSessionId as string, pageId);
      fakePage?.setElements([{ role: 'button', name: 'Submit' }]);
      const obs = (await service.observe(session.sessionId, pageId, {
        mode: 'interactive',
      })) as unknown as { elements: Array<{ ref: string }> };
      const ref = obs.elements[0].ref;

      const churn = (service as unknown as { churn: Map<string, number> }).churn;
      churn.set(`${session.sessionId}:${pageId}`, 3);

      // The element is removed outright: no candidate exists at any ordinal.
      fakePage?.setElements([]);

      const result = await service.executePlan(session.sessionId, pageId, [
        { action: 'click', target: { ref } },
      ]);

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('PLAN_STEP_FAILED');
      expect(result.error?.message).not.toContain('AMBIGUOUS_REMAP');
    });
  });

  describe('cookie export (TD-BROWSER-6)', () => {
    it('exports an array for a live session', async () => {
      const session = await service.createSession({ tenantId: 't1' });
      const result = await service.getSessionCookies(session.sessionId);
      expect(Array.isArray(result)).toBe(true);
    });

    it('rejects unknown sessions', async () => {
      await expect(service.getSessionCookies('ses_missing')).rejects.toThrow(
        /Session does not exist/i
      );
    });
  });

  describe('page lifecycle', () => {
    let sessionId: string;

    beforeEach(async () => {
      sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
    });

    it('should create a page in the engine session', async () => {
      const page = await service.createPage(sessionId);

      expect(page.pageId).toMatch(/^pg_/);
      expect(page.sessionId).toBe(sessionId);
      expect(page.status).toBe('ready');
    });

    it('should reject pages in unknown sessions', async () => {
      await expect(service.createPage('ses_missing')).rejects.toThrow(ServiceError);
    });

    it('should get a page', async () => {
      const created = await service.createPage(sessionId);
      const page = service.getPage(sessionId, created.pageId);

      expect(page?.pageId).toBe(created.pageId);
    });

    it('should reject a page under the wrong session', async () => {
      const other = await service.createSession({ tenantId: 't2' });
      const page = await service.createPage(sessionId);

      expect(service.getPage(other.sessionId, page.pageId)).toBeUndefined();
    });

    it('should close a page', async () => {
      const created = await service.createPage(sessionId);
      await service.closePage(sessionId, created.pageId);

      expect(service.getPage(sessionId, created.pageId)).toBeUndefined();
    });
  });

  describe('navigation with egress policy', () => {
    let sessionId: string;
    let pageId: string;

    beforeEach(async () => {
      sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
      pageId = (await service.createPage(sessionId)).pageId;
    });

    it('should navigate to a public http URL', async () => {
      const result = await service.navigate(sessionId, pageId, {
        url: 'https://example.com',
      });

      expect(result.status).toBe('success');
      expect(result.url).toBe('https://example.com');
    });

    it('should reject non-http(s) schemes', async () => {
      await expect(
        service.navigate(sessionId, pageId, { url: 'file:///etc/passwd' })
      ).rejects.toMatchServiceError('POLICY_DENIED');
    });

    it('should block loopback addresses (SSRF)', async () => {
      await expect(
        service.navigate(sessionId, pageId, { url: 'http://localhost/admin' })
      ).rejects.toMatchServiceError('POLICY_DENIED');

      await expect(
        service.navigate(sessionId, pageId, { url: 'http://127.0.0.1/admin' })
      ).rejects.toMatchServiceError('POLICY_DENIED');
    });

    it('should block private address ranges (SSRF)', async () => {
      await expect(
        service.navigate(sessionId, pageId, { url: 'http://192.168.1.1/router' })
      ).rejects.toMatchServiceError('POLICY_DENIED');
    });

    it('should block cloud metadata endpoints (SSRF)', async () => {
      await expect(
        service.navigate(sessionId, pageId, { url: 'http://169.254.169.254/latest/meta-data' })
      ).rejects.toMatchServiceError('POLICY_DENIED');
    });

    it('should reject navigation for an unknown page', async () => {
      await expect(
        service.navigate(sessionId, 'pg_missing', { url: 'https://example.com' })
      ).rejects.toMatchServiceError('NOT_FOUND');
    });
  });

  describe('observation', () => {
    let sessionId: string;
    let pageId: string;

    beforeEach(async () => {
      sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
      pageId = (await service.createPage(sessionId)).pageId;
      await service.navigate(sessionId, pageId, { url: 'https://example.com' });
    });

    it('should return a normalized semantic observation', async () => {
      const observation = await service.observe(sessionId, pageId, {});

      expect(observation.sessionId).toBe(sessionId);
      expect(observation.pageId).toBe(pageId);
      expect(observation.url).toBe('https://example.com');
      expect(observation.elements.length).toBeGreaterThan(0);
      expect(observation.untrustedContent).toBe(true);
      expect(observation.truncated).toBe(false);
      expect(typeof observation.summary).toBe('string');
    });

    it('should stamp refs with the current revision', async () => {
      const observation = await service.observe(sessionId, pageId, {});

      expect(observation.revision).toBeGreaterThan(0);
      for (const element of observation.elements) {
        expect(element.ref).toMatch(new RegExp(`^e${observation.revision}_\\d+$`));
      }
    });

    it('should carry element risk classification through', async () => {
      engine
        .getFakePage(engine.getSessionIds()[0]!, pageId)
        ?.setElements([{ role: 'button', name: 'Pay now', risk: 'transaction' }]);

      const observation = await service.observe(sessionId, pageId, {});

      expect(observation.elements[0]?.name).toBe('Pay now');
      expect(observation.elements[0]?.risk).toBe('transaction');
    });

    it('should honor mode and maxElements', async () => {
      const observation = await service.observe(sessionId, pageId, {
        mode: 'interactive',
        maxElements: 2,
      });

      expect(observation.elements.length).toBeLessThanOrEqual(2);
    });

    it('should reject observation for an unknown page', async () => {
      await expect(service.observe(sessionId, 'pg_missing', {})).rejects.toMatchServiceError(
        'NOT_FOUND'
      );
    });
  });

  describe('action execution', () => {
    let sessionId: string;
    let pageId: string;

    beforeEach(async () => {
      sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
      pageId = (await service.createPage(sessionId)).pageId;
      await service.navigate(sessionId, pageId, { url: 'https://example.com' });
    });

    it('should execute a click through an observed ref', async () => {
      const observation = await service.observe(sessionId, pageId, {});
      const ref = observation.elements[0]?.ref;

      const result = await service.act(sessionId, pageId, {
        action: 'click',
        target: { ref },
      });

      expect(result.status).toBe('success');
      expect(result.actionId).toEqual(expect.any(String));
      expect(result.newRevision).toBeGreaterThan(observation.revision);
    });

    it('should execute select through the flat value transport (regression: values were never built)', async () => {
      const engineSessionId = engine.getSessionIds()[0];
      engine
        .getFakePage(engineSessionId as string, pageId)
        ?.setElements([{ role: 'combobox', name: 'Country' }]);
      const observation = await service.observe(sessionId, pageId, {});
      const combobox = observation.elements.find((el) => el.role === 'combobox');
      expect(combobox).toBeDefined();

      const result = await service.act(sessionId, pageId, {
        action: 'select',
        target: { ref: combobox?.ref },
        value: 'Canada',
      });

      // Before the fix, the executor rejected every HTTP select with
      // "Select action requires a non-empty values parameter".
      expect(result.status).toBe('success');
    });

    it('should deliver hover and wait as non-mutating (revision unchanged)', async () => {
      const observation = await service.observe(sessionId, pageId, {});
      const ref = observation.elements[0]?.ref;

      const hover = await service.act(sessionId, pageId, { action: 'hover', target: { ref } });
      expect(hover.newRevision).toBe(observation.revision);

      const wait = await service.act(sessionId, pageId, {
        action: 'wait',
        condition: { until: 'load' },
      });
      expect(wait.newRevision).toBe(observation.revision);
    });

    it('should deliver the mutating Phase-1 actions and reject a bad wait condition', async () => {
      // Mutating actions invalidate refs, so observe fresh per action.
      for (const action of ['dblclick', 'clear', 'check', 'uncheck', 'reload', 'goBack'] as const) {
        const observation = await service.observe(sessionId, pageId, {});
        const ref = observation.elements[0]?.ref;
        const result = await service.act(sessionId, pageId, {
          action,
          ...(action === 'reload' || action === 'goBack' ? {} : { target: { ref } }),
        });
        expect(result.status).toBe('success');
        expect(result.newRevision).toBeGreaterThan(0);
      }

      await expect(
        service.act(sessionId, pageId, { action: 'wait', condition: { until: 'bogus' } })
      ).rejects.toThrow(/Unknown wait condition/);
    });

    it('should execute fill with a value', async () => {
      const observation = await service.observe(sessionId, pageId, {});
      const textbox = observation.elements.find((el) => el.role === 'textbox');
      expect(textbox).toBeDefined();

      const result = await service.act(sessionId, pageId, {
        action: 'fill',
        target: { ref: textbox?.ref },
        value: 'hello@example.com',
      });

      expect(result.status).toBe('success');
    });

    it('should return a stale error after the page moves on', async () => {
      const observation = await service.observe(sessionId, pageId, {});
      const ref = observation.elements[0]?.ref;

      // Someone else acts first; the page revision moves on.
      await service.act(sessionId, pageId, { action: 'press', key: 'Enter' });

      const error = await capture(() =>
        service.act(sessionId, pageId, { action: 'click', target: { ref } })
      );

      expect(error?.code).toBe('STALE_TARGET');
      expect(error?.retryable).toBe(true);
    });

    it('should reject an unknown ref at the current revision', async () => {
      const observation = await service.observe(sessionId, pageId, {});

      const error = await capture(() =>
        service.act(sessionId, pageId, {
          action: 'click',
          target: { ref: `e${observation.revision}_99` },
        })
      );

      expect(error?.code).toBe('TARGET_NOT_FOUND');
    });

    it('should classify a ref from another revision as stale, not missing', async () => {
      await service.observe(sessionId, pageId, {});

      const error = await capture(() =>
        service.act(sessionId, pageId, { action: 'click', target: { ref: 'e99_0' } })
      );

      expect(error?.code).toBe('STALE_TARGET');
    });

    it('should require an observation before acting', async () => {
      const error = await capture(() =>
        service.act(sessionId, pageId, { action: 'click', target: { ref: 'e1_0' } })
      );

      expect(error?.code).toBe('INVALID_REQUEST');
      expect(error?.message).toMatch(/observe/i);
    });

    it('should reject a selector-shaped ref', async () => {
      const error = await capture(() =>
        service.act(sessionId, pageId, { action: 'click', target: { ref: 'button.submit' } })
      );

      expect(error?.code).toBe('INVALID_REQUEST');
    });

    it('should attach a post-action observation when requested', async () => {
      const observation = await service.observe(sessionId, pageId, {});
      const ref = observation.elements[0]?.ref;

      const result = await service.act(sessionId, pageId, {
        action: 'click',
        target: { ref },
        observe: 'after',
      });

      expect(result.observation).toBeDefined();
      expect(result.observation?.revision).toBe(result.newRevision);
    });
  });

  describe('approval gate', () => {
    let sessionId: string;
    let pageId: string;

    beforeEach(async () => {
      sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
      pageId = (await service.createPage(sessionId)).pageId;
      await service.navigate(sessionId, pageId, { url: 'https://shop.example.com' });
      engine
        .getFakePage(engine.getSessionIds()[0]!, pageId)
        ?.setElements([{ role: 'button', name: 'Pay now', risk: 'transaction' }]);
    });

    it('should require approval for a transaction-risk element', async () => {
      const observation = await service.observe(sessionId, pageId, {});
      const ref = observation.elements[0]?.ref;

      const error = await capture(() =>
        service.act(sessionId, pageId, { action: 'click', target: { ref } })
      );

      expect(error?.code).toBe('APPROVAL_REQUIRED');
      expect(error?.details?.tokenId).toEqual(expect.any(String));
    });

    it('should execute once with a valid approval token', async () => {
      const observation = await service.observe(sessionId, pageId, {});
      const ref = observation.elements[0]?.ref;

      const denied = await capture(() =>
        service.act(sessionId, pageId, { action: 'click', target: { ref } })
      );
      const tokenId = denied?.details?.tokenId as string;

      const result = await service.act(sessionId, pageId, {
        action: 'click',
        target: { ref },
        approvalToken: tokenId,
      });

      expect(result.status).toBe('success');
    });

    it('should burn the approval token after one use', async () => {
      const observation = await service.observe(sessionId, pageId, {});
      const ref = observation.elements[0]?.ref;

      const first = await capture(() =>
        service.act(sessionId, pageId, { action: 'click', target: { ref } })
      );
      const tokenId = first?.details?.tokenId as string;

      await service.act(sessionId, pageId, {
        action: 'click',
        target: { ref },
        approvalToken: tokenId,
      });

      // Re-observe (page moved on), get a fresh denial + token, then try
      // replaying the OLD burned token against the fresh denial.
      const observation2 = await service.observe(sessionId, pageId, {});
      const second = await capture(() =>
        service.act(sessionId, pageId, {
          action: 'click',
          target: { ref: observation2.elements[0]?.ref },
        })
      );
      expect(second?.code).toBe('APPROVAL_REQUIRED');

      const replay = await capture(() =>
        service.act(sessionId, pageId, {
          action: 'click',
          target: { ref: observation2.elements[0]?.ref },
          approvalToken: tokenId,
        })
      );

      expect(replay?.code).toBe('APPROVAL_REQUIRED');
      expect(replay?.details?.tokenId as string).not.toBe(tokenId);
    });

    it('should not gate ordinary elements', async () => {
      engine
        .getFakePage(engine.getSessionIds()[0]!, pageId)
        ?.setElements([{ role: 'button', name: 'Next page' }]);
      const observation = await service.observe(sessionId, pageId, {});

      const result = await service.act(sessionId, pageId, {
        action: 'click',
        target: { ref: observation.elements[0]?.ref },
      });

      expect(result.status).toBe('success');
    });
  });

  describe('observation diffs (sinceRevision)', () => {
    let sessionId: string;
    let pageId: string;

    beforeEach(async () => {
      sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
      pageId = (await service.createPage(sessionId)).pageId;
      await service.navigate(sessionId, pageId, { url: 'https://example.com' });
    });

    it('should report no changes at the current revision', async () => {
      const observation = await service.observe(sessionId, pageId, {});

      const diff = await service.observe(sessionId, pageId, {
        sinceRevision: observation.revision,
      });

      expect(diff.changes).toEqual([]);
      expect(diff.revision).toBe(observation.revision);
    });

    it('should report a modified element after a fill', async () => {
      const before = await service.observe(sessionId, pageId, {});
      const textbox = before.elements.find((el) => el.role === 'textbox');

      await service.act(sessionId, pageId, {
        action: 'fill',
        target: { ref: textbox?.ref },
        value: 'typed@example.com',
      });

      const after = await service.observe(sessionId, pageId, {
        sinceRevision: before.revision,
      });

      expect(after.revision).toBeGreaterThan(before.revision);
      const modified = after.changes?.find((c) => c.change === 'modified');
      expect(modified).toBeDefined();
      expect(modified?.properties.value).toEqual({
        old: '',
        new: 'typed@example.com',
      });
    });

    it('should report wholesale add/remove across a navigation', async () => {
      const before = await service.observe(sessionId, pageId, {});

      await service.navigate(sessionId, pageId, { url: 'https://other.example.com' });

      const after = await service.observe(sessionId, pageId, {
        sinceRevision: before.revision,
      });

      const kinds = after.changes?.map((c) => c.change) ?? [];
      expect(kinds).toContain('removed');
      expect(kinds).toContain('added');
      // Nothing can be 'modified' across a full navigation.
      expect(kinds).not.toContain('modified');
    });

    it('should reject an unknown sinceRevision', async () => {
      await service.observe(sessionId, pageId, {});

      const error = await capture(() => service.observe(sessionId, pageId, { sinceRevision: 999 }));

      expect(error?.code).toBe('INVALID_REQUEST');
      expect(error?.message).toMatch(/sinceRevision/i);
    });
  });

  describe('observation continuation (truncated observations)', () => {
    let sessionId: string;
    let pageId: string;

    beforeEach(async () => {
      sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
      pageId = (await service.createPage(sessionId)).pageId;
      await service.navigate(sessionId, pageId, { url: 'https://example.com' });
    });

    it('should truncate with a continuation cursor', async () => {
      const page = await service.observe(sessionId, pageId, { maxElements: 2 });

      expect(page.elements).toHaveLength(2);
      expect(page.truncated).toBe(true);
      expect(page.continuation).toEqual({ nextOrdinal: 2, remaining: 3 });
    });

    it('should continue from the cursor', async () => {
      const first = await service.observe(sessionId, pageId, { maxElements: 2 });
      const cursor = first.continuation!;

      const second = await service.observe(sessionId, pageId, {
        maxElements: 2,
        continueFrom: cursor.nextOrdinal,
      });

      expect(second.elements).toHaveLength(2);
      expect(second.truncated).toBe(true);
      expect(second.continuation).toEqual({ nextOrdinal: 4, remaining: 1 });

      // Continuation preserves document order: no overlap with the first page.
      const firstRefs = first.elements.map((el) => el.ref);
      for (const element of second.elements) {
        expect(firstRefs).not.toContain(element.ref);
      }
    });

    it('should finish without a cursor on the last page', async () => {
      const first = await service.observe(sessionId, pageId, { maxElements: 2 });
      const second = await service.observe(sessionId, pageId, {
        maxElements: 2,
        continueFrom: first.continuation?.nextOrdinal,
      });

      const last = await service.observe(sessionId, pageId, {
        maxElements: 2,
        continueFrom: second.continuation?.nextOrdinal,
      });

      expect(last.truncated).toBe(false);
      expect(last.continuation).toBeUndefined();
    });

    it('should reject a negative continueFrom', async () => {
      const error = await capture(() =>
        service.observe(sessionId, pageId, { maxElements: 2, continueFrom: -1 })
      );

      expect(error?.code).toBe('INVALID_REQUEST');
    });
  });

  describe('wait conditions (spec 11.1)', () => {
    let sessionId: string;
    let pageId: string;

    beforeEach(async () => {
      sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
      pageId = (await service.createPage(sessionId)).pageId;
      await service.navigate(sessionId, pageId, { url: 'https://example.com' });
    });

    it('should accept a wait condition with a deadline on act', async () => {
      const observation = await service.observe(sessionId, pageId, {});
      const result = await service.act(sessionId, pageId, {
        action: 'click',
        target: { ref: observation.elements[0]?.ref },
        wait: { until: 'settled', timeoutMs: 3000 },
      });

      expect(result.status).toBe('success');
      // The wait's completion reason rides on the result (spec: waits
      // return why they completed).
      expect(result.waitReason).toBe('settled');
    });

    it('should accept load and networkidle conditions', async () => {
      const observation = await service.observe(sessionId, pageId, {});

      const load = await service.act(sessionId, pageId, {
        action: 'press',
        key: 'Enter',
        wait: { until: 'load', timeoutMs: 2000 },
      });
      expect(load.waitReason).toBe('load');

      const idle = await service.act(sessionId, pageId, {
        action: 'press',
        key: 'Enter',
        wait: { until: 'networkidle', timeoutMs: 2000 },
      });
      expect(idle.waitReason).toBe('networkidle');
    });

    it('should default to settled with a bounded deadline when omitted', async () => {
      const observation = await service.observe(sessionId, pageId, {});
      const result = await service.act(sessionId, pageId, {
        action: 'click',
        target: { ref: observation.elements[0]?.ref },
      });

      // No wait specified: the post-action settle still runs (bounded),
      // so refs handed out afterward are stable.
      expect(result.waitReason).toBe('settled');
    });

    it('should reject an unknown wait condition', async () => {
      const error = await capture(() =>
        service.act(sessionId, pageId, {
          action: 'press',
          key: 'Enter',
          wait: { until: 'banana' as never, timeoutMs: 500 },
        })
      );

      expect(error?.code).toBe('INVALID_REQUEST');
      expect(error?.message).toMatch(/wait/i);
    });

    it('should enforce the deadline (ACTION_TIMEOUT on a never-settling wait)', async () => {
      const error = await capture(() =>
        service.act(sessionId, pageId, {
          action: 'press',
          key: 'Enter',
          wait: { until: 'domcontentloaded', timeoutMs: 1 },
        })
      );

      // With a 1ms deadline the wait may complete or time out; if it times
      // out the code must be ACTION_TIMEOUT, never a hang.
      if (error !== undefined) {
        expect(error.code).toBe('ACTION_TIMEOUT');
      }
    });
  });

  describe('byte-budget truncation (spec 10)', () => {
    let sessionId: string;
    let pageId: string;

    beforeEach(async () => {
      sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
      pageId = (await service.createPage(sessionId)).pageId;
      await service.navigate(sessionId, pageId, { url: 'https://example.com' });
    });

    it('should truncate an observation to fit maxBytes', async () => {
      const full = await service.observe(sessionId, pageId, {});
      const fullBytes = JSON.stringify(full).length;

      const trimmed = await service.observe(sessionId, pageId, { maxBytes: fullBytes - 400 });

      expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(fullBytes - 400);
      expect(trimmed.truncated).toBe(true);
      expect(trimmed.elements.length).toBeLessThan(full.elements.length);
    });

    it('should leave a fitting observation untruncated', async () => {
      const full = await service.observe(sessionId, pageId, {});
      const generous = await service.observe(sessionId, pageId, {
        maxBytes: JSON.stringify(full).length + 1000,
      });

      expect(generous.truncated).toBe(false);
      expect(generous.elements.length).toBe(full.elements.length);
    });

    it('should keep every returned ref actionable (positional bridging intact)', async () => {
      const trimmed = await service.observe(sessionId, pageId, { maxBytes: 900 });

      if (trimmed.elements.length > 0) {
        const result = await service.act(sessionId, pageId, {
          action: 'click',
          target: { ref: trimmed.elements[0]?.ref },
        });
        expect(result.status).toBe('success');
      }
    });
  });

  describe('secret-safe credential handling', () => {
    const SECRET_VALUE = 'correct-horse-battery-staple';
    let secretService: AgentBrowserService;
    let secretSessionId: string;
    let secretPageId: string;

    beforeEach(async () => {
      secretService = new AgentBrowserService({
        engine: new FakeEngine(),
        secretManager: new SecretManager({ 'vault://tenant/login/password': SECRET_VALUE }),
      });
      secretSessionId = (await secretService.createSession({ tenantId: 'sec' })).sessionId;
      secretPageId = (await secretService.createPage(secretSessionId)).pageId;
      await secretService.navigate(secretSessionId, secretPageId, {
        url: 'https://login.example.com',
      });
    });

    it('should fill via a vault reference without exposing the value', async () => {
      const observation = await secretService.observe(secretSessionId, secretPageId, {});
      const textbox = observation.elements.find((el) => el.role === 'textbox');

      const result = await secretService.act(secretSessionId, secretPageId, {
        action: 'fill',
        target: { ref: textbox?.ref },
        value: 'vault://tenant/login/password',
      });

      expect(result.status).toBe('success');
    });

    it('should never return a secret in observations after a sensitive fill', async () => {
      const observation = await secretService.observe(secretSessionId, secretPageId, {});
      const textbox = observation.elements.find((el) => el.role === 'textbox');

      await secretService.act(secretSessionId, secretPageId, {
        action: 'fill',
        target: { ref: textbox?.ref },
        value: 'vault://tenant/login/password',
      });

      const after = await secretService.observe(secretSessionId, secretPageId, {});
      const serialized = JSON.stringify(after);

      expect(serialized).not.toContain(SECRET_VALUE);
      const filled = after.elements.find((el) => el.role === 'textbox');
      expect(filled?.value).toBe('***');
    });

    it('should reject an unknown vault reference', async () => {
      const observation = await secretService.observe(secretSessionId, secretPageId, {});
      const textbox = observation.elements.find((el) => el.role === 'textbox');

      const error = await capture(() =>
        secretService.act(secretSessionId, secretPageId, {
          action: 'fill',
          target: { ref: textbox?.ref },
          value: 'vault://tenant/login/missing',
        })
      );

      expect(error?.code).toBe('SECRET_NOT_FOUND');
    });

    it('should redact secrets from error payloads', async () => {
      // A URL carrying the secret would otherwise echo it back in the error.
      const error = await capture(() =>
        secretService.navigate(secretSessionId, secretPageId, {
          url: `https://login.example.com/callback?token=${SECRET_VALUE}`,
        })
      );

      // The secret is rejected here only if the policy denies it; on success
      // the assertion target is the next observation. Either way, no output
      // may contain the secret.
      const serialized = error
        ? JSON.stringify({ message: error.message, details: error.details })
        : JSON.stringify(await secretService.observe(secretSessionId, secretPageId, {}));

      expect(serialized).not.toContain(SECRET_VALUE);
    });

    it('should redact secrets from navigation denial details', async () => {
      const error = await capture(() =>
        secretService.navigate(secretSessionId, secretPageId, {
          url: `http://169.254.169.254/latest?token=${SECRET_VALUE}`,
        })
      );

      expect(error?.code).toBe('POLICY_DENIED');
      expect(JSON.stringify(error?.details)).not.toContain(SECRET_VALUE);
      expect(error?.message).not.toContain(SECRET_VALUE);
    });
  });

  describe('tracing (TD-020)', () => {
    it('should trace session creation', async () => {
      const tracer = new InMemoryTracer();
      const traced = new AgentBrowserService({ engine: new FakeEngine(), tracer });

      await traced.createSession({ tenantId: 't1' });

      const spans = tracer.completedSpans();
      expect(spans.some((s) => s.name === 'session.create')).toBe(true);
    });

    it('should trace navigation with a policy-check child span', async () => {
      const tracer = new InMemoryTracer();
      const traced = new AgentBrowserService({ engine: new FakeEngine(), tracer });
      const sessionId = (await traced.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await traced.createPage(sessionId)).pageId;
      // Focus on the navigation: spans already recorded (session.create etc.)
      // stay in the tracer - completedSpans() is a copy, so truncating it
      // would silently no-op - so slice by count instead.
      const spanCountBefore = tracer.completedSpans().length;

      await traced.navigate(sessionId, pageId, { url: 'https://example.com' });

      const spans = tracer.completedSpans().slice(spanCountBefore);
      const nav = spans.find((s) => s.name === 'navigate');
      const policyCheck = spans.find((s) => s.name === 'policy.check');

      expect(nav).toBeDefined();
      expect(policyCheck).toBeDefined();
      expect(policyCheck?.parentId).toBe(nav?.spanId);
      expect(policyCheck?.traceId).toBe(nav?.traceId);
      expect(nav?.status).toBe('ok');
    });

    it('should mark denied navigation as an error span', async () => {
      const tracer = new InMemoryTracer();
      const traced = new AgentBrowserService({ engine: new FakeEngine(), tracer });
      const sessionId = (await traced.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await traced.createPage(sessionId)).pageId;

      await capture(() => traced.navigate(sessionId, pageId, { url: 'http://169.254.169.254/x' }));

      const nav = tracer.completedSpans().find((s) => s.name === 'navigate');
      expect(nav?.status).toBe('error');
      expect(nav?.attributes.code).toBe('POLICY_DENIED');
    });

    it('should trace actions and record approval decisions', async () => {
      const tracer = new InMemoryTracer();
      const engine2 = new FakeEngine();
      const traced = new AgentBrowserService({ engine: engine2, tracer });
      const sessionId = (await traced.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await traced.createPage(sessionId)).pageId;
      await traced.navigate(sessionId, pageId, { url: 'https://shop.example.com' });

      const engineSessionIds = engine2.getSessionIds();
      engine2
        .getFakePage(engineSessionIds[engineSessionIds.length - 1]!, pageId)
        ?.setElements([{ role: 'button', name: 'Pay now', risk: 'transaction' }]);

      const observation = await traced.observe(sessionId, pageId, {});
      await capture(() =>
        traced.act(sessionId, pageId, {
          action: 'click',
          target: { ref: observation.elements[0]?.ref ?? 'e2_0' },
        })
      );

      const act = tracer.completedSpans().find((s) => s.name === 'act');
      expect(act).toBeDefined();
      expect(act?.events.some((e) => e.name === 'approval.required')).toBe(true);
      expect(act?.attributes.code).toBe('APPROVAL_REQUIRED');
    });

    it('should never put secret values in spans', async () => {
      const tracer = new InMemoryTracer({
        secretManager: new SecretManager({ 'vault://p': 'classified-value' }),
      });
      const traced = new AgentBrowserService({
        engine: new FakeEngine(),
        tracer,
        secretManager: new SecretManager({ 'vault://p': 'classified-value' }),
      });
      const sessionId = (await traced.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await traced.createPage(sessionId)).pageId;

      await capture(() =>
        traced.navigate(sessionId, pageId, {
          url: 'http://169.254.169.254/x?token=classified-value',
        })
      );

      expect(JSON.stringify(tracer.completedSpans())).not.toContain('classified-value');
    });
  });

  describe('metrics and logging (TD-021)', () => {
    it('should record operation counters and latency percentiles', async () => {
      const metrics = new MetricsRegistry();
      const measured = new AgentBrowserService({ engine: new FakeEngine(), metrics });
      const sessionId = (await measured.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await measured.createPage(sessionId)).pageId;

      await measured.navigate(sessionId, pageId, { url: 'https://example.com' });
      await measured.navigate(sessionId, pageId, { url: 'https://other.example.com' });

      const rendered = metrics.render();
      expect(rendered).toContain('operations_total{operation="navigate",outcome="ok"} 2');
      expect(rendered).toContain('# TYPE operation_duration_ms summary');
      expect(rendered).toContain('operation_duration_ms_count{operation="navigate"} 2');
    });

    it('should record failures with their error code', async () => {
      const metrics = new MetricsRegistry();
      const measured = new AgentBrowserService({ engine: new FakeEngine(), metrics });
      const sessionId = (await measured.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await measured.createPage(sessionId)).pageId;

      await capture(() => measured.navigate(sessionId, pageId, { url: 'http://localhost/admin' }));

      const rendered = metrics.render();
      expect(rendered).toContain('operations_total{operation="navigate",outcome="error"} 1');
      expect(rendered).toContain('errors_total{code="POLICY_DENIED"} 1');
    });

    it('should track the active-session gauge', async () => {
      const metrics = new MetricsRegistry();
      const measured = new AgentBrowserService({ engine: new FakeEngine(), metrics });

      const sessionId = (await measured.createSession({ tenantId: 't1' })).sessionId;
      expect(metrics.render()).toContain('sessions_active 1');

      await measured.closeSession(sessionId);
      const rendered = metrics.render();
      expect(rendered).toContain('sessions_active 0');
      expect(rendered).toContain('sessions_created_total 1');
      expect(rendered).toContain('sessions_closed_total 1');
    });

    it('should log operations as structured entries, redacting secrets', async () => {
      const lines: string[] = [];
      const secret = 'classified-value';
      const logger = new StructuredLogger({
        sink: (line: string) => lines.push(line),
        secretManager: new SecretManager({ 'vault://p': secret }),
      });
      const logged = new AgentBrowserService({
        engine: new FakeEngine(),
        logger,
        secretManager: new SecretManager({ 'vault://p': secret }),
      });
      const sessionId = (await logged.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await logged.createPage(sessionId)).pageId;

      await capture(() =>
        logged.navigate(sessionId, pageId, { url: `http://169.254.169.254/x?token=${secret}` })
      );

      const serialized = lines.join('\n');
      expect(serialized).toContain('"message":"navigate"');
      expect(serialized).toContain('"code":"POLICY_DENIED"');
      expect(serialized).not.toContain(secret);
    });
  });

  describe('downloads and artifacts', () => {
    const BYTES = new Uint8Array([104, 101, 108, 108, 111]); // "hello"

    const downloadService = (
      options: {
        session?: Record<string, unknown>;
        store?: ConstructorParameters<typeof import('@agentbrowser/core').ArtifactStore>[0];
        maxDownloadBytes?: number;
        downloader?: (url: string) => Promise<{ bytes: Uint8Array; contentType: string }>;
      } = {}
    ) => {
      const engine2 = new FakeEngine();
      const service2 = new AgentBrowserService({
        engine: engine2,
        ...(options.store ? { artifactStore: new ArtifactStore(options.store) } : {}),
        ...(options.downloader ? { downloader: options.downloader } : {}),
      });
      return { engine2, service2 };
    };

    it('should block downloads unless the session allows them', async () => {
      const { service2 } = downloadService();
      const sessionId = (await service2.createSession({ tenantId: 't' })).sessionId;
      const pageId = (await service2.createPage(sessionId)).pageId;

      const error = await capture(() =>
        service2.download(sessionId, pageId, { url: 'https://files.example.com/report.csv' })
      );

      expect(error?.code).toBe('DOWNLOAD_BLOCKED');
    });

    it('should download and store an artifact when allowed', async () => {
      const { service2 } = downloadService({
        downloader: async () => ({ bytes: BYTES, contentType: 'text/csv' }),
      });
      const sessionId = (
        await service2.createSession({
          tenantId: 't',
          allowDownloads: true,
        })
      ).sessionId;
      const pageId = (await service2.createPage(sessionId)).pageId;

      const artifact = await service2.download(sessionId, pageId, {
        url: 'https://files.example.com/report.csv',
        filename: 'report.csv',
      });

      expect(artifact.type).toBe('download');
      expect(artifact.contentType).toBe('text/csv');
      expect(artifact.sizeBytes).toBe(BYTES.length);
      expect(artifact.filename).toBe('report.csv');

      const stored = service2.getArtifact(sessionId, artifact.artifactId);
      expect(stored?.bytes).toEqual(BYTES);
    });

    it('should enforce the session download size cap', async () => {
      const { service2 } = downloadService({
        downloader: async () => ({ bytes: new Uint8Array(2048), contentType: 'text/csv' }),
      });
      const sessionId = (
        await service2.createSession({
          tenantId: 't',
          allowDownloads: true,
          maxDownloadBytes: 1024,
        })
      ).sessionId;
      const pageId = (await service2.createPage(sessionId)).pageId;

      const error = await capture(() =>
        service2.download(sessionId, pageId, { url: 'https://files.example.com/big.csv' })
      );

      expect(error?.code).toBe('DOWNLOAD_BLOCKED');
      expect(error?.message).toMatch(/bytes/i);
    });

    it('should deny downloads to policy-blocked hosts', async () => {
      const { service2 } = downloadService({
        downloader: async () => ({ bytes: BYTES, contentType: 'text/csv' }),
      });
      const sessionId = (
        await service2.createSession({
          tenantId: 't',
          allowDownloads: true,
        })
      ).sessionId;
      const pageId = (await service2.createPage(sessionId)).pageId;

      const error = await capture(() =>
        service2.download(sessionId, pageId, { url: 'http://169.254.169.254/data' })
      );

      expect(error?.code).toBe('POLICY_DENIED');
    });

    it('should refuse unknown or cross-session artifacts', async () => {
      const { service2 } = downloadService({
        downloader: async () => ({ bytes: BYTES, contentType: 'text/csv' }),
      });
      const a = (await service2.createSession({ tenantId: 'a', allowDownloads: true })).sessionId;
      const b = (await service2.createSession({ tenantId: 'b' })).sessionId;
      const pageId = (await service2.createPage(a)).pageId;

      const artifact = await service2.download(a, pageId, {
        url: 'https://files.example.com/report.csv',
      });

      expect(service2.getArtifact(a, 'art_missing')).toBeUndefined();
      expect(service2.getArtifact(b, artifact.artifactId)).toBeUndefined();
    });
  });

  describe('crash recovery (TD-024)', () => {
    const crashSetup = async () => {
      const engine2 = new FakeEngine();
      const service2 = new AgentBrowserService({ engine: engine2 });
      const sessionId = (await service2.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await service2.createPage(sessionId)).pageId;
      await service2.navigate(sessionId, pageId, { url: 'https://example.com' });
      const ids = engine2.getSessionIds();
      return { engine2, service2, sessionId, pageId, ids };
    };

    it('should surface a typed ENGINE_CRASHED error when the page dies', async () => {
      const { engine2, service2, sessionId, pageId, ids } = await crashSetup();

      engine2.getFakePage(ids[ids.length - 1]!, pageId)?.crash();

      const error = await capture(() => service2.observe(sessionId, pageId, {}));
      expect(error?.code).toBe('ENGINE_CRASHED');
      expect(error?.retryable).toBe(false);
    });

    it('should terminate the affected session', async () => {
      const { engine2, service2, sessionId, pageId, ids } = await crashSetup();

      engine2.getFakePage(ids[ids.length - 1]!, pageId)?.crash();
      await capture(() => service2.observe(sessionId, pageId, {}));

      expect(service2.getSession(sessionId)).toBeUndefined();
      expect(service2.listSessions()).toHaveLength(0);
    });

    it('should record crashes in the audit log', async () => {
      const { engine2, service2, sessionId, pageId, ids } = await crashSetup();

      engine2.getFakePage(ids[ids.length - 1]!, pageId)?.crash();
      await capture(() => service2.navigate(sessionId, pageId, { url: 'https://x.example.com' }));

      const log = service2.getCrashLog();
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ sessionId });
      expect(typeof log[0]?.timestamp).toBe('string');
    });

    it('should map an act on a crashed page to ENGINE_CRASHED', async () => {
      const { engine2, service2, sessionId, pageId, ids } = await crashSetup();
      const observation = await service2.observe(sessionId, pageId, {});
      const ref = observation.elements[0]?.ref ?? 'e2_0';

      engine2.getFakePage(ids[ids.length - 1]!, pageId)?.crash();

      const error = await capture(() =>
        service2.act(sessionId, pageId, { action: 'click', target: { ref } })
      );
      expect(error?.code).toBe('ENGINE_CRASHED');
      expect(service2.getSession(sessionId)).toBeUndefined();
    });

    it('should count crashed sessions in metrics', async () => {
      const metrics = new MetricsRegistry();
      const engine2 = new FakeEngine();
      const service2 = new AgentBrowserService({ engine: engine2, metrics });
      const sessionId = (await service2.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await service2.createPage(sessionId)).pageId;
      const ids = engine2.getSessionIds();

      engine2.getFakePage(ids[ids.length - 1]!, pageId)?.crash();
      await capture(() => service2.observe(sessionId, pageId, {}));

      expect(metrics.render()).toContain('sessions_crashed_total 1');
    });
  });

  describe('extraction (spec 12)', () => {
    const CONTENT = `
      <html><body><main>
        <h1>Report</h1>
        <p>Revenue grew <strong>9%</strong>.</p>
        <a href="/d" rel="next">details</a>
        <table><thead><tr><th>R</th></tr></thead>
          <tbody><tr><td>1M</td></tr></tbody></table>
      </main></body></html>`;

    const extractSetup = async () => {
      const engine2 = new FakeEngine();
      const service2 = new AgentBrowserService({ engine: engine2 });
      const sessionId = (await service2.createSession({ tenantId: 'x' })).sessionId;
      const pageId = (await service2.createPage(sessionId)).pageId;
      await service2.navigate(sessionId, pageId, { url: 'https://x.example.com/a' });
      const ids = engine2.getSessionIds();
      const page =
        ids[ids.length - 1] !== undefined
          ? engine2.getFakePage(ids[ids.length - 1]!, pageId)
          : undefined;
      page?.setContent(CONTENT);
      return { service2, sessionId, pageId };
    };

    it('should extract visible text with evidence', async () => {
      const { service2, sessionId, pageId } = await extractSetup();

      const result = await service2.extract(sessionId, pageId, { format: 'text' });

      expect((result.data as { text: string }).text).toContain('Revenue grew 9%.');
      expect(result.evidence?.[0]).toMatchObject({
        url: 'https://x.example.com/a',
        revision: expect.any(Number),
      });
      expect(typeof result.evidence?.[0]?.hash).toBe('string');
    });

    it('should extract markdown, links and tables', async () => {
      const { service2, sessionId, pageId } = await extractSetup();

      const markdown = await service2.extract(sessionId, pageId, { format: 'markdown' });
      expect((markdown.data as { markdown: string }).markdown).toContain('# Report');
      expect((markdown.data as { markdown: string }).markdown).toContain('**9%**');

      const links = await service2.extract(sessionId, pageId, { format: 'links' });
      expect(links.data).toContainEqual({
        text: 'details',
        url: 'https://x.example.com/d',
        rel: 'next',
      });

      const tables = await service2.extract(sessionId, pageId, { format: 'tables' });
      expect(tables.data).toEqual([{ headers: ['R'], rows: [['1M']] }]);
    });

    it('should extract observed form controls with refs', async () => {
      const { service2, sessionId, pageId } = await extractSetup();
      const observation = await service2.observe(sessionId, pageId, {});
      expect(observation.elements.length).toBeGreaterThan(0);

      const forms = await service2.extract(sessionId, pageId, { format: 'forms' });
      const controls = (forms.data as Array<{ controls: unknown[] }>)[0]?.controls;
      const controlRoles = new Set([
        'textbox',
        'searchbox',
        'textarea',
        'combobox',
        'listbox',
        'checkbox',
        'radio',
        'slider',
        'spinbutton',
        'button',
      ]);
      const expected = observation.elements.filter((el) => controlRoles.has(el.role)).length;
      expect(controls?.length).toBe(expected);
    });

    it('should extract against a JSON schema deterministically', async () => {
      const { service2, sessionId, pageId } = await extractSetup();

      const result = await service2.extract(sessionId, pageId, {
        format: 'schema',
        schema: {
          type: 'object',
          properties: { title: { type: 'string' } },
          required: ['title'],
        },
      });

      expect(result.data).toMatchObject({ title: expect.any(String) });
      expect(result.evidence?.[0]?.hash).toEqual(expect.any(String));
      expect(result.modelUsed).toBeUndefined(); // deterministic: no LLM
    });

    it('should require a schema for format schema', async () => {
      const { service2, sessionId, pageId } = await extractSetup();

      const error = await capture(() => service2.extract(sessionId, pageId, { format: 'schema' }));

      expect(error?.code).toBe('INVALID_REQUEST');
      expect(error?.message).toMatch(/schema/);
    });

    it('should reject an unknown format with INVALID_REQUEST', async () => {
      const { service2, sessionId, pageId } = await extractSetup();

      const error = await capture(() =>
        service2.extract(sessionId, pageId, { format: 'yaml' as never })
      );

      expect(error?.code).toBe('INVALID_REQUEST');
      expect(error?.message).toMatch(/format/i);
    });

    it('should reject extraction for an unknown page', async () => {
      const { service2, sessionId } = await extractSetup();

      const error = await capture(() =>
        service2.extract(sessionId, 'pg_missing', { format: 'text' })
      );
      expect(error?.code).toBe('NOT_FOUND');
    });
  });

  describe('expiry cleanup (audit P0-2)', () => {
    it('should sweep service state when a session expires by TTL', async () => {
      const engine2 = new FakeEngine();
      const service2 = new AgentBrowserService({ engine: engine2, sweepIntervalMs: 20 });

      const sessionId = (await service2.createSession({ tenantId: 't1', ttlMs: 30 })).sessionId;
      const pageId = (await service2.createPage(sessionId)).pageId;
      const received: unknown[] = [];
      expect(service2.subscribe(sessionId, (event) => received.push(event))).toBeDefined();

      // Let the TTL lapse and the sweep run.
      await new Promise((resolve) => setTimeout(resolve, 120));

      expect(service2.getSession(sessionId)).toBeUndefined();
      expect(service2.listSessions()).toHaveLength(0);
      // No leaked page registry, listeners, or download policy.
      expect(service2.getPage(sessionId, pageId)).toBeUndefined();
      expect(service2.subscribe(sessionId, () => {})).toBeUndefined();
      await expect(
        service2.navigate(sessionId, pageId, { url: 'https://x.example.com' })
      ).rejects.toMatchServiceError('SESSION_NOT_FOUND');
      // The subscriber was notified of the expiry before cleanup.
      expect(
        received.some(
          (event) => (event as { data?: { reason?: string } }).data?.reason === 'session-expired'
        )
      ).toBe(true);
      await service2.shutdown();
    });
  });

  describe('event streaming', () => {
    it('should deliver engine events to session subscribers with stamped ids', async () => {
      const sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await service.createPage(sessionId)).pageId;
      await service.navigate(sessionId, pageId, { url: 'https://example.com' });

      const received: Array<Record<string, unknown>> = [];
      const unsubscribe = service.subscribe(sessionId, (event) => received.push(event));

      const ids = engine.getSessionIds();
      engine.getFakePage(ids[ids.length - 1]!, pageId)?.emitEvent('page.loaded', { ms: 12 });
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        type: 'page.loaded',
        sessionId,
        pageId,
        data: { ms: 12 },
      });
      unsubscribe();
    });

    it('should stop delivery after unsubscribe', async () => {
      const sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await service.createPage(sessionId)).pageId;

      const received: unknown[] = [];
      const unsubscribe = service.subscribe(sessionId, (event) => received.push(event));
      unsubscribe();

      const ids = engine.getSessionIds();
      engine.getFakePage(ids[ids.length - 1]!, pageId)?.emitEvent('page.loaded');
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(received).toHaveLength(0);
    });

    it('should not leak events across sessions', async () => {
      const a = (await service.createSession({ tenantId: 'a' })).sessionId;
      const b = (await service.createSession({ tenantId: 'b' })).sessionId;
      const pageA = (await service.createPage(a)).pageId;
      await service.createPage(b);

      const receivedB: unknown[] = [];
      service.subscribe(b, (event) => receivedB.push(event));

      const ids = engine.getSessionIds();
      engine.getFakePage(ids[0]!, pageA)?.emitEvent('console.log', { text: 'x' });
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(receivedB).toHaveLength(0);
    });

    it('should return no subscription for an unknown session', () => {
      expect(service.subscribe('ses_missing', () => {})).toBeUndefined();
    });
  });

  describe('dialog actions (P0-3)', () => {
    it('should accept a held dialog with a prompt answer', async () => {
      const sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await service.createPage(sessionId)).pageId;
      const ids = engine.getSessionIds();

      engine
        .getFakePage(ids[ids.length - 1]!, pageId)
        ?.emitDialog({ type: 'prompt', message: 'Name?' });

      const result = await service.act(sessionId, pageId, {
        action: 'acceptDialog',
        promptText: 'agent',
      });

      expect(result.status).toBe('success');
      expect(result.newRevision).toBe(1); // non-mutating
    });

    it('should fail typed when no dialog is held', async () => {
      const sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await service.createPage(sessionId)).pageId;

      const error = await capture(() =>
        service.act(sessionId, pageId, { action: 'dismissDialog' })
      );

      expect(error?.code).toBe('INVALID_REQUEST');
      expect(error?.message).toMatch(/no dialog/i);
    });

    it('should stream dialog events to session subscribers', async () => {
      const sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await service.createPage(sessionId)).pageId;
      const received: Array<Record<string, unknown>> = [];
      service.subscribe(sessionId, (event) => received.push(event));

      const ids = engine.getSessionIds();
      engine
        .getFakePage(ids[ids.length - 1]!, pageId)
        ?.emitDialog({ type: 'confirm', message: 'Proceed?' });
      await service.act(sessionId, pageId, { action: 'dismissDialog' });
      await new Promise((resolve) => setTimeout(resolve, 25));

      const types = received.map((event) => event.type);
      expect(types).toContain('dialog.opened');
      expect(types).toContain('dialog.closed');
    });

    it('should not stale-invalidate refs across a dialog action', async () => {
      const sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await service.createPage(sessionId)).pageId;
      await service.navigate(sessionId, pageId, { url: 'https://example.com' });
      const observation = await service.observe(sessionId, pageId, {});
      const ref = observation.elements[0]?.ref;
      const ids = engine.getSessionIds();

      engine
        .getFakePage(ids[ids.length - 1]!, pageId)
        ?.emitDialog({ type: 'alert', message: 'hi' });
      await service.act(sessionId, pageId, { action: 'dismissDialog' });

      // The ref from before the dialog is still valid: dialogs do not move
      // the page revision.
      const result = await service.act(sessionId, pageId, {
        action: 'click',
        target: { ref },
      });
      expect(result.status).toBe('success');
    });
  });

  describe('in-page download collection (spec 10)', () => {
    it('should reject collection when nothing was captured', async () => {
      const sessionId = (await service.createSession({ tenantId: 't1', allowDownloads: true }))
        .sessionId;
      const pageId = (await service.createPage(sessionId)).pageId;

      const error = await capture(() => service.collectDownload(sessionId, pageId, 'missing.csv'));

      expect(error?.code).toBe('NOT_FOUND');
      expect(error?.message).toMatch(/download.finished/i);
    });
  });

  describe('screenshots', () => {
    it('should capture an artifact from the engine', async () => {
      const sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await service.createPage(sessionId)).pageId;

      const artifact = await service.screenshot(sessionId, pageId, { format: 'png' });

      expect(artifact.type).toBe('screenshot');
      expect(artifact.contentType).toBe('image/png');
      expect(artifact.sizeBytes).toBeGreaterThan(0);
      expect(artifact.artifactId).toEqual(expect.any(String));

      // Bytes are retrievable through the artifact store.
      const stored = service.getArtifact(sessionId, artifact.artifactId);
      expect(stored?.bytes.length).toBe(artifact.sizeBytes);
    });

    it('should capture a PDF artifact retrievable through the store', async () => {
      const sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await service.createPage(sessionId)).pageId;
      await service.navigate(sessionId, pageId, { url: 'https://report.example.com' });

      const artifact = await service.pdf(sessionId, pageId, { printBackground: true });

      expect(artifact.type).toBe('pdf');
      expect(artifact.contentType).toBe('application/pdf');
      expect(artifact.sizeBytes).toBeGreaterThan(0);

      const stored = service.getArtifact(sessionId, artifact.artifactId);
      expect(
        Buffer.from(stored?.bytes ?? Buffer.alloc(0))
          .toString('utf8')
          .startsWith('%PDF-')
      ).toBe(true);
    });

    it('should reject a PDF for an unknown page', async () => {
      const sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;

      const error = await capture(() => service.pdf(sessionId, 'pg_missing', {}));
      expect(error?.code).toBe('NOT_FOUND');
    });

    it('should warn when maskSensitive is requested but values are on screen', async () => {
      const sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await service.createPage(sessionId)).pageId;
      await service.navigate(sessionId, pageId, { url: 'https://form.example.com' });

      // Put a filled (non-empty) value on the page, then observe so the
      // service knows values exist.
      const ids = engine.getSessionIds();
      const fakePage = engine.getFakePage(ids[ids.length - 1] ?? 'x', pageId);
      fakePage?.setElements([{ role: 'textbox', name: 'Card', value: '4242' }]);
      await service.observe(sessionId, pageId, {});

      const artifact = await service.screenshot(sessionId, pageId, {
        format: 'png',
        maskSensitive: true,
      });

      expect(artifact.warnings?.some((w) => /maskSensitive/i.test(w))).toBe(true);
    });

    it('should reject a screenshot for an unknown page', async () => {
      const sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;

      await expect(service.screenshot(sessionId, 'pg_missing', {})).rejects.toMatchServiceError(
        'NOT_FOUND'
      );
    });
  });

  describe('shutdown', () => {
    it('should close all sessions and the engine', async () => {
      const sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;

      await service.shutdown();

      expect(service.getSession(sessionId)).toBeUndefined();
      expect(service.listSessions()).toHaveLength(0);
    });
  });
});

/** Reach the engine page backing a service page id (single-session tests). */
function enginePageOf(engine: FakeEngine, pageId: string) {
  const ids = engine.getSessionIds();
  const sessionId = ids[ids.length - 1];
  if (sessionId === undefined) {
    throw new Error('no engine session was created');
  }
  const page = engine.getFakePage(sessionId, pageId);
  if (!page) {
    throw new Error(`no engine page for ${pageId}`);
  }
  return page;
}

/** Capture a ServiceError instead of throwing past the assertion. */
async function capture(fn: () => Promise<unknown>): Promise<ServiceError | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    if (error instanceof ServiceError) {
      return error;
    }
    throw error;
  }
}

declare module 'vitest' {
  interface Matchers<R> {
    toMatchServiceError(code: string): R;
  }
}

expect.extend({
  toMatchServiceError(received: unknown, code: string) {
    const { equals } = this;
    const isServiceError =
      typeof received === 'object' &&
      received !== null &&
      'code' in received &&
      typeof (received as { code: unknown }).code === 'string';
    if (!isServiceError) {
      return {
        pass: false,
        message: () => `expected a ServiceError, got ${JSON.stringify(received)}`,
      };
    }
    const actualCode = (received as { code: string }).code;
    return {
      pass: equals(actualCode, code),
      message: () => `expected ServiceError code ${code}, got ${actualCode}`,
    };
  },
});

describe('maxBytes hardening (Phase 1, A4)', () => {
  let engine: FakeEngine;
  let service: AgentBrowserService;

  beforeEach(() => {
    engine = new FakeEngine();
    service = new AgentBrowserService({ engine });
  });

  it('measures real UTF-8 bytes, not UTF-16 code units', async () => {
    const session = await service.createSession({ tenantId: 't1' });
    const pageId = (await service.createPage(session.sessionId)).pageId;
    // Multibyte name: each CJK char is 3 UTF-8 bytes but 1 UTF-16 unit.
    const engineSessionId = engine.getSessionIds()[0];
    engine
      .getFakePage(engineSessionId as string, pageId)
      ?.setElements(
        Array.from({ length: 40 }, (_, i) => ({ role: 'button', name: `按钮编号${i}` }))
      );
    const observation = await service.observe(session.sessionId, pageId, {});
    expect(observation.truncated).toBe(false);

    const budget = Buffer.byteLength(JSON.stringify(observation), 'utf8') - 300;
    const bounded = (await service.observe(session.sessionId, pageId, {
      maxBytes: budget,
    })) as unknown as { truncated: boolean };
    expect(bounded.truncated).toBe(true);
    const size = Buffer.byteLength(JSON.stringify(bounded), 'utf8');
    expect(size).toBeLessThanOrEqual(budget);
  });

  it('rejects invalid maxBytes instead of trimming everything', async () => {
    const session = await service.createSession({ tenantId: 't1' });
    const pageId = (await service.createPage(session.sessionId)).pageId;
    await expect(
      service.observe(session.sessionId, pageId, { maxBytes: 1.5 as number })
    ).rejects.toThrow(/Invalid maxBytes/);
    await expect(service.observe(session.sessionId, pageId, { maxBytes: 0 })).rejects.toThrow(
      /Invalid maxBytes/
    );
  });

  it('applies the byte budget to sinceRevision diffs too', async () => {
    const session = await service.createSession({ tenantId: 't1' });
    const pageId = (await service.createPage(session.sessionId)).pageId;
    await service.navigate(session.sessionId, pageId, { url: 'https://example.com/' });
    const base = await service.observe(session.sessionId, pageId, {});
    // A fill produces a real diff entry (old/new value pair).
    const textbox = base.elements.find((el) => el.role === 'textbox');
    await service.act(session.sessionId, pageId, {
      action: 'fill',
      target: { ref: textbox?.ref },
      value: 'a-value-that-changes-the-diff-payload',
    });
    await service.observe(session.sessionId, pageId, {});

    const diff = (await service.observe(session.sessionId, pageId, {
      sinceRevision: base.revision,
    })) as unknown as { changes?: unknown[] };

    const full = Buffer.byteLength(JSON.stringify(diff), 'utf8');
    const budget = full - 100;
    const bounded = (await service.observe(session.sessionId, pageId, {
      sinceRevision: base.revision,
      maxBytes: budget,
    })) as unknown as { truncated?: boolean; changes?: unknown[] };
    // Diffs previously bypassed the budget entirely (same size back). Now
    // the payload shrinks toward the budget; the floor is the fixed
    // envelope (session/page/url/title), which is never dropped.
    const size = Buffer.byteLength(JSON.stringify(bounded), 'utf8');
    expect(size).toBeLessThan(full);
    expect(bounded.truncated).toBe(true);
  });
});

describe('request-event ledger separation (spec 5.1 network summary)', () => {
  let engine: FakeEngine;
  let service: AgentBrowserService;

  beforeEach(() => {
    engine = new FakeEngine();
    service = new AgentBrowserService({ engine });
  });

  it('routes request.* events to their own ledger and filters replay by type', async () => {
    const session = await service.createSession({ tenantId: 't1' });
    const pageId = (await service.createPage(session.sessionId)).pageId;
    const ids = engine.getSessionIds();
    const fakePage = engine.getFakePage(ids[ids.length - 1] as string, pageId);

    fakePage?.emitEvent('console.log', { text: 'hello' });
    fakePage?.emitEvent('request.started', { url: 'https://a.example/', hostname: 'a.example' });
    fakePage?.emitEvent('request.finished', {
      url: 'https://a.example/',
      hostname: 'a.example',
      status: 200,
    });
    fakePage?.emitEvent('request.failed', {
      url: 'https://b.example/',
      hostname: 'b.example',
      blocked: true,
      reason: 'POLICY_DENIED (sessionHostPolicy)',
    });
    // The service pump drains the engine queue asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Type-filtered: only the matching request type.
    const finished = service.getSessionEvents(session.sessionId, 'request.finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]?.data?.status).toBe(200);

    const failed = service.getSessionEvents(session.sessionId, 'request.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.data?.reason).toMatch(/POLICY_DENIED/);

    // Unfiltered: both ledgers, console lines intact.
    const all = service.getSessionEvents(session.sessionId);
    expect(all.filter((e) => e.type === 'console.log')).toHaveLength(1);
    expect(all.filter((e) => e.type.startsWith('request.'))).toHaveLength(3);
  });

  it('a request flood does not evict console lines from the replay ledger', async () => {
    const session = await service.createSession({ tenantId: 't1' });
    const pageId = (await service.createPage(session.sessionId)).pageId;
    const ids = engine.getSessionIds();
    const fakePage = engine.getFakePage(ids[ids.length - 1] as string, pageId);

    fakePage?.emitEvent('console.log', { text: 'keep me' });
    for (let i = 0; i < 600; i++) {
      fakePage?.emitEvent('request.started', { url: `https://x.example/${i}` });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    const all = service.getSessionEvents(session.sessionId);
    expect(all.some((e) => e.type === 'console.log' && e.data?.text === 'keep me')).toBe(true);
    expect(all.filter((e) => e.type === 'request.started').length).toBe(600);
  });

  it('drops the request ledger with the session', async () => {
    const session = await service.createSession({ tenantId: 't1' });
    const pageId = (await service.createPage(session.sessionId)).pageId;
    const ids = engine.getSessionIds();
    engine
      .getFakePage(ids[ids.length - 1] as string, pageId)
      ?.emitEvent('request.finished', { url: 'https://a.example/' });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const internal = service as unknown as {
      requestHistory: Map<string, unknown>;
      eventHistory: Map<string, unknown>;
    };
    expect(internal.requestHistory.has(session.sessionId)).toBe(true);
    await service.closeSession(session.sessionId);
    expect(internal.requestHistory.has(session.sessionId)).toBe(false);
    expect(internal.eventHistory.has(session.sessionId)).toBe(false);
  });
});
