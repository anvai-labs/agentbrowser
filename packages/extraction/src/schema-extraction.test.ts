/**
 * TDD Tests for schema-constrained extraction (spec 12.2)
 *
 * extract.schema accepts a JSON Schema describing the shape the caller
 * wants. The default provider is deterministic (field-matching over the
 * page's own data - no model); a pluggable model adapter can be injected.
 * The contract: data validated against the schema, evidence with hashes,
 * warnings for missing/ambiguous fields, and modelUsed only when a model
 * actually ran. The browser service functions without an LLM.
 */

import type { RawPageState } from '@agentbrowser/engine';
import { describe, expect, it } from 'vitest';
import { SchemaExtractor } from './schema-extraction';

const PAGE: RawPageState = {
  url: 'https://shop.example.com/product/42',
  title: 'Widget Pro - Shop',
  status: 'complete',
  content: `
    <html><body>
      <h1>Widget Pro</h1>
      <span class="price">$29.99</span>
      <span class="sku">SKU-42</span>
      <table><tr><td>In stock: 17</td></tr></table>
    </body></html>`,
  elements: [
    { ref: 'e1_0', role: 'heading', name: 'Widget Pro', visible: true, enabled: true },
    { ref: 'e1_1', role: 'button', name: 'Add to cart', visible: true, enabled: true },
  ],
};

const PRODUCT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    price: { type: 'string' },
    sku: { type: 'string' },
  },
  required: ['title'],
} as const;

describe('SchemaExtractor (deterministic provider)', () => {
  it('should fill schema fields from the page with evidence', async () => {
    const extractor = new SchemaExtractor();
    const result = await extractor.extract(PAGE, PRODUCT_SCHEMA);

    expect(result.data).toMatchObject({
      title: 'Widget Pro',
      price: '$29.99',
      sku: 'SKU-42',
    });
    expect(result.evidence?.length).toBeGreaterThan(0);
    expect(result.evidence?.[0]).toMatchObject({
      url: PAGE.url,
      hash: expect.any(String),
    });
    // Deterministic provider: no model was invoked.
    expect(result.modelUsed).toBeUndefined();
  });

  it('should warn on missing fields instead of inventing them', async () => {
    const extractor = new SchemaExtractor();
    const result = await extractor.extract(PAGE, {
      type: 'object',
      properties: { nonexistent: { type: 'string' } },
      required: ['nonexistent'],
    });

    expect(result.data).toEqual({});
    expect(result.warnings?.some((w) => /nonexistent/.test(w))).toBe(true);
  });

  it('should validate output against the schema (required fields)', async () => {
    const extractor = new SchemaExtractor();
    const result = await extractor.extract(PAGE, {
      type: 'object',
      properties: {},
      required: ['never_present'],
    });

    // Required-but-missing is a warning plus an INVALID_REQUEST-shaped
    // failure the caller can act on, never fabricated data.
    expect(result.warnings?.some((w) => /never_present/.test(w))).toBe(true);
  });

  it('should redact registered secrets from extracted values', async () => {
    const { SecretManager } = await import('@agentbrowser/core');
    const extractor = new SchemaExtractor({
      secretManager: new SecretManager({ 'vault://p': 'hunter2' }),
    });
    const page: RawPageState = {
      ...PAGE,
      content: PAGE.content.replace('SKU-42', 'hunter2'),
    };

    const result = await extractor.extract(page, {
      type: 'object',
      properties: { sku: { type: 'string' } },
    });

    expect(JSON.stringify(result.data)).not.toContain('hunter2');
  });

  it('should support a pluggable model adapter (modelUsed recorded)', async () => {
    const extractor = new SchemaExtractor({
      model: {
        name: 'test-model',
        async extract(input) {
          // Answers a field deterministic matching cannot find.
          return { rating: `4.5 stars for ${input.title}` };
        },
      },
    });
    const result = await extractor.extract(PAGE, {
      ...PRODUCT_SCHEMA,
      properties: { ...PRODUCT_SCHEMA.properties, rating: { type: 'string' } },
    });

    expect(result.data).toMatchObject({ rating: '4.5 stars for Widget Pro - Shop' });
    // Deterministic fields still win; the model only fills the remainder.
    expect(result.data).toMatchObject({ price: '$29.99' });
    expect(result.modelUsed).toBe('test-model');
  });

  it('should produce identical output for identical input (determinism)', async () => {
    const extractor = new SchemaExtractor();
    const a = await extractor.extract(PAGE, PRODUCT_SCHEMA);
    const b = await extractor.extract(PAGE, PRODUCT_SCHEMA);

    expect(a.data).toEqual(b.data);
    expect(a.evidence?.[0]?.hash).toBe(b.evidence?.[0]?.hash);
  });
});
