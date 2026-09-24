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
