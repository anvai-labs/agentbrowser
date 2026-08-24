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

import { SecretManager } from '@agentbrowser/core';
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

  describe('screenshots', () => {
    it('should capture an artifact from the engine', async () => {
      const sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await service.createPage(sessionId)).pageId;

      const artifact = await service.screenshot(sessionId, pageId, { format: 'png' });

      expect(artifact.type).toBe('screenshot');
      expect(artifact.contentType).toBe('image/png');
      expect(artifact.sizeBytes).toBeGreaterThan(0);
      expect(artifact.artifactId).toEqual(expect.any(String));
      expect(artifact.url).toEqual(expect.any(String));
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
