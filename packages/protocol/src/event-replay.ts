import { type Static, Type } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import type { Validated } from './validators.js';

/** Lowest accepted replay cursor: -1 means "from the start of the ledger". */
export const EVENT_REPLAY_MIN_SINCE = -1;
export const EVENT_REPLAY_MAX_LIMIT = 1000;
export const EVENT_REPLAY_MAX_PATTERN_BYTES = 256;
export const EVENT_REPLAY_MAX_RESPONSE_BYTES = 256 * 1024;

export const EventReplaySelectorSchema = Type.Object(
  {
    type: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    since: Type.Optional(Type.Integer({ minimum: EVENT_REPLAY_MIN_SINCE })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: EVENT_REPLAY_MAX_LIMIT })),
    stream: Type.Optional(Type.Union([Type.Literal('request'), Type.Literal('other')])),
    urlRegex: Type.Optional(Type.String({ maxLength: EVENT_REPLAY_MAX_PATTERN_BYTES })),
    method: Type.Optional(
      Type.String({ minLength: 1, maxLength: 32, pattern: "^[!#$%&'*+.^_`|~0-9A-Z-]+$" })
    ),
    statusClass: Type.Optional(
      Type.Union([
        Type.Literal('2xx'),
        Type.Literal('4xx'),
        Type.Literal('5xx'),
        Type.Literal('denied'),
      ])
    ),
    failedOnly: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);
export type EventReplaySelector = Static<typeof EventReplaySelectorSchema>;

const selectorCheck = TypeCompiler.Compile(EventReplaySelectorSchema);
const selectorKeys = new Set(Object.keys(EventReplaySelectorSchema.properties));
const requestKeys = ['urlRegex', 'method', 'statusClass', 'failedOnly'] as const;
const newKeys = ['stream', ...requestKeys] as const;
const invalid = (): Validated<never> => ({
  ok: false,
  issues: [{ path: '', message: 'Invalid event replay selector.' }],
});

function detachedFields(input: unknown): Record<string, unknown> | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  try {
    const keys = Reflect.ownKeys(input);
    if (keys.length > selectorKeys.size) return undefined;
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== 'string' || !selectorKeys.has(key)) return undefined;
      const field = Object.getOwnPropertyDescriptor(input, key);
      if (!field || !Object.hasOwn(field, 'value')) return undefined;
      if (field.value !== undefined) output[key] = field.value;
    }
    return output;
  } catch {
    return undefined;
  }
}

/** New selectors use one bounded ledger page, even when a boolean is false. */
export function isFilteredEventReplay(selector: EventReplaySelector): boolean {
  return newKeys.some((key) => Object.hasOwn(selector, key));
}

export function eventReplayStream(selector: EventReplaySelector): 'request' | 'other' | undefined {
  if (selector.stream !== undefined) return selector.stream;
  if (selector.type !== undefined)
    return selector.type.startsWith('request.') || selector.type.startsWith('scope.')
      ? 'request'
      : 'other';
  return requestKeys.some((key) => Object.hasOwn(selector, key)) ? 'request' : undefined;
}

/** Structural/semantic validation only; compile patterns after owner admission. */
export function validateEventReplaySelector(input: unknown): Validated<EventReplaySelector> {
  const fields = detachedFields(input);
  if (!fields || !selectorCheck.Check(fields)) return invalid();
  const selector = fields as EventReplaySelector;
  if (
    (selector.since !== undefined && !Number.isSafeInteger(selector.since)) ||
    (selector.limit !== undefined && !Number.isSafeInteger(selector.limit)) ||
    (selector.urlRegex !== undefined &&
      new TextEncoder().encode(selector.urlRegex).byteLength > EVENT_REPLAY_MAX_PATTERN_BYTES)
  )
    return invalid();
  const stream = eventReplayStream(selector);
  const requestFilter = requestKeys.some((key) => Object.hasOwn(selector, key));
  const typeStream =
    selector.type === undefined
      ? undefined
      : selector.type.startsWith('request.') || selector.type.startsWith('scope.')
        ? 'request'
        : 'other';
  if (
    (requestFilter && stream !== 'request') ||
    (selector.stream !== undefined && typeStream !== undefined && typeStream !== selector.stream) ||
    ((selector.since !== undefined || selector.limit !== undefined) && stream === undefined)
  )
    return invalid();
  return { ok: true, value: Object.freeze(selector) };
}

/** Query arrays (duplicate fields), coercions and noncanonical numbers refuse. */
export function decodeEventReplayQuery(input: unknown): Validated<EventReplaySelector> {
  const fields = detachedFields(input);
  if (!fields) return invalid();
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== 'string') return invalid();
    if (key === 'since' || key === 'limit') {
      if (!/^(?:-1|0|[1-9][0-9]*)$/.test(value)) return invalid();
      decoded[key] = Number(value);
    } else if (key === 'failedOnly') {
      if (value !== 'true' && value !== 'false') return invalid();
      decoded[key] = value === 'true';
    } else decoded[key] = value;
  }
  return validateEventReplaySelector(decoded);
}

/** Acknowledgment prevents new clients silently accepting old servers' unfiltered data. */
export const EventReplayFilterReceiptSchema = Type.Object(
  {
    version: Type.Literal(1),
    stream: Type.Union([Type.Literal('request'), Type.Literal('other')]),
  },
  { additionalProperties: false }
);
export type EventReplayFilterReceipt = Static<typeof EventReplayFilterReceiptSchema>;
const receiptCheck = TypeCompiler.Compile(EventReplayFilterReceiptSchema);

export function validateEventReplayFilterReceipt(
  input: unknown
): Validated<EventReplayFilterReceipt> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return invalid();
  try {
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 2 || !keys.includes('version') || !keys.includes('stream'))
      return invalid();
    const version = Object.getOwnPropertyDescriptor(input, 'version');
    const stream = Object.getOwnPropertyDescriptor(input, 'stream');
    if (!version || !stream || !Object.hasOwn(version, 'value') || !Object.hasOwn(stream, 'value'))
      return invalid();
    const receipt = { version: version.value, stream: stream.value };
    if (!receiptCheck.Check(receipt)) return invalid();
    return { ok: true, value: Object.freeze(receipt) };
  } catch {
    return invalid();
  }
}

/**
 * Event replay envelope (GET /v1/sessions/{sessionId}/events/replay). One
 * definition for the service, OpenAPI and the SDK (ADR-015).
 */
export const SessionEventsPageSchema = Type.Object({
  events: Type.Array(Type.Unsafe<Record<string, unknown>>({ type: 'object' })),
  filter: Type.Optional(EventReplayFilterReceiptSchema),
  nextCursor: Type.Integer({
    minimum: EVENT_REPLAY_MIN_SINCE,
    description:
      'Cursor for the next page (-1 = from the start); advances past entries of other types.',
  }),
  oldestSeq: Type.Optional(
    Type.Integer({
      minimum: 0,
      description:
        'Paged responses: the lowest retained ledger sequence (the next sequence to be written when the ledger is empty).',
    })
  ),
  gap: Type.Optional(
    Type.Boolean({
      description:
        'Paged responses with since: true when entries after the cursor were evicted before this read.',
    })
  ),
});
export type SessionEventsPage = Static<typeof SessionEventsPageSchema>;
