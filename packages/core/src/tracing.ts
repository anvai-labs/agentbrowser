/**
 * Tracing (TD-020)
 *
 * A minimal span tracer producing OpenTelemetry-shaped records: trace and
 * span ids, parent links, timing, attributes, events and error status.
 * Every exported span is scrubbed by the SecretManager so telemetry can
 * never become a secret exfiltration channel.
 */

import type { SecretManager } from './secret-manager.js';

export interface SpanContext {
  traceId: string;
  spanId: string;
}

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes: Record<string, unknown>;
}

export interface Span {
  name: string;
  traceId: string;
  spanId: string;
  parentId?: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
  status: 'ok' | 'error';
}

export interface TracerOptions {
  /** Scrub attributes and events of registered secrets before export. */
  secretManager?: SecretManager;
  /** Retained completed spans (default 1000). */
  maxSpans?: number;
  /** Called with each completed, redacted span. */
  onSpan?(span: Span): void;
}

const DEFAULT_MAX_SPANS = 1000;

/** Random hex id of the given length (W3C trace-id / span-id shaped). */
function hexId(length: number): string {
  let id = '';
  for (let i = 0; i < length; i++) {
    id += Math.floor(Math.random() * 16).toString(16);
  }
  return id;
}

export class InMemoryTracer {
  private readonly spans: Span[] = [];
  private readonly secretManager: SecretManager | undefined;
  private readonly maxSpans: number;
  private readonly onSpan: ((span: Span) => void) | undefined;

  constructor(options: TracerOptions = {}) {
    this.secretManager = options.secretManager;
    this.maxSpans = options.maxSpans ?? DEFAULT_MAX_SPANS;
    this.onSpan = options.onSpan;
  }

  /**
   * Start a span, optionally as a child of another span or of an upstream
   * context (e.g. a propagated traceparent).
   */
  startSpan(
    name: string,
    attributes: Record<string, unknown> = {},
    parent?: Span | SpanContext
  ): Span {
    return {
      name,
      traceId: parent?.traceId ?? hexId(32),
      spanId: hexId(16),
      ...(parent !== undefined ? { parentId: parent.spanId } : {}),
      startTime: Date.now(),
      attributes,
      events: [],
      status: 'ok',
    };
  }

  endSpan(span: Span, attributes: Record<string, unknown> = {}): void {
    span.endTime = Date.now();
    Object.assign(span.attributes, attributes);

    this.spans.push(this.scrub(span));
    while (this.spans.length > this.maxSpans) {
      this.spans.shift();
    }
    this.onSpan?.(this.spans[this.spans.length - 1] as Span);
  }

  addEvent(span: Span, name: string, attributes: Record<string, unknown> = {}): void {
    span.events.push({ name, timestamp: Date.now(), attributes: { ...attributes } });
  }

  /** Record a failure outcome on a span; end it separately. */
  failSpan(span: Span, code: string, message: string): void {
    span.status = 'error';
    span.attributes.code = code;
    span.attributes.error = this.secretManager ? this.secretManager.redact(message) : message;
  }

  /** Completed, redacted spans in completion order. */
  completedSpans(): readonly Span[] {
    return this.spans;
  }

  private scrub(span: Span): Span {
    if (!this.secretManager) {
      return span;
    }
    return {
      ...span,
      attributes: this.secretManager.redact(span.attributes),
      events: span.events.map((event) => ({
        ...event,
        attributes: this.secretManager
          ? this.secretManager.redact(event.attributes)
          : event.attributes,
      })),
    };
  }
}
