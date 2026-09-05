/**
 * Approval Gates Tests
 *
 * Following TDD principles, these tests define the expected behavior
 * for approval workflow and token-based authorization for high-risk actions.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalError, ApprovalGate, ApprovalToken } from './approval-gate';
import { StructuredLogger } from './logger';

describe('Approval Gates', () => {
  let gate: ApprovalGate;

  beforeEach(() => {
    gate = new ApprovalGate();
  });

  describe('action classification', () => {
    it('should require approval for transactions', async () => {
      const action = {
        type: 'click',
        effect: 'transaction',
      };

      const required = await gate.isApprovalRequired(action);
      expect(required).toBe(true);
    });

    it('should require approval for account changes', async () => {
      const action = {
        type: 'fill',
        effect: 'account_change',
        target: { ref: 'password-field' },
      };

      const required = await gate.isApprovalRequired(action);
      expect(required).toBe(true);
    });

    it('should not require approval for reads', async () => {
      const action = {
        type: 'observe',
        effect: 'read',
      };

      const required = await gate.isApprovalRequired(action);
      expect(required).toBe(false);
    });

    it('should not require approval for navigation', async () => {
      const action = {
        type: 'navigate',
        effect: 'navigation',
      };

      const required = await gate.isApprovalRequired(action);
      expect(required).toBe(false);
    });

    it('should require approval for form submissions', async () => {
      const action = {
        type: 'click',
        effect: 'transaction',
        target: { ref: 'submit-button' },
      };

      const required = await gate.isApprovalRequired(action);
      expect(required).toBe(true);
    });

    it('should auto-approve safe actions', async () => {
      const action = {
        type: 'scroll',
        effect: 'read',
      };

      const required = await gate.isApprovalRequired(action);
      expect(required).toBe(false);
    });
  });

  describe('approval token generation', () => {
    it('should generate valid approval token', async () => {
      const request = {
        sessionId: 'ses_01',
        action: { type: 'click', effect: 'transaction' },
      };

      const token = await gate.generateApprovalToken(request);

      expect(token).toBeDefined();
      expect(token.tokenId).toBeDefined();
      expect(token.sessionId).toBe('ses_01');
      expect(token.expiresAt).toBeGreaterThan(Date.now());
      expect(token.status).toBe('pending');
    });

    it('should include action fingerprint in token', async () => {
      const request = {
        sessionId: 'ses_01',
        action: { type: 'fill', value: 'sensitive' },
      };

      const token = await gate.generateApprovalToken(request);

      expect(token.actionFingerprint).toBeDefined();
      expect(token.actionFingerprint).toContain('fill');
    });

    it('should set token expiration time', async () => {
      const gateWithExpiry = new ApprovalGate({ tokenTtlMs: 5000 });

      const request = {
        sessionId: 'ses_01',
        action: { type: 'click' },
      };

      const before = Date.now();
      const token = await gateWithExpiry.generateApprovalToken(request);
      const after = Date.now();

      expect(token.expiresAt).toBeGreaterThanOrEqual(before + 5000);
      expect(token.expiresAt).toBeLessThanOrEqual(after + 5000);
    });

    it('should generate unique token IDs', async () => {
      const request = {
        sessionId: 'ses_01',
        action: { type: 'click' },
      };

      const token1 = await gate.generateApprovalToken(request);
      const token2 = await gate.generateApprovalToken(request);

      expect(token1.tokenId).not.toBe(token2.tokenId);
    });
  });

  describe('approval token validation', () => {
    it('should validate legitimate approval token', async () => {
      const request = {
        sessionId: 'ses_01',
        action: { type: 'click' },
      };

      const token = await gate.generateApprovalToken(request);

      const valid = await gate.validateApprovalToken(token.tokenId, request);
      expect(valid).toBe(true);
    });

    it('should reject invalid token IDs', async () => {
      const request = {
        sessionId: 'ses_01',
        action: { type: 'click' },
      };

      const valid = await gate.validateApprovalToken('invalid_token', request);
      expect(valid).toBe(false);
    });

    it('should reject expired tokens', async () => {
      const gateWithShortTtl = new ApprovalGate({ tokenTtlMs: 1 });

      const request = {
        sessionId: 'ses_01',
        action: { type: 'click' },
      };

      const token = await gateWithShortTtl.generateApprovalToken(request);

      // Wait for token to expire
      await new Promise((resolve) => setTimeout(resolve, 10));

      const valid = await gateWithShortTtl.validateApprovalToken(token.tokenId, request);
      expect(valid).toBe(false);
    });

    it('should reject tokens for wrong action', async () => {
      const request1 = {
        sessionId: 'ses_01',
        action: { type: 'click', target: { ref: 'button1' } },
      };

      const request2 = {
        sessionId: 'ses_01',
        action: { type: 'click', target: { ref: 'button2' } },
      };

      const token = await gate.generateApprovalToken(request1);

      const valid = await gate.validateApprovalToken(token.tokenId, request2);
      expect(valid).toBe(false);
    });

    it('should reject tokens for wrong session', async () => {
      const request1 = {
        sessionId: 'ses_01',
        action: { type: 'click' },
      };

      const request2 = {
        sessionId: 'ses_02',
        action: { type: 'click' },
      };

      const token = await gate.generateApprovalToken(request1);

      const valid = await gate.validateApprovalToken(token.tokenId, request2);
      expect(valid).toBe(false);
    });
  });

  describe('token usage', () => {
    it('should mark token as used when consumed', async () => {
      const request = {
        sessionId: 'ses_01',
        action: { type: 'click' },
      };

      const token = await gate.generateApprovalToken(request);
      expect(token.status).toBe('pending');

      await gate.useApprovalToken(token.tokenId);

      const usedToken = await gate.getToken(token.tokenId);
      expect(usedToken?.status).toBe('used');
    });

    it('should invalidate used tokens', async () => {
      const token = await gate.generateApprovalToken({
        sessionId: 'ses_01',
        action: { type: 'click' },
      });

      await gate.useApprovalToken(token.tokenId);

      await expect(
        gate.validateApprovalToken(token.tokenId, {
          sessionId: 'ses_01',
          action: { type: 'click' },
        })
      ).resolves.toBe(false);
    });

    it('should prevent token reuse', async () => {
      const token = await gate.generateApprovalToken({
        sessionId: 'ses_01',
        action: { type: 'click' },
      });

      await gate.useApprovalToken(token.tokenId);

      try {
        await gate.useApprovalToken(token.tokenId);
        fail('Should have thrown ApprovalError');
      } catch (error) {
        expect(error).toBeInstanceOf(ApprovalError);
        expect((error as ApprovalError).code).toBe('INVALID_TOKEN');
      }
    });

    it('should throw error for non-existent token', async () => {
      try {
        await gate.useApprovalToken('nonexistent');
        fail('Should have thrown ApprovalError');
      } catch (error) {
        expect(error).toBeInstanceOf(ApprovalError);
        expect((error as ApprovalError).code).toBe('INVALID_TOKEN');
      }
    });
  });

  describe('token lifecycle', () => {
    it('should clean up expired tokens', async () => {
      const gateWithShortTtl = new ApprovalGate({
        tokenTtlMs: 10,
        cleanupIntervalMs: 100,
      });

      // Generate a token
      const token = await gateWithShortTtl.generateApprovalToken({
        sessionId: 'ses_01',
        action: { type: 'click' },
      });

      // Wait for expiration and cleanup
      await new Promise((resolve) => setTimeout(resolve, 150));

      const valid = await gateWithShortTtl.validateApprovalToken(token.tokenId, {
        sessionId: 'ses_01',
        action: { type: 'click' },
      });

      expect(valid).toBe(false);
    });

    it('should keep the session index consistent with the primary token map across create/use/cleanup (TD-BROWSER-9, A6)', async () => {
      // A long ttl so only the explicit useApprovalToken() below - not time -
      // drives which tokens runCleanup purges; a short cleanup interval so
      // the purge is observable within the test.
      const gate = new ApprovalGate({ tokenTtlMs: 5000, cleanupIntervalMs: 50 });

      // Two sessions, mixed tokens.
      const usedToken = await gate.generateApprovalToken({
        sessionId: 'ses_a',
        action: { type: 'click' },
      });
      await gate.generateApprovalToken({ sessionId: 'ses_a', action: { type: 'fill' } });
      const otherSessionToken = await gate.generateApprovalToken({
        sessionId: 'ses_b',
        action: { type: 'click' },
      });

      expect(await gate.getSessionTokens('ses_a')).toHaveLength(2);
      expect(await gate.getSessionTokens('ses_b')).toHaveLength(1);

      // Mark one 'used' - runCleanup purges used tokens regardless of ttl.
      await gate.useApprovalToken(usedToken.tokenId);

      // Wait past one cleanup pass.
      await new Promise((resolve) => setTimeout(resolve, 100));

      // ses_a's used token is gone from the index, its pending one remains,
      // and ses_b's untouched token is unaffected - proves the index isn't
      // just cleared wholesale on a cleanup pass.
      const remainingA = await gate.getSessionTokens('ses_a');
      expect(remainingA).toHaveLength(1);
      expect(remainingA[0]?.tokenId).not.toBe(usedToken.tokenId);

      const remainingB = await gate.getSessionTokens('ses_b');
      expect(remainingB).toHaveLength(1);
      expect(remainingB[0]?.tokenId).toBe(otherSessionToken.tokenId);

      await gate.shutdown();
    });

    it('routes a failed cleanup pass through the injected logger, not console (hygiene G2)', async () => {
      const lines: string[] = [];
      const logger = new StructuredLogger({ sink: (line) => lines.push(line) });
      const loggedGate = new ApprovalGate({ cleanupIntervalMs: 30, logger });

      // runCleanup's body is a pure synchronous map purge with no natural
      // throw path; force the failure the catch handler exists for, to
      // prove the wiring (not to simulate a realistic scenario).
      (loggedGate as unknown as { runCleanup(): Promise<void> }).runCleanup = async () => {
        throw new Error('cleanup exploded');
      };

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(lines.some((line) => line.includes('approval.cleanup-failed'))).toBe(true);
      expect(lines.some((line) => line.includes('cleanup exploded'))).toBe(true);

      await loggedGate.shutdown();
    });

    it('should maintain token count within limits', async () => {
      const gateWithLimit = new ApprovalGate({ maxTokens: 5 });

      // Generate tokens up to limit
      for (let i = 0; i < 5; i++) {
        await gateWithLimit.generateApprovalToken({
          sessionId: `ses_${i}`,
          action: { type: 'click' },
        });
      }

      // Should still be able to generate (old ones expire)
      const token = await gateWithLimit.generateApprovalToken({
        sessionId: 'ses_new',
        action: { type: 'click' },
      });

      expect(token).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('should provide detailed error messages', async () => {
      try {
        await gate.useApprovalToken('nonexistent');
        fail('Should have thrown ApprovalError');
      } catch (error) {
        expect(error).toBeInstanceOf(ApprovalError);
        expect((error as ApprovalError).code).toBe('INVALID_TOKEN');
        expect((error as ApprovalError).retryable).toBe(false);
      }
    });

    it('should include token details in errors', async () => {
      try {
        await gate.useApprovalToken('some_token');
        fail('Should have thrown ApprovalError');
      } catch (error) {
        expect((error as ApprovalError).details).toEqual(
          expect.objectContaining({
            tokenId: 'some_token',
          })
        );
      }
    });

    it('should handle cleanup errors gracefully', async () => {
      const gateWithCleanup = new ApprovalGate({
        tokenTtlMs: 1,
        cleanupIntervalMs: 10,
      });

      // Generate many tokens to trigger cleanup
      for (let i = 0; i < 20; i++) {
        await gateWithCleanup.generateApprovalToken({
          sessionId: `ses_${i}`,
          action: { type: 'click' },
        });
      }

      // Should not throw during cleanup
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(gateWithCleanup.getTokenCount()).toBeGreaterThanOrEqual(0);
    });
  });

  describe('configuration', () => {
    it('should use default configuration', () => {
      const defaultGate = new ApprovalGate();

      expect(defaultGate).toBeDefined();
      expect(defaultGate.getTokenCount()).toBe(0);
    });

    it('should accept custom configuration', () => {
      const customGate = new ApprovalGate({
        tokenTtlMs: 60000,
        maxTokens: 100,
        cleanupIntervalMs: 5000,
      });

      expect(customGate).toBeDefined();
    });

    it('should validate token TTL is positive', () => {
      expect(() => new ApprovalGate({ tokenTtlMs: 1000 })).not.toThrow();
      expect(() => new ApprovalGate({ tokenTtlMs: 0 })).toThrow();
      expect(() => new ApprovalGate({ tokenTtlMs: -1 })).toThrow();
    });

    it('should validate max tokens is positive', () => {
      expect(() => new ApprovalGate({ maxTokens: 10 })).not.toThrow();
      expect(() => new ApprovalGate({ maxTokens: 0 })).toThrow();
      expect(() => new ApprovalGate({ maxTokens: -1 })).toThrow();
    });
  });

  describe('token queries', () => {
    it('should retrieve token by ID', async () => {
      const request = {
        sessionId: 'ses_01',
        action: { type: 'click' },
      };

      const token = await gate.generateApprovalToken(request);

      const retrieved = await gate.getToken(token.tokenId);
      expect(retrieved).toEqual(token);
    });

    it('should return undefined for non-existent token', async () => {
      const retrieved = await gate.getToken('nonexistent');
      expect(retrieved).toBeUndefined();
    });

    it('should list tokens for session', async () => {
      // Generate tokens for same session
      await gate.generateApprovalToken({
        sessionId: 'ses_01',
        action: { type: 'click' },
      });

      await gate.generateApprovalToken({
        sessionId: 'ses_01',
        action: { type: 'fill' },
      });

      const tokens = await gate.getSessionTokens('ses_01');
      expect(tokens).toHaveLength(2);
    });

    it('should return empty array for session with no tokens', async () => {
      const tokens = await gate.getSessionTokens('nonexistent_session');
      expect(tokens).toEqual([]);
    });

    it('should get token count', async () => {
      expect(gate.getTokenCount()).toBe(0);

      await gate.generateApprovalToken({
        sessionId: 'ses_01',
        action: { type: 'click' },
      });

      expect(gate.getTokenCount()).toBe(1);
    });
  });

  describe('action risk classification', () => {
    it('should classify high-risk actions', async () => {
      const highRiskActions = [
        { type: 'click', effect: 'transaction' },
        { type: 'fill', effect: 'account_change' },
        { type: 'select', effect: 'transaction' },
      ];

      for (const action of highRiskActions) {
        const required = await gate.isApprovalRequired(action);
        expect(required).toBe(true);
      }
    });

    it('should classify low-risk actions', async () => {
      const lowRiskActions = [
        { type: 'observe', effect: 'read' },
        { type: 'navigate', effect: 'navigation' },
        { type: 'scroll', effect: 'read' },
      ];

      for (const action of lowRiskActions) {
        const required = await gate.isApprovalRequired(action);
        expect(required).toBe(false);
      }
    });
  });
});
