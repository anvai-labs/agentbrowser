import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { SCOPE_DENIAL_CODES } from './navigation-failure.js';
export const ScopeTraceModeSchema = Type.Union([Type.Literal('denials'), Type.Literal('off')]);
export const ScopeDenialDetailSchema = Type.Object(
  {
    scope: Type.Union(SCOPE_DENIAL_CODES.map((code) => Type.Literal(code))),
    method: Type.String({ minLength: 1, maxLength: 32, pattern: '^(?:[A-Z][A-Z0-9-]{0,31}|\\?)$' }),
    url: Type.String({ maxLength: 2048, pattern: '^https?://[^\\s\\x00-\\x1f]*$' }),
    hostname: Type.String({ maxLength: 253, pattern: '^[^\\x00-\\x1f\\x7f]*$' }),
  },
  { additionalProperties: false }
);
export type ScopeDenialDetail = Static<typeof ScopeDenialDetailSchema>;
export const ScopeTraceEventSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal('scope.denied'),
      timestamp: Type.String({ maxLength: 64, pattern: '^[^\\x00-\\x1f\\x7f]*$' }),
      sessionId: Type.String({ maxLength: 128, pattern: '^[^\\x00-\\x1f\\x7f]*$' }),
      pageId: Type.Optional(Type.String({ maxLength: 128, pattern: '^[^\\x00-\\x1f\\x7f]*$' })),
      data: ScopeDenialDetailSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      type: Type.Literal('scope.dependency-starved'),
      timestamp: Type.String({ maxLength: 64, pattern: '^[^\\x00-\\x1f\\x7f]*$' }),
      sessionId: Type.String({ maxLength: 128, pattern: '^[^\\x00-\\x1f\\x7f]*$' }),
      pageId: Type.Optional(Type.String({ maxLength: 128, pattern: '^[^\\x00-\\x1f\\x7f]*$' })),
      data: Type.Object(
        {
          hostname: Type.String({ maxLength: 253, pattern: '^[^\\x00-\\x1f\\x7f]*$' }),
          count: Type.Integer({ minimum: 3 }),
          message: Type.String({ maxLength: 512, pattern: '^[^\\x00-\\x1f\\x7f]*$' }),
        },
        { additionalProperties: false }
      ),
    },
    { additionalProperties: false }
  ),
]);
export type ScopeTraceEvent = Static<typeof ScopeTraceEventSchema>;
export function parseScopeTraceEvent(value: unknown): ScopeTraceEvent {
  if (!Value.Check(ScopeTraceEventSchema, value)) throw new Error('Invalid scope trace event');
  return value;
}

export const ScopeTraceEndSchema = Type.Object(
  {
    reason: Type.Union(
      (['session-ended', 'server-shutdown', 'revoked', 'backpressure'] as const).map((value) =>
        Type.Literal(value)
      )
    ),
  },
  { additionalProperties: false }
);
export type ScopeTraceEnd = Static<typeof ScopeTraceEndSchema>;
export function parseScopeTraceEnd(value: unknown): ScopeTraceEnd {
  if (!Value.Check(ScopeTraceEndSchema, value)) throw new Error('Invalid scope trace completion');
  return value;
}
