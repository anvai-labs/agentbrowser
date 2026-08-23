/**
 * TDD Tests for Action Execution with Element References
 *
 * These tests define the expected behavior of stable element reference
 * resolution, staleness detection, and action execution through refs.
 *
 * The contract under test is the versioned protocol contract:
 * `ActionRequest` in, `ActionResult` out. Failures are reported as a typed
 * `error` payload on the result, never as a thrown exception.
 */

import type { EnginePage, ResolvedTarget } from '@agentbrowser/engine';
import type { ActionRequest, PageState } from '@agentbrowser/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from './action-executor';

describe('ActionExecutor', () => {
  let executor: ActionExecutor;
  let mockEnginePage: EnginePage;
  let mockObservation: PageState;

  /** Build a request for the common case: page pg_test at revision 1. */
  const req = (
    action: ActionRequest['action'],
    overrides: Partial<ActionRequest> = {}
  ): ActionRequest => ({
    pageId: 'pg_test',
    expectedRevision: 1,
    action,
    ...overrides,
  });

  const effect = (overrides: Record<string, unknown> = {}) => ({
    actionId: 'act_1',
    startTimestamp: '2025-01-23T10:00:00Z',
    endTimestamp: '2025-01-23T10:00:01Z',
    oldRevision: 1,
    newRevision: 1,
    result: { ok: true },
    ...overrides,
  });

  beforeEach(() => {
    executor = new ActionExecutor();

    mockEnginePage = {
      id: 'pg_test',
      resolve: vi.fn(),
      act: vi.fn(),
      navigate: vi.fn(),
      observe: vi.fn(),
      extract: vi.fn(),
      screenshot: vi.fn(),
      events: async function* () {
        yield* [];
      },
    } as unknown as EnginePage;

    mockObservation = {
      sessionId: 'ses_test',
      pageId: 'pg_test',
      revision: 1,
      url: 'https://example.com',
      title: 'Test Page',
      status: 'interactive',
      summary: 'Page with 1 button',
      elements: [
        {
          ref: 'e1_0',
          role: 'button',
          name: 'Submit',
          visible: true,
          enabled: true,
        },
      ],
      truncated: false,
      untrustedContent: true,
    };
  });

  describe('element reference resolution', () => {
    it('should resolve element ref to engine target', async () => {
      const resolvedTarget: ResolvedTarget = {
        ref: 'e1_0',
        fingerprint: 'button_Submit_visible_true_enabled_true',
        role: 'button',
        name: 'Submit',
        visible: true,
        enabled: true,
      };

      (mockEnginePage.resolve as any).mockResolvedValue(resolvedTarget);
      (mockEnginePage.act as any).mockResolvedValue(effect());

      const result = await executor.execute(req({ type: 'click', target: { ref: 'e1_0' } }), {
        enginePage: mockEnginePage,
        observation: mockObservation,
      });

      expect(mockEnginePage.resolve).toHaveBeenCalledWith({ ref: 'e1_0' });
      expect(result.error).toBeUndefined();
      expect(result.targetFingerprint).toBe('button_Submit_visible_true_enabled_true');
    });

    it('should fail with TARGET_NOT_FOUND for invalid ref', async () => {
      (mockEnginePage.resolve as any).mockRejectedValue(new Error('Element not found'));

      const result = await executor.execute(req({ type: 'click', target: { ref: 'e999_0' } }), {
        enginePage: mockEnginePage,
        observation: mockObservation,
      });

      expect(result.error?.code).toBe('TARGET_NOT_FOUND');
      expect(result.error?.retryable).toBe(false);
    });
  });

  describe('staleness detection', () => {
    it('should detect stale target when the page revision has moved on', async () => {
      (mockEnginePage.resolve as any).mockResolvedValue({
        ref: 'e1_0',
        fingerprint: 'button_Submit_visible_true_enabled_true',
        role: 'button',
        name: 'Submit',
        visible: true,
        enabled: true,
      });

      const result = await executor.execute(req({ type: 'click', target: { ref: 'e1_0' } }), {
        enginePage: mockEnginePage,
        observation: mockObservation,
        currentRevision: 2, // page has advanced past the caller's expectedRevision
      });

      expect(result.error?.code).toBe('STALE_TARGET');
      expect(result.error?.message).toContain('revision');
      expect(result.error?.retryable).toBe(true);
      expect(mockEnginePage.act).not.toHaveBeenCalled();
    });

    it('should reject a ref minted at a different revision', async () => {
      (mockEnginePage.resolve as any).mockResolvedValue({
        ref: 'e2_0',
        fingerprint: 'button_Submit',
        role: 'button',
        name: 'Submit',
        visible: true,
        enabled: true,
      });

      // Caller believes the page is at revision 1, but hands over a rev-2 ref
      const result = await executor.execute(req({ type: 'click', target: { ref: 'e2_0' } }), {
        enginePage: mockEnginePage,
        observation: mockObservation,
      });

      expect(result.error?.code).toBe('STALE_TARGET');
      expect(mockEnginePage.act).not.toHaveBeenCalled();
    });

    it('should reject a malformed element reference', async () => {
      (mockEnginePage.resolve as any).mockResolvedValue({
        ref: 'not-a-ref',
        fingerprint: 'button_Submit',
        role: 'button',
        name: 'Submit',
        visible: true,
        enabled: true,
      });

      const result = await executor.execute(req({ type: 'click', target: { ref: 'not-a-ref' } }), {
        enginePage: mockEnginePage,
        observation: mockObservation,
      });

      expect(result.error?.code).toBe('INVALID_REQUEST');
    });

    it('should allow action when revision matches', async () => {
      (mockEnginePage.resolve as any).mockResolvedValue({
        ref: 'e1_0',
        fingerprint: 'button_Submit_visible_true_enabled_true',
        role: 'button',
        name: 'Submit',
        visible: true,
        enabled: true,
      });
      (mockEnginePage.act as any).mockResolvedValue(effect());

      const result = await executor.execute(req({ type: 'click', target: { ref: 'e1_0' } }), {
        enginePage: mockEnginePage,
        observation: mockObservation,
      });

      expect(result.error).toBeUndefined();
      expect(result.oldRevision).toBe(1);
      expect(result.newRevision).toBe(1);
    });
  });

  describe('action execution', () => {
    it('should execute click action', async () => {
      (mockEnginePage.resolve as any).mockResolvedValue({
        ref: 'e1_0',
        fingerprint: 'button_Submit_visible_true_enabled_true',
        role: 'button',
        name: 'Submit',
        visible: true,
        enabled: true,
      });
      (mockEnginePage.act as any).mockResolvedValue(effect({ actionId: 'act_click' }));

      const result = await executor.execute(req({ type: 'click', target: { ref: 'e1_0' } }), {
        enginePage: mockEnginePage,
        observation: mockObservation,
      });

      expect(mockEnginePage.act).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'click', target: { ref: 'e1_0' } })
      );
      expect(result.actionId).toBe('act_click');
      expect(result.error).toBeUndefined();
    });

    it('should execute fill action with value', async () => {
      (mockEnginePage.resolve as any).mockResolvedValue({
        ref: 'e1_0',
        fingerprint: 'textbox_Email_visible_true_enabled_true',
        role: 'textbox',
        name: 'Email',
        visible: true,
        enabled: true,
      });
      (mockEnginePage.act as any).mockResolvedValue(effect({ actionId: 'act_fill' }));

      const observation: PageState = {
        ...mockObservation,
        elements: [{ ref: 'e1_0', role: 'textbox', name: 'Email', visible: true, enabled: true }],
      };

      const result = await executor.execute(
        req({ type: 'fill', target: { ref: 'e1_0' }, value: 'test@example.com' }),
        { enginePage: mockEnginePage, observation }
      );

      expect(mockEnginePage.act).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'fill',
          target: { ref: 'e1_0' },
          value: 'test@example.com',
        })
      );
      expect(result.error).toBeUndefined();
    });

    it('should execute select action with values', async () => {
      (mockEnginePage.resolve as any).mockResolvedValue({
        ref: 'e1_0',
        fingerprint: 'combobox_Country_visible_true_enabled_true',
        role: 'combobox',
        name: 'Country',
        visible: true,
        enabled: true,
      });
      (mockEnginePage.act as any).mockResolvedValue(effect({ actionId: 'act_select' }));

      const observation: PageState = {
        ...mockObservation,
        elements: [
          { ref: 'e1_0', role: 'combobox', name: 'Country', visible: true, enabled: true },
        ],
      };

      const result = await executor.execute(
        req({ type: 'select', target: { ref: 'e1_0' }, values: ['Canada'] }),
        { enginePage: mockEnginePage, observation }
      );

      expect(mockEnginePage.act).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'select',
          target: { ref: 'e1_0' },
          values: ['Canada'],
        })
      );
      expect(result.error).toBeUndefined();
    });

    it('should execute untargeted scroll action', async () => {
      (mockEnginePage.act as any).mockResolvedValue(effect({ actionId: 'act_scroll' }));

      const result = await executor.execute(
        req({ type: 'scroll', direction: 'down', amount: 100 }),
        { enginePage: mockEnginePage, observation: mockObservation }
      );

      expect(mockEnginePage.resolve).not.toHaveBeenCalled();
      expect(mockEnginePage.act).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'scroll', direction: 'down', amount: 100 })
      );
      expect(result.error).toBeUndefined();
    });

    it('should execute press action', async () => {
      (mockEnginePage.act as any).mockResolvedValue(effect({ actionId: 'act_press' }));

      const result = await executor.execute(req({ type: 'press', key: 'Enter' }), {
        enginePage: mockEnginePage,
        observation: mockObservation,
      });

      expect(mockEnginePage.act).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'press', key: 'Enter' })
      );
      expect(result.error).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('should reject a disabled element', async () => {
      (mockEnginePage.resolve as any).mockResolvedValue({
        ref: 'e1_0',
        fingerprint: 'button_Submit',
        role: 'button',
        name: 'Submit',
        visible: true,
        enabled: false,
      });

      const result = await executor.execute(req({ type: 'click', target: { ref: 'e1_0' } }), {
        enginePage: mockEnginePage,
        observation: mockObservation,
      });

      expect(result.error?.code).toBe('TARGET_DISABLED');
      expect(mockEnginePage.act).not.toHaveBeenCalled();
    });

    it('should reject an invisible element', async () => {
      (mockEnginePage.resolve as any).mockResolvedValue({
        ref: 'e1_0',
        fingerprint: 'button_Submit',
        role: 'button',
        name: 'Submit',
        visible: false,
        enabled: true,
      });

      const result = await executor.execute(req({ type: 'click', target: { ref: 'e1_0' } }), {
        enginePage: mockEnginePage,
        observation: mockObservation,
      });

      expect(result.error?.code).toBe('TARGET_NOT_VISIBLE');
      expect(mockEnginePage.act).not.toHaveBeenCalled();
    });

    it('should map ambiguous resolution to TARGET_AMBIGUOUS', async () => {
      (mockEnginePage.resolve as any).mockRejectedValue(new Error('Multiple elements match ref'));

      const result = await executor.execute(req({ type: 'click', target: { ref: 'e1_0' } }), {
        enginePage: mockEnginePage,
        observation: mockObservation,
      });

      expect(result.error?.code).toBe('TARGET_AMBIGUOUS');
    });

    it('should map unrecognized engine failures to INTERNAL', async () => {
      (mockEnginePage.resolve as any).mockRejectedValue(new Error('Browser crashed'));

      const result = await executor.execute(req({ type: 'click', target: { ref: 'e1_0' } }), {
        enginePage: mockEnginePage,
        observation: mockObservation,
      });

      expect(result.error?.code).toBe('INTERNAL');
      expect(result.error?.message).toContain('Browser crashed');
    });

    it('should return a well-formed ActionResult even on failure', async () => {
      (mockEnginePage.resolve as any).mockRejectedValue(new Error('Browser crashed'));

      const result = await executor.execute(req({ type: 'click', target: { ref: 'e1_0' } }), {
        enginePage: mockEnginePage,
        observation: mockObservation,
      });

      expect(result.actionId).toEqual(expect.any(String));
      expect(result.startTimestamp).toEqual(expect.any(String));
      expect(result.endTimestamp).toEqual(expect.any(String));
      expect(result.oldRevision).toBe(1);
      expect(result.newRevision).toBe(1);
    });
  });

  describe('semantic fingerprinting', () => {
    it('should detect a changed element via fingerprint mismatch', async () => {
      (mockEnginePage.resolve as any).mockResolvedValue({
        ref: 'e1_0',
        fingerprint: 'button_Cancel_visible_true_enabled_true', // name changed
        role: 'button',
        name: 'Cancel',
        visible: true,
        enabled: true,
      });

      const result = await executor.execute(req({ type: 'click', target: { ref: 'e1_0' } }), {
        enginePage: mockEnginePage,
        observation: mockObservation,
      });

      expect(result.error?.code).toBe('STALE_TARGET');
      expect(result.error?.message).toContain('fingerprint');
      expect(mockEnginePage.act).not.toHaveBeenCalled();
    });
  });

  describe('post-action observation', () => {
    it('should attach a normalized observation when observeAfter is requested', async () => {
      (mockEnginePage.resolve as any).mockResolvedValue({
        ref: 'e1_0',
        fingerprint: 'button_Submit_visible_true_enabled_true',
        role: 'button',
        name: 'Submit',
        visible: true,
        enabled: true,
      });
      (mockEnginePage.act as any).mockResolvedValue(
        effect({ actionId: 'act_click', newRevision: 2 })
      );
      (mockEnginePage.observe as any).mockResolvedValue({
        url: 'https://example.com/done',
        title: 'Done',
        status: 'complete',
        content: 'Done',
        elements: [{ role: 'button', name: 'Continue', visible: true, enabled: true }],
      });

      const result = await executor.execute(
        req({ type: 'click', target: { ref: 'e1_0' } }, { observeAfter: { mode: 'interactive' } }),
        { enginePage: mockEnginePage, observation: mockObservation }
      );

      expect(result.newRevision).toBe(2);
      expect(mockEnginePage.observe).toHaveBeenCalledWith({ mode: 'interactive' });
      expect(result.observation?.revision).toBe(2);
      expect(result.observation?.url).toBe('https://example.com/done');
      // refs in the post-action observation belong to the new revision
      expect(result.observation?.elements[0]?.ref).toMatch(/^e2_/);
    });

    it('should not observe when observeAfter is absent', async () => {
      (mockEnginePage.resolve as any).mockResolvedValue({
        ref: 'e1_0',
        fingerprint: 'button_Submit_visible_true_enabled_true',
        role: 'button',
        name: 'Submit',
        visible: true,
        enabled: true,
      });
      (mockEnginePage.act as any).mockResolvedValue(effect({ newRevision: 2 }));

      const result = await executor.execute(req({ type: 'click', target: { ref: 'e1_0' } }), {
        enginePage: mockEnginePage,
        observation: mockObservation,
      });

      expect(mockEnginePage.observe).not.toHaveBeenCalled();
      expect(result.observation).toBeUndefined();
    });
  });

  describe('action validation', () => {
    it('should require a value for fill', async () => {
      const result = await executor.execute(req({ type: 'fill', target: { ref: 'e1_0' } } as any), {
        enginePage: mockEnginePage,
        observation: mockObservation,
      });

      expect(result.error?.code).toBe('INVALID_REQUEST');
      expect(mockEnginePage.resolve).not.toHaveBeenCalled();
    });

    it('should require values for select', async () => {
      const result = await executor.execute(
        req({ type: 'select', target: { ref: 'e1_0' } } as any),
        { enginePage: mockEnginePage, observation: mockObservation }
      );

      expect(result.error?.code).toBe('INVALID_REQUEST');
    });

    it('should require a key for press', async () => {
      const result = await executor.execute(req({ type: 'press' } as any), {
        enginePage: mockEnginePage,
        observation: mockObservation,
      });

      expect(result.error?.code).toBe('INVALID_REQUEST');
    });

    it('should reject unsupported action types', async () => {
      const result = await executor.execute(req({ type: 'evaluate' } as any), {
        enginePage: mockEnginePage,
        observation: mockObservation,
      });

      expect(result.error?.code).toBe('INVALID_REQUEST');
      expect(result.error?.message).toContain('evaluate');
    });
  });
});
