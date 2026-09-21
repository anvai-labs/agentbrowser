/**
 * TDD Tests for Observation Budgeting
 *
 * The budgeter owns the final UTF-8 envelope of an observation: element
 * windowing with a continuation cursor that addresses the COMPLETE element
 * list, and byte-level degradation (drop changes, then text, then trailing
 * elements, then the summary) that must never exceed the caller's maxBytes
 * nor return a non-advancing cursor.
 */

import { EngineError } from '@agentbrowser/engine';
import type { ElementChange, PageElement, PageState } from '@agentbrowser/protocol';
import { describe, expect, it } from 'vitest';
import { budgetObservation } from './observation-budget.js';

const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

const el = (index: number, nameLength = 0): PageElement => ({
  ref: `e7_${index}`,
  role: 'button',
  ...(nameLength > 0 ? { name: 'x'.repeat(nameLength) } : {}),
  visible: true,
  enabled: true,
});

const change = (ref: string): ElementChange => ({
  ref,
  change: 'modified',
  properties: { name: { old: 'a', new: 'b' } },
});

const identity = {
  sessionId: 'ses_s',
  pageId: 'pg_s',
  revision: 7,
  url: 'https://e.com/',
  title: 'T',
  status: 'complete',
} as const;

const source = (overrides: Partial<PageState> & { elements: PageElement[] }): PageState => ({
  ...identity,
  summary: 'S',
  truncated: false,
  untrustedContent: true,
  ...overrides,
});

describe('observation budgeting', () => {
  describe('request validation', () => {
    it('rejects a non-positive or non-integer maxElements', () => {
      for (const maxElements of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => budgetObservation(source({ elements: [] }), { maxElements })).toThrowError(
          EngineError
        );
        try {
          budgetObservation(source({ elements: [] }), { maxElements });
          fail('expected EngineError');
        } catch (error) {
          expect((error as EngineError).code).toBe('INVALID_REQUEST');
          expect((error as EngineError).message).toBe(
            'Invalid maxElements: expected a positive safe integer.'
          );
        }
      }
    });

    it('rejects a non-positive or non-integer maxBytes', () => {
      expect(() => budgetObservation(source({ elements: [] }), { maxBytes: 0 })).toThrowError(
        'Invalid maxBytes: expected a positive safe integer.'
      );
      expect(() => budgetObservation(source({ elements: [] }), { maxBytes: 2.5 })).toThrowError(
        EngineError
      );
    });

    it('rejects a negative or non-integer continueFrom', () => {
      expect(() => budgetObservation(source({ elements: [] }), { continueFrom: -1 })).toThrowError(
        'Invalid continueFrom: expected a non-negative safe integer.'
      );
      expect(() => budgetObservation(source({ elements: [] }), { continueFrom: 0.5 })).toThrowError(
        'Invalid continueFrom: expected a non-negative safe integer.'
      );
    });

    it('rejects a continueFrom past the end of the element list', () => {
      expect(() =>
        budgetObservation(source({ elements: [el(0)] }), { continueFrom: 2 })
      ).toThrowError('continueFrom exceeds the element count');
    });
  });

  describe('element windowing', () => {
    it('defaults to a 300-element window when unbounded', () => {
      const elements = Array.from({ length: 305 }, (_, i) => el(i));
      const result = budgetObservation(source({ elements }));

      expect(result.elements).toHaveLength(300);
      expect(result.elements[0]?.ref).toBe('e7_0');
      expect(result.elements[299]?.ref).toBe('e7_299');
      expect(result.truncated).toBe(true);
      expect(result.continuation).toEqual({ nextOrdinal: 300, remaining: 5 });
    });

    it('returns the whole list without a cursor when nothing is dropped', () => {
      const result = budgetObservation(source({ elements: [el(0), el(1)] }));

      expect(result.elements).toHaveLength(2);
      expect(result.truncated).toBe(false);
      expect(result.continuation).toBeUndefined();
    });

    it('windows by maxElements and reports the remainder', () => {
      const elements = Array.from({ length: 5 }, (_, i) => el(i));
      const result = budgetObservation(source({ elements }), { maxElements: 2 });

      expect(result.elements.map((e) => e.ref)).toEqual(['e7_0', 'e7_1']);
      expect(result.truncated).toBe(true);
      expect(result.continuation).toEqual({ nextOrdinal: 2, remaining: 3 });
    });

    it('addresses continueFrom against the complete element list, not a trimmed prefix', () => {
      const elements = Array.from({ length: 6 }, (_, i) => el(i));
      const seen: string[] = [];
      let cursor: number | undefined;

      // Walk the whole list through successive windows, as a consumer would.
      for (let round = 0; round < 10; round++) {
        const result = budgetObservation(source({ elements }), {
          maxElements: 2,
          continueFrom: cursor,
        });
        seen.push(...result.elements.map((e) => e.ref));
        cursor = result.continuation?.nextOrdinal;
        if (cursor === undefined) break;
      }

      expect(seen).toEqual(elements.map((e) => e.ref));
    });

    it('omits the cursor when a continueFrom window reaches the end', () => {
      const elements = Array.from({ length: 5 }, (_, i) => el(i));
      const result = budgetObservation(source({ elements }), {
        maxElements: 10,
        continueFrom: 5,
      });

      expect(result.elements).toEqual([]);
      expect(result.truncated).toBe(false);
      expect(result.continuation).toBeUndefined();
    });

    it('does not leak a stale continuation from the source observation', () => {
      const elements = Array.from({ length: 2 }, (_, i) => el(i));
      const stale = source({
        elements,
        truncated: true,
        continuation: { nextOrdinal: 999, remaining: 999 },
      });

      const result = budgetObservation(stale, { maxElements: 2 });

      expect(result.continuation).toBeUndefined();
    });
  });

  describe('array copying', () => {
    it('copies text and changes so callers cannot mutate the source', () => {
      const original = source({
        elements: [el(0)],
        text: ['paragraph one', 'paragraph two'],
        changes: [change('e7_0')],
      });
      const result = budgetObservation(original);

      result.text?.push('caller mutation');
      result.changes?.push(change('e7_9'));
      result.elements.pop();

      expect(original.text).toEqual(['paragraph one', 'paragraph two']);
      expect(original.changes).toHaveLength(1);
    });

    it('carries text and changes only when the source provides them', () => {
      const result = budgetObservation(source({ elements: [el(0)] }));

      expect(result.text).toBeUndefined();
      expect(result.changes).toBeUndefined();
    });
  });

  describe('byte budget', () => {
    it('returns the envelope untouched when it already fits maxBytes', () => {
      const elements = [el(0), el(1)];
      const fitting = source({ elements, text: ['T'], changes: [change('e7_0')] });
      const result = budgetObservation(fitting, { maxBytes: byteSize(fitting) });

      expect(result.elements).toHaveLength(2);
      expect(result.truncated).toBe(false);
      expect(result.text).toEqual(['T']);
    });

    it('pops changes before text and leaves elements intact when they fit after', () => {
      // One element: the element-popping loop cannot run, so the arithmetic
      // below is exact, not approximate.
      const elements = [el(0)];
      const full = source({
        elements,
        summary: 'S',
        text: ['T'],
        changes: [change('e7_0'), change('e7_1'), change('e7_2')],
      });
      const expected: PageState = {
        ...identity,
        summary: 'S',
        elements: [el(0)],
        text: ['T'],
        changes: [],
        truncated: true,
        untrustedContent: true,
      };

      // Dropping exactly the three changes lands the envelope on its exact
      // byte limit: the popper must stop there, keeping text and elements.
      const result = budgetObservation(full, { maxBytes: byteSize(expected) });

      expect(result).toEqual(expected);
      expect(byteSize(result)).toBeLessThanOrEqual(byteSize(expected));
    });

    it('pops changes, then text, then elements down to one, then the summary', () => {
      const LONG = 500; // Long names keep every element pop far above the cursor/empty-array noise.
      const elements = [el(0, LONG), el(1, LONG), el(2, LONG)];
      const full = source({
        elements,
        summary: 'S'.repeat(40),
        text: ['T'],
        changes: [change('e7_2')],
      });

      // The smallest envelope that can still be returned: one element, no
      // prose, with the emptied arrays and the advancing cursor still present.
      const minimal: PageState = {
        ...identity,
        elements: [el(0, LONG)],
        text: [],
        changes: [],
        truncated: true,
        untrustedContent: true,
        continuation: { nextOrdinal: 1, remaining: 2 },
      };

      const result = budgetObservation(full, { maxBytes: byteSize(minimal) + 10 });

      expect(result).toEqual(minimal);
      expect(byteSize(result)).toBeLessThanOrEqual(byteSize(minimal) + 10);
    });

    it('throws OUTPUT_TRUNCATED when identity and one element cannot fit', () => {
      const huge = source({ elements: [el(0, 2000)], summary: 'S' });

      try {
        budgetObservation(huge, { maxBytes: 300 });
        fail('expected OUTPUT_TRUNCATED');
      } catch (error) {
        expect(error).toBeInstanceOf(EngineError);
        const engineError = error as EngineError;
        expect(engineError.code).toBe('OUTPUT_TRUNCATED');
        expect(engineError.message).toContain('increase maxBytes');
        expect(engineError.retryable).toBe(false);
        expect(engineError.details?.maxBytes).toBe(300);
        expect(engineError.details?.minBytes).toBeGreaterThan(300);
      }
    });
  });
});
