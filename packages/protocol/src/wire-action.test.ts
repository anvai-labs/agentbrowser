import { describe, expect, it } from 'vitest';
import { validateAction, validatePlanStep } from './validators.js';
import {
  decodeWireAction,
  MAX_BATCH_STEPS,
  validateWireAction,
  validateWireActionBatch,
} from './wire-action.js';

describe('wire action contract', () => {
  it('preserves checked upload metadata across wire decoding', () => {
    const fields = {
      paths: ['/tmp/resume.pdf'],
      sha256: 'a'.repeat(64),
      mimeType: 'application/pdf',
    };
    expect(decodeWireAction({ action: 'upload', ...fields })).toEqual({
      ok: true,
      value: { type: 'upload', ...fields },
    });
  });
  it.each([
    { paths: ['/tmp/a.pdf'], sha256: 'A'.repeat(64) },
    { paths: ['/tmp/a.pdf'], sha256: 'a'.repeat(63) },
    { paths: ['/tmp/a.pdf'], sha256: `${'a'.repeat(64)}\n` },
    { paths: ['/tmp/a.pdf'], sha256: 'a'.repeat(64), mimeType: 'application/pdf\n' },
    { paths: ['/tmp/a.pdf'], sha256: 1 },
    { paths: ['/tmp/a.pdf', '/tmp/b.pdf'], sha256: 'a'.repeat(64) },
    { paths: ['/tmp/a.pdf'], mimeType: 'application/pdf' },
    { paths: ['/tmp/a.pdf'], sha256: 'a'.repeat(64), mimeType: 'text/plain\r\nx: y' },
    { paths: ['/tmp/a.pdf'], sha256: 'a'.repeat(64), mimeType: `text/${'a'.repeat(128)}` },
  ])('rejects invalid upload integrity fields at every protocol entry: %j', (fields) => {
    expect(validatePlanStep({ action: 'upload', ...fields }).ok).toBe(false);
    expect(decodeWireAction({ action: 'upload', ...fields }).ok).toBe(false);
    expect(validateAction({ type: 'upload', ...fields }).ok).toBe(false);
  });
  it.each([{ sha256: 'a'.repeat(64) }, { mimeType: 'application/pdf' }])(
    'does not silently ignore integrity metadata on other actions: %j',
    (fields) => {
      expect(validatePlanStep({ action: 'reload', ...fields }).ok).toBe(false);
      expect(decodeWireAction({ action: 'reload', ...fields }).ok).toBe(false);
      expect(validateAction({ type: 'reload', ...fields }).ok).toBe(false);
    }
  );
  it.each([
    { action: 'reload' },
    { action: 'press', key: 'Enter' },
    { action: 'typeText', target: { ref: 'e1_0' }, value: 'Job Board' },
    { action: 'typeText', target: { ref: 'e1_0' }, value: 'Job Board', delay: 50 },
    { action: 'press', key: 'ArrowDown', target: { ref: 'e1_0' }, count: 5 },
    { action: 'press', key: 'ArrowDown', count: 1 },
    { action: 'scroll', direction: 'down', amount: 250 },
    { action: 'wait', condition: { until: 'load' } },
    { action: 'upload', paths: ['/tmp/x.pdf'] },
    { action: 'upload', target: { ref: 'e1_0' }, paths: ['/tmp/a.pdf', '/tmp/b.pdf'] },
  ])('accepts untargeted $action', (action) => {
    expect(validateWireAction(action).ok).toBe(true);
  });
  it.each([
    { action: 'click' },
    { action: 'hover', type: 'click', target: { ref: 'e1_0' } },
    { action: 'select', type: 'click', target: { ref: 'e1_0' }, value: 'one' },
    { action: 'reload', type: 'navigate', url: 'https://example.com' },
    { action: 'press' },
    { action: 'typeText', value: '' },
    { action: 'typeText', value: 'x', delay: 5000 },
    { action: 'typeText', value: 'x'.repeat(5001) },
    { action: 'press', key: 'Enter', count: 0 },
    { action: 'press', key: 'Enter', count: 21 },
    { action: 'press', key: 'Enter', count: 1.5 },
    { action: 'wait' },
    { action: 'reload', target: {} },
    { action: 'click', target: { ref: 'e1_0' }, expectedRevision: -1 },
    { action: 'upload' },
    { action: 'upload', paths: [] },
    { action: 'upload', paths: ['/tmp/x.pdf'], target: { ref: 'nope' } },
  ])('rejects invalid $action', (action) => {
    expect(validateWireAction(action).ok).toBe(false);
  });
  describe('near-text target form (TD-BROWSER-18 gap 6)', () => {
    it('accepts a click targeting text with row preference', () => {
      expect(
        decodeWireAction({ action: 'click', target: { nearText: 'Billing', row: true } })
      ).toEqual({
        ok: true,
        value: { type: 'click', target: { nearText: 'Billing', row: true } },
      });
    });

    it('accepts the near-text form without row and round-trips through validateWireAction', () => {
      const result = validateWireAction({ action: 'click', target: { nearText: 'Security' } });
      expect(result).toMatchObject({ ok: true, value: { target: { nearText: 'Security' } } });
    });

    it('accepts fill/select/check/uncheck/hover/clear with the near-text form', () => {
      const accepts = (action: string, extra: Record<string, unknown>) => {
        expect(validateWireAction({ action, target: { nearText: 'Billing' }, ...extra }).ok).toBe(
          true
        );
      };
      accepts('fill', { value: 'x' });
      accepts('select', { value: 'one' });
      accepts('check', {});
      accepts('uncheck', {});
      accepts('hover', {});
      accepts('clear', {});
    });

    it('rejects an empty, oversized, or non-string needle', () => {
      for (const nearText of ['', 'x'.repeat(201), 7, null]) {
        expect(validateWireAction({ action: 'click', target: { nearText } }).ok).toBe(false);
      }
    });

    it('rejects a near-text target with no needle at all', () => {
      expect(validateWireAction({ action: 'click', target: { row: true } }).ok).toBe(false);
      expect(validateWireAction({ action: 'click', target: {} }).ok).toBe(false);
    });

    it('rejects row alongside a ref target (one form per target)', () => {
      expect(validateWireAction({ action: 'click', target: { ref: 'e1_0', row: true } }).ok).toBe(
        false
      );
    });

    it('keeps rejecting malformed refs when the ref form is used', () => {
      expect(validateWireAction({ action: 'click', target: { ref: 'button.submit' } }).ok).toBe(
        false
      );
    });

    it('carries the near-text form through a batch step', () => {
      const result = validateWireActionBatch({
        steps: [{ action: 'click', target: { nearText: 'Add member', row: true } }],
      });
      expect(result.ok).toBe(true);
    });
  });

  it('accepts type as a deprecated alias for action', () => {
    const result = decodeWireAction({ type: 'click', target: { ref: 'e1_0' } });
    expect(result).toMatchObject({ ok: true, value: { type: 'click', target: { ref: 'e1_0' } } });
    if (result.ok) {
      expect(result.warnings).toEqual(["Field 'type' is deprecated; use 'action'."]);
    }
  });
  it('accepts an untargeted type alias', () => {
    const result = decodeWireAction({ type: 'reload' });
    expect(result).toMatchObject({ ok: true, value: { type: 'reload' } });
    if (result.ok) {
      expect(result.warnings).toEqual(["Field 'type' is deprecated; use 'action'."]);
    }
  });
  it('rejects type when action is also present', () => {
    expect(decodeWireAction({ action: 'click', type: 'click', target: { ref: 'e1_0' } }).ok).toBe(
      false
    );
  });
  it('does not translate an unknown type value', () => {
    expect(decodeWireAction({ type: 'detonate' }).ok).toBe(false);
  });
  it('normalizes legacy select without leaking orchestration to the adapter', () => {
    expect(
      decodeWireAction({
        action: 'select',
        target: { ref: 'e1_0' },
        value: 'one',
        approvalToken: 'token',
        observe: 'after',
      })
    ).toEqual({ ok: true, value: { type: 'select', target: { ref: 'e1_0' }, values: ['one'] } });
  });
  it('names the flat shape when action is a nested object instead of a string', () => {
    const nested = { action: { type: 'click', target: { ref: 'e1_0' } } };
    for (const result of [decodeWireAction(nested), validatePlanStep(nested)]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toEqual([
          { path: '/action', message: expect.stringMatching(/flat shape/) },
        ]);
        expect(result.issues[0].message).not.toContain('Expected union value');
      }
    }
  });
  it('still reports the required-field error when action is absent', () => {
    const result = validatePlanStep({ target: { ref: 'e1_0' } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === '/action')).toBe(true);
      expect(result.issues.every((issue) => !/flat shape/.test(issue.message))).toBe(true);
    }
  });
});

describe('wire action batch envelope', () => {
  const step = { action: 'click', target: { ref: 'e1_0' } };

  it.each([null, undefined, true, false, 42, 'steps', [], [step]])(
    'rejects a non-object batch envelope without throwing: %j',
    (body) => {
      expect(validateWireActionBatch(body)).toEqual({
        ok: false,
        issues: [{ path: '', message: 'Batch envelope must be an object.' }],
      });
    }
  );

  it('accepts a bounded batch of standalone steps with optional envelope fields', () => {
    const result = validateWireActionBatch({
      steps: [step, { action: 'reload' }, { action: 'wait', condition: { until: 'load' } }],
      observe: 'after',
      wait: { until: 'networkidle', timeoutMs: 5000 },
      expectedRevision: 7,
      approvalToken: 'tok_x',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects action/type alongside steps as an ambiguous envelope', () => {
    for (const envelope of [
      { action: 'click', steps: [{ action: 'reload' }] },
      { type: 'click', steps: [{ action: 'reload' }] },
    ]) {
      const result = validateWireActionBatch(envelope);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toEqual([
          {
            path: '/steps',
            message: 'A batch envelope carries steps only; action/type is ambiguous here.',
          },
        ]);
      }
    }
  });

  it('requires a steps array', () => {
    const result = validateWireActionBatch({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        { path: '/steps', message: "Batch requires a 'steps' array." },
      ]);
    }
  });

  it.each([0, MAX_BATCH_STEPS + 1])('bounds steps to 1..%s (got %s)', (length) => {
    const result = validateWireActionBatch({
      steps: Array.from({ length }, () => ({ action: 'reload' })),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        { path: '/steps', message: `Batch requires 1..${MAX_BATCH_STEPS} steps; got ${length}.` },
      ]);
    }
  });

  it('prefixes per-step issues with the step index', () => {
    const result = validateWireActionBatch({
      steps: [{ action: 'reload' }, { action: 'click', target: { ref: 'nope' } }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The reload step is fine; the click step's ref violates REF_PATTERN,
      // and the inner path is prefixed with the step's position.
      expect(result.issues).toEqual([
        {
          path: '/steps/1/target/ref',
          message: expect.stringMatching(/^Expected string to match/),
        },
      ]);
    }
  });

  it('rejects an invalid observe value with a /observe issue', () => {
    const result = validateWireActionBatch({ steps: [{ action: 'reload' }], observe: 'always' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        { path: '/observe', message: "observe must be 'after' or 'none'." },
      ]);
    }
  });

  describe('delivered wait validation', () => {
    it('accepts a wait carrying every optional field', () => {
      const result = validateWireActionBatch({
        steps: [{ action: 'reload' }],
        wait: {
          until: 'selectorVisible',
          timeoutMs: 300000,
          pattern: '**/done',
          selector: '.spinner',
          count: 1,
        },
      });
      expect(result.ok).toBe(true);
    });

    it('rejects non-object and unknown-until waits', () => {
      for (const wait of ['load', 42, null, {}, { until: 'explode' }, { until: 7 }]) {
        const result = validateWireActionBatch({ steps: [{ action: 'reload' }], wait });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.issues).toEqual([
            { path: '/wait', message: 'Invalid delivered wait condition.' },
          ]);
        }
      }
    });

    it.each([
      ['non-integer', 1.5],
      ['negative', -1],
      ['over the 5 minute cap', 300001],
      ['non-numeric', '5000'],
    ])('rejects a %s timeoutMs', (_label, timeoutMs) => {
      const result = validateWireActionBatch({
        steps: [{ action: 'reload' }],
        wait: { until: 'load', timeoutMs },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues[0]).toEqual({
          path: '/wait',
          message: 'Invalid delivered wait condition.',
        });
      }
    });

    it('rejects non-string pattern and selector', () => {
      for (const wait of [
        { until: 'urlPattern', pattern: 5 },
        { until: 'selectorVisible', selector: { css: '.a' } },
      ]) {
        const result = validateWireActionBatch({ steps: [{ action: 'reload' }], wait });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.issues[0]?.path).toBe('/wait');
        }
      }
    });

    it('rejects a count below one or non-integer', () => {
      for (const count of [0, -2, 2.5, '3']) {
        const result = validateWireActionBatch({
          steps: [{ action: 'reload' }],
          wait: { until: 'minElements', count },
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.issues[0]?.path).toBe('/wait');
        }
      }
    });

    it('accepts boundary timeoutMs and count values', () => {
      const result = validateWireActionBatch({
        steps: [{ action: 'reload' }],
        wait: { until: 'minElements', timeoutMs: 0, count: 1 },
      });
      expect(result.ok).toBe(true);
    });
  });

  it('accumulates every envelope issue instead of failing on the first', () => {
    const result = validateWireActionBatch({
      action: 'click',
      steps: [],
      wait: 'load',
      observe: 'sometimes',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toEqual([
        '/steps',
        '/steps',
        '/wait',
        '/observe',
      ]);
    }
  });
});
