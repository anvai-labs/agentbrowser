import type { PageState } from '@agentbrowser/protocol';
import { describe, expect, it } from 'vitest';
import { ApprovalGate } from './approval-gate.js';
import { JsonLedger } from './json-ledger.js';
import { budgetObservation } from './observation-budget.js';

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
// Euro is 3 UTF-8 bytes / 1 UTF-16 unit; the smile symbol is 4 bytes / 2 units.
// Escapes keep fixtures readable while testing both forms of byte-count drift.
const observation = (): PageState => ({
  sessionId: 'ses_local',
  pageId: 'pg_local',
  revision: 1,
  url: 'https://example.com/',
  title: 'Test \u20AC',
  status: 'interactive',
  elements: Array.from({ length: 400 }, (_, index) => ({
    ref: `e1_${index}`,
    role: 'button',
    name: `Button \u20AC\u{1F642}${index}`,
    visible: true,
    enabled: true,
  })),
  truncated: false,
  untrustedContent: true,
});

describe('shared observation budgets', () => {
  it('accounts exactly for UTF-8 and cursor overhead across budget boundaries', () => {
    const source = observation();
    for (let budget = 450; budget <= 2400; budget += 7) {
      const result = budgetObservation(source, { maxBytes: budget });
      expect(size(result)).toBeLessThanOrEqual(budget);
      expect(result.continuation?.nextOrdinal).toBeGreaterThan(0);
      expect(result.continuation?.remaining).toBe(400 - result.elements.length);
    }
    expect(source.elements).toHaveLength(400);
  });

  it('continues beyond the default 300 and applies cursor without maxElements', () => {
    const source = observation();
    const first = budgetObservation(source);
    const second = budgetObservation(source, { continueFrom: first.continuation?.nextOrdinal });
    expect(first.elements).toHaveLength(300);
    expect(second.elements).toHaveLength(100);
    expect(second.elements[0]?.ref).toBe('e1_300');
    expect(second.continuation).toBeUndefined();
    expect(second.truncated).toBe(false);
  });

  it('bounds content and diffs without off-by-one paragraph restoration', () => {
    const source = observation();
    source.elements = [];
    source.text = Array.from({ length: 1000 }, () => 'Text \u20AC\u{1F642}'.repeat(20));
    source.changes = [
      {
        change: 'added',
        ref: 'e1_0',
        properties: { name: { old: undefined, new: 'Test \u20AC' } },
      },
    ];
    const result = budgetObservation(source, { maxBytes: 1000 });
    expect(size(result)).toBeLessThanOrEqual(1000);
    expect(result.truncated).toBe(true);
    expect(source.text).toHaveLength(1000);
  });

  it('fails explicitly when identity or the next element cannot fit', () => {
    expect(() => budgetObservation(observation(), { maxBytes: 1 })).toThrow(
      expect.objectContaining({ code: 'OUTPUT_TRUNCATED' })
    );
    expect(() => budgetObservation(observation(), { continueFrom: 401 })).toThrow(
      expect.objectContaining({ code: 'INVALID_REQUEST' })
    );
  });
});

describe('bounded retention and admission', () => {
  it('evicts oldest entries by bytes, drops oversized entries, and owns snapshots', () => {
    const ledger = new JsonLedger<{ text: string }>({
      maxEntries: 10,
      maxBytes: 100,
      maxEntryBytes: 60,
    });
    const item = { text: '\u20AC'.repeat(12) };
    expect(ledger.push(item)).toBe(true);
    item.text = 'mutated';
    expect(ledger.toArray()[0]?.text).not.toBe('mutated');
    ledger.push({ text: 'b'.repeat(40) });
    ledger.push({ text: 'c'.repeat(40) });
    expect(ledger.stats.bytes).toBeLessThanOrEqual(100);
    expect(ledger.stats.evicted).toBe(2);
    expect(ledger.push({ text: 'x'.repeat(100) })).toBe(false);
    expect(ledger.stats.dropped).toBe(1);
    const replay = ledger.toArray();
    if (replay[0]) replay[0].text = 'changed';
    expect(ledger.toArray()[0]?.text).toBe('c'.repeat(40));
  });

  it('never over-admits concurrent pending tokens and reclaims used capacity', async () => {
    const gate = new ApprovalGate({ maxTokens: 2 });
    const request = { sessionId: 's', action: { type: 'click' } };
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => gate.generateApprovalToken(request))
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
      expect(gate.getTokenCount()).toBe(2);
      const first = (await gate.getSessionTokens('s'))[0];
      if (!first) throw new Error('Missing token');
      await gate.useApprovalToken(first.tokenId);
      await expect(gate.generateApprovalToken(request)).resolves.toBeDefined();
      expect(gate.getTokenCount()).toBe(2);
    } finally {
      await gate.shutdown();
    }
  });
});
