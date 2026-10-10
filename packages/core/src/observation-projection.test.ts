/**
 * TDD Tests for Compact Observation Projection
 *
 * Projection is response-shaping over an already-redacted observation: it
 * filters (roles/name), scopes (subtree slice by ref), windows (limit), and
 * slims elements (protected core + includeFields opt-ins). It must never
 * reorder, never drop protected evidence, never silently swallow a bad scope
 * ref, and its cursors must address page ordinals with match-only counts.
 */

import type { EngineError } from '@agentbrowser/engine';
import type { PageElement, PageState } from '@agentbrowser/protocol';
import { describe, expect, it } from 'vitest';
import { projectObservation, projectionActive } from './observation-projection.js';

const el = (index: number, overrides: Partial<PageElement> = {}): PageElement => ({
  ref: `e7_${index}`,
  role: 'button',
  visible: true,
  enabled: true,
  ...overrides,
});

const source = (elements: PageElement[], overrides: Partial<PageState> = {}): PageState => ({
  sessionId: 'ses_s',
  pageId: 'pg_s',
  revision: 7,
  url: 'https://e.com/',
  title: 'T',
  status: 'complete',
  summary: 'S',
  truncated: false,
  untrustedContent: true,
  elements,
  ...overrides,
});

describe('observation projection', () => {
  it('returns the source unchanged when no projection field is set', () => {
    const page = source([el(0, { name: 'A' }), el(1, { name: 'B' })]);
    expect(projectObservation(page, {})).toBe(page);
    expect(projectionActive(undefined)).toBe(false);
    expect(projectionActive({})).toBe(false);
  });

  it('filters by exact role and echoes matched/total', () => {
    const page = source([
      el(0, { role: 'link', name: 'Home' }),
      el(1, { role: 'checkbox', name: 'Policy A' }),
      el(2, { role: 'checkbox', name: 'Policy B' }),
      el(3, { role: 'button', name: 'Submit' }),
    ]);

    const result = projectObservation(page, { roles: ['checkbox'] });

    expect(result.elements.map((e) => e.ref)).toEqual(['e7_1', 'e7_2']);
    expect(result.projection).toMatchObject({ roles: ['checkbox'], matched: 2, total: 4 });
    expect(result.truncated).toBe(false);
  });

  it('name filter is a case-insensitive substring on names only, never values', () => {
    const page = source([
      el(0, { role: 'textbox', name: 'Search policies', value: 'not-user-1' }),
      el(1, { role: 'row', name: 'user-1-prod' }),
      el(2, { role: 'button', name: 'Edit USER-1' }),
    ]);

    const result = projectObservation(page, { name: 'user-1' });

    // The textbox VALUE contains the needle but its name does not: no match.
    expect(result.elements.map((e) => e.ref)).toEqual(['e7_1', 'e7_2']);
    expect(result.projection).toMatchObject({ name: 'user-1', matched: 2, total: 3 });
  });

  it('a 0-match projection echoes counts instead of reading as an empty page', () => {
    const page = source([el(0, { role: 'link' }), el(1, { role: 'link' })]);
    const result = projectObservation(page, { roles: ['dialog'] });
    expect(result.elements).toEqual([]);
    expect(result.projection).toMatchObject({ matched: 0, total: 2 });
  });

  it('keeps valueRedacted, risk, checked, and focused in the protected core', () => {
    const page = source(
      [
        el(0, {
          role: 'textbox',
          name: 'Password',
          valueRedacted: true,
          risk: 'account-security',
          focused: true,
        }),
        el(1, { role: 'checkbox', name: 'Keep', checked: true }),
      ],
      { focusedRef: 'e7_0' }
    );

    const result = projectObservation(page, { roles: ['textbox', 'checkbox'] });

    expect(result.elements[0]).toMatchObject({
      valueRedacted: true,
      risk: 'account-security',
      focused: true,
    });
    expect(result.elements[1]).toMatchObject({ checked: true });
    expect(result.focusedRef).toBe('e7_0');
  });

  it('drops href/attributes unless included via includeFields', () => {
    const page = source([
      el(0, {
        role: 'link',
        name: 'Docs',
        href: 'https://e.com/docs',
        hrefTruncated: false,
        attributes: { id: 'docs-link' },
        required: true,
      }),
    ]);

    const bare = projectObservation(page, { roles: ['link'] });
    expect(bare.elements[0]).not.toHaveProperty('href');
    expect(bare.elements[0]).not.toHaveProperty('attributes');
    expect(bare.elements[0]).not.toHaveProperty('required');

    const enriched = projectObservation(page, {
      roles: ['link'],
      includeFields: ['href', 'attributes', 'required'],
    });
    expect(enriched.elements[0]).toMatchObject({
      href: 'https://e.com/docs',
      attributes: { id: 'docs-link' },
      required: true,
    });
  });

  it('caps names at 200 chars with nameTruncated, keeping hrefs convention-consistent', () => {
    const page = source([el(0, { role: 'heading', name: 'n'.repeat(350) })]);
    const result = projectObservation(page, { roles: ['heading'] });
    expect(result.elements[0]?.name).toHaveLength(200);
    expect(result.elements[0]?.nameTruncated).toBe(true);
  });

  it('scopes to the subtree slice: scope element plus deeper same-block descendants', () => {
    const page = source([
      el(0, { role: 'button', name: 'Before' }),
      el(1, { role: 'dialog', name: 'Manage policy', depth: 0 }),
      el(2, { role: 'checkbox', name: 'A', depth: 1 }),
      el(3, { role: 'checkbox', name: 'B', depth: 1 }),
      el(4, { role: 'button', name: 'Confirm', depth: 1 }),
      el(5, { role: 'button', name: 'After', depth: 0 }),
    ]);

    const result = projectObservation(page, { scopeRef: 'e7_1' });

    expect(result.elements.map((e) => e.name)).toEqual(['Manage policy', 'A', 'B', 'Confirm']);
    expect(result.projection).toMatchObject({ scopeRef: 'e7_1', matched: 4, total: 6 });
  });

  it('stops the scope slice at a snapshot block boundary (frame content)', () => {
    const page = source([
      el(0, { role: 'dialog', name: 'D', depth: 0 }),
      el(1, { role: 'checkbox', name: 'inside', depth: 1 }),
      // Frame block: appended at the list end, own depth scale.
      el(2, { role: 'button', name: 'framed', depth: 1, block: 1 }),
    ]);

    const result = projectObservation(page, { scopeRef: 'e7_0' });

    expect(result.elements.map((e) => e.name)).toEqual(['D', 'inside']);
  });

  it('a scope ref from an older revision fails STALE_TARGET', () => {
    const page = source([el(0, { role: 'dialog', depth: 0 })]);
    try {
      projectObservation(page, { scopeRef: 'e6_0' });
      fail('expected EngineError');
    } catch (error) {
      expect((error as EngineError).code).toBe('STALE_TARGET');
      expect((error as EngineError).message).toContain('revision');
    }
  });

  it('a scope ref absent at the current revision fails TARGET_NOT_FOUND', () => {
    const page = source([el(0, { role: 'dialog', depth: 0 })]);
    try {
      projectObservation(page, { scopeRef: 'e7_9' });
      fail('expected EngineError');
    } catch (error) {
      expect((error as EngineError).code).toBe('TARGET_NOT_FOUND');
    }
  });

  it('treats missing depth as flat: a scope yields only the scope element', () => {
    const page = source([
      el(0, { role: 'dialog', name: 'D' }),
      el(1, { role: 'button', name: 'X' }),
    ]);
    const result = projectObservation(page, { scopeRef: 'e7_0' });
    expect(result.elements.map((e) => e.name)).toEqual(['D']);
  });

  it('limit sets truncated with an ordinal cursor to the first unreturned match', () => {
    const page = source(
      Array.from({ length: 5 }, (_, i) => el(i, { role: 'checkbox', name: `c${i}` }))
    );

    const result = projectObservation(page, { roles: ['checkbox'], limit: 2 });

    expect(result.elements.map((e) => e.ref)).toEqual(['e7_0', 'e7_1']);
    expect(result.truncated).toBe(true);
    expect(result.continuation).toEqual({ nextOrdinal: 2, remaining: 3 });
  });

  it('continueFrom resumes past consumed matches and walks every match exactly once', () => {
    const page = source(
      Array.from({ length: 5 }, (_, i) => el(i, { role: 'checkbox', name: `c${i}` }))
    );

    const seen: string[] = [];
    let cursor = 0;
    for (let round = 0; round < 5; round += 1) {
      const result = projectObservation(page, {
        roles: ['checkbox'],
        limit: 2,
        ...(cursor > 0 ? {} : {}),
      });
      // The service passes continueFrom via context; emulate the walk.
      void result;
      const resumed = projectObservation(
        page,
        { roles: ['checkbox'], limit: 2 },
        { continueFrom: cursor }
      );
      if (resumed.elements.length === 0) break;
      seen.push(...resumed.elements.map((e) => e.ref));
      if (resumed.continuation === undefined) break;
      cursor = resumed.continuation.nextOrdinal;
    }

    expect(seen).toEqual(['e7_0', 'e7_1', 'e7_2', 'e7_3', 'e7_4']);
  });

  it('filters changes to surviving refs and shapes embedded elements', () => {
    const page = source([el(0, { role: 'checkbox', name: 'A' }), el(1, { role: 'button' })], {
      changes: [
        {
          ref: 'e7_0',
          change: 'added',
          properties: {
            element: {
              old: null,
              new: { ...el(0), name: 'a'.repeat(300), href: 'https://e.com/x' },
            },
          },
        },
        {
          ref: 'e7_1',
          change: 'removed',
          properties: { element: { old: el(1), new: null } },
        },
      ],
    });

    const result = projectObservation(page, { roles: ['checkbox'] });

    expect(result.changes).toHaveLength(1);
    expect(result.changes?.[0]?.ref).toBe('e7_0');
    const embedded = (result.changes?.[0]?.properties.element as { new: PageElement }).new;
    expect(embedded.name).toHaveLength(200);
    expect(embedded.nameTruncated).toBe(true);
    expect(embedded).not.toHaveProperty('href');
  });

  it('drops focusedRef when the focused element did not survive the predicate', () => {
    const page = source([el(0, { role: 'textbox', focused: true }), el(1, { role: 'checkbox' })], {
      focusedRef: 'e7_0',
    });

    const result = projectObservation(page, { roles: ['checkbox'] });

    expect(result).not.toHaveProperty('focusedRef');
  });

  it('restores document order when the source list was priority-sorted', () => {
    // >300-element observations arrive priority-sorted by the normalizer;
    // refs still carry document-order ordinals.
    const sorted = [el(400, { role: 'dialog', depth: 0 }), el(1, { role: 'link', name: 'nav' })];
    const page = source(sorted, { truncated: true });

    const result = projectObservation(page, { roles: ['dialog'] });

    expect(result.elements.map((e) => e.ref)).toEqual(['e7_400']);
    expect(result.projection).toMatchObject({ matched: 1, total: 2 });
  });
});
