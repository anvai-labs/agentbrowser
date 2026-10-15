import { type Static, Type } from '@sinclair/typebox';

/** Lowest accepted replay cursor: -1 means "from the start of the ledger". */
export const EVENT_REPLAY_MIN_SINCE = -1;

/**
 * Event replay envelope (GET /v1/sessions/{sessionId}/events/replay). One
 * definition for the service, OpenAPI and the SDK (ADR-015).
 */
export const SessionEventsPageSchema = Type.Object({
  events: Type.Array(Type.Unsafe<Record<string, unknown>>({ type: 'object' })),
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
