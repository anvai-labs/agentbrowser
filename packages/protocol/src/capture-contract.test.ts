import { TypeCompiler } from '@sinclair/typebox/compiler';
import { describe, expect, it } from 'vitest';
import { ObservationRequestSchema, ScreenshotRequestSchema } from './schemas.js';
import { validateObservationRequest, validateScreenshotRequest } from './validators.js';

const invalidWaits = [
  null,
  {},
  { until: 'bogus' },
  { until: 'minElements' },
  { until: 'selectorVisible' },
  { until: 'urlPattern' },
  { until: 'minElements', count: 1.5 },
  { until: 'minElements', count: 0 },
  { until: 'minElements', count: 10001 },
  { until: 'load', timeoutMs: -1 },
  { until: 'load', timeoutMs: 300001 },
  { until: 'load', timeoutMs: Number.NaN },
  { until: 'selectorVisible', selector: '' },
  { until: 'selectorVisible', selector: 'x'.repeat(501) },
  { until: 'urlPattern', pattern: 'x'.repeat(513) },
];

describe.each([
  ['observe', ObservationRequestSchema, validateObservationRequest],
  ['screenshot', ScreenshotRequestSchema, validateScreenshotRequest],
] as const)('%s capture contract', (_name, schema, validate) => {
  it.each(invalidWaits)('rejects invalid wait %j in schema and runtime', (wait) => {
    expect(TypeCompiler.Compile(schema).Check({ wait })).toBe(false);
    expect(validate({ wait }).ok).toBe(false);
  });
  it.each([
    { until: 'settled' },
    { until: 'load', timeoutMs: 0 },
    { until: 'domcontentloaded' },
    { until: 'networkidle', timeoutMs: 300000 },
    { until: 'minElements', count: 1 },
    { until: 'selectorVisible', selector: '#ready' },
    { until: 'urlPattern', pattern: 'https://example.com/**' },
  ])('preserves valid wait %j', (wait) => {
    expect(TypeCompiler.Compile(schema).Check({ wait })).toBe(true);
    expect(validate({ wait })).toEqual({ ok: true, value: { wait } });
  });
  it('rejects invalid URL regex before execution', () => {
    expect(validate({ wait: { until: 'urlPattern', pattern: '/[/' } }).ok).toBe(false);
  });
  it('rejects unknown options rather than silently dropping them', () => {
    expect(validate({ waitUntil: 'load' }).ok).toBe(false);
  });
});

describe('observe compact projection contract', () => {
  it.each([
    { name: 'x'.repeat(201) },
    { limit: 0 },
    { limit: 501 },
    { limit: 2.5 },
    { roles: [] },
    { roles: 'dialog' },
    { roles: [1] },
    { roles: ['x'.repeat(101)] },
    { roles: Array.from({ length: 33 }, () => 'button') },
    { scopeRef: 'not-a-ref' },
    { scopeRef: 'e1_x' },
    { includeFields: ['bounds'] },
    { includeFields: 'href' },
  ])('rejects invalid projection %j in schema and runtime', (body) => {
    expect(TypeCompiler.Compile(ObservationRequestSchema).Check(body)).toBe(false);
    expect(validateObservationRequest(body).ok).toBe(false);
  });

  it.each([
    { roles: ['dialog', 'checkbox'] },
    { name: 'user-1' },
    { scopeRef: 'e12_345' },
    { limit: 1 },
    { limit: 500 },
    { includeFields: ['href', 'attributes', 'required'] },
    {
      roles: ['dialog'],
      name: 'policy',
      scopeRef: 'e1_0',
      limit: 20,
      includeFields: ['href'],
    },
  ])('preserves valid projection %j', (body) => {
    const compiled = TypeCompiler.Compile(ObservationRequestSchema);
    expect(compiled.Check(body)).toBe(true);
    expect(validateObservationRequest(body)).toEqual({ ok: true, value: body });
  });
});
