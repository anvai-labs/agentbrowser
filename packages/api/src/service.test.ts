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

  beforeEach(() => {
    engine = new FakeEngine();
    service = new AgentBrowserService({ engine });
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
      tracer.completedSpans().length = 0; // focus on the navigation

      await traced.navigate(sessionId, pageId, { url: 'https://example.com' });

      const spans = tracer.completedSpans();
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
