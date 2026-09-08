/**
 * TDD Tests for records extraction (TD-BROWSER-12)
 *
 * `records` is the repeating-structure counterpart to `schema`: a container
 * CSS selector plus per-field CSS selectors, evaluated over the DOM, yield
 * JSON records with shared, hash-auditable evidence. Pure function, no
 * model calls.
 */

import type { RawPageState } from '@agentbrowser/engine';
import { describe, expect, it } from 'vitest';
import { extractRecords } from './records-extraction';

const CARDS: RawPageState = {
  url: 'https://jobs.example.com/search',
  title: 'Results',
  status: 'complete',
  content: `
    <html><body>
      <ul id="results">
        <li class="card"><h2><a href="/j/1">Engineer I</a></h2><div class="co">Acme Corp</div><div class="loc">Remote</div></li>
        <li class="card"><h2><a href="/j/2">Engineer II</a></h2><div class="co">Barnes &amp; Noble</div><div class="loc">NYC</div></li>
        <li class="card"><h2><a href="/j/3">Engineer III</a></h2><div class="co">Coyote</div></li>
      </ul>
    </body></html>
  `,
  elements: [],
  metadata: { revision: 7 },
};

describe('extractRecords (TD-BROWSER-12)', () => {
  it('returns one record per container with each field resolved', () => {
    const result = extractRecords(CARDS, {
      container: 'li.card',
      fields: { title: 'h2', company: '.co', location: '.loc' },
    });
    expect(result.data).toEqual([
      { title: 'Engineer I', company: 'Acme Corp', location: 'Remote' },
      { title: 'Engineer II', company: 'Barnes & Noble', location: 'NYC' },
      { title: 'Engineer III', company: 'Coyote', location: '' },
    ]);
  });

  it('reads text through nested elements, not tag-stripped regexes', () => {
    const result = extractRecords(CARDS, {
      container: 'li.card',
      fields: { title: 'h2 a' },
    });
    expect(result.data).toEqual([
      { title: 'Engineer I' },
      { title: 'Engineer II' },
      { title: 'Engineer III' },
    ]);
  });

  it('honors an optional limit', () => {
    const result = extractRecords(CARDS, {
      container: 'li.card',
      fields: { title: 'h2' },
      limit: 2,
    });
    expect(result.data).toHaveLength(2);
  });

  it('returns no records and a warning when the container matches nothing', () => {
    const result = extractRecords(CARDS, {
      container: 'div.nothing',
      fields: { title: 'h2' },
    });
    expect(result.data).toEqual([]);
    expect(result.warnings).toEqual(['no records found']);
  });

  it('carries shared hash evidence with a per-record index', () => {
    const result = extractRecords(CARDS, {
      container: 'li.card',
      fields: { title: 'h2' },
    });
    const evidence = result.evidence ?? [];
    expect(evidence).toHaveLength(3);
    expect(evidence[0]).toMatchObject({
      url: CARDS.url,
      revision: 7,
      index: 0,
    });
    const hashes = new Set(evidence.map((e) => e.hash));
    expect(hashes.size).toBe(1);
    expect(evidence.map((e) => e.index)).toEqual([0, 1, 2]);
  });

  it('is deterministic: identical page state yields identical bytes', () => {
    const request = { container: 'li.card', fields: { title: 'h2', company: '.co' } };
    const first = extractRecords(CARDS, request);
    const second = extractRecords(CARDS, request);
    expect(first).toEqual(second);
  });
});
