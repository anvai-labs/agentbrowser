/**
 * TDD Tests for tracing (TD-020)
 *
 * Spans cover every service operation, children link to parents, and no
 * secret value ever reaches an exported span.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryTracer, SecretManager } from './index';

describe('InMemoryTracer', () => {
  it('should create spans with timing and ids', () => {
    const tracer = new InMemoryTracer();
    const span = tracer.startSpan('navigate');

    expect(span.name).toBe('navigate');
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);

    tracer.endSpan(span);
    expect(span.endTime).toBeGreaterThanOrEqual(span.startTime);
  });

  it('should link child spans to their parent', () => {
    const tracer = new InMemoryTracer();
    const parent = tracer.startSpan('navigate');
    const child = tracer.startSpan('policy.check', { url: 'https://example.com' }, parent);

    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentId).toBe(parent.spanId);

    tracer.endSpan(child);
    tracer.endSpan(parent);
  });

  it('should continue a trace from an upstream context', () => {
    const tracer = new InMemoryTracer();
    const upstream = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
    const span = tracer.startSpan('act', {}, upstream);

    expect(span.traceId).toBe(upstream.traceId);
    expect(span.parentId).toBe(upstream.spanId);
  });

  it('should record completed spans', () => {
    const tracer = new InMemoryTracer();
    const first = tracer.startSpan('a');
    tracer.endSpan(first);
    const second = tracer.startSpan('b');
    tracer.endSpan(second);

    const spans = tracer.completedSpans();
    expect(spans.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('should record events on a span', () => {
    const tracer = new InMemoryTracer();
    const span = tracer.startSpan('act');
    tracer.addEvent(span, 'approval.required', { effect: 'transaction' });
    tracer.endSpan(span, { outcome: 'denied' });

    const [recorded] = tracer.completedSpans();
    expect(recorded?.events[0]).toMatchObject({
      name: 'approval.required',
      attributes: { effect: 'transaction' },
    });
    expect(recorded?.attributes.outcome).toBe('denied');
  });

  it('should mark failed operations', () => {
    const tracer = new InMemoryTracer();
    const span = tracer.startSpan('navigate');
    tracer.failSpan(span, 'POLICY_DENIED', 'loopback blocked');
    tracer.endSpan(span);

    const [recorded] = tracer.completedSpans();
    expect(recorded?.status).toBe('error');
    expect(recorded?.attributes.code).toBe('POLICY_DENIED');
  });

  it('should export spans with secret values redacted', () => {
    const tracer = new InMemoryTracer({
      secretManager: new SecretManager({ 'vault://p': 'swordfish' }),
    });
    const span = tracer.startSpan('act', { value: 'swordfish', note: 'fill' });
    tracer.endSpan(span);

    const exported = JSON.stringify(tracer.completedSpans());
    expect(exported).not.toContain('swordfish');
    expect(exported).toContain('***');
  });

  it('should bound the retained span buffer', () => {
    const tracer = new InMemoryTracer({ maxSpans: 3 });
    for (let i = 0; i < 5; i++) {
      const span = tracer.startSpan(`op-${i}`);
      tracer.endSpan(span);
    }

    expect(tracer.completedSpans()).toHaveLength(3);
    expect(tracer.completedSpans()[0]?.name).toBe('op-2');
  });
});
