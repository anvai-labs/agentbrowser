import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
export const ScopeBudgetTopupSchema = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 0 }),
    requestBudget: Type.Integer({ minimum: 1, maximum: 10000000 }),
  },
  { additionalProperties: false }
);
export type ScopeBudgetTopup = Static<typeof ScopeBudgetTopupSchema>;
export function parseScopeBudgetTopup(input: unknown): ScopeBudgetTopup {
  if (!Value.Check(ScopeBudgetTopupSchema, input)) throw new Error('Invalid scope budget top-up');
  return input;
}
export const ScopeTrafficSummarySchema = Type.Object(
  {
    rows: Type.Array(
      Type.Object(
        {
          method: Type.String({ minLength: 1, maxLength: 32, pattern: '^[A-Z][A-Z0-9-]*$' }),
          hostClass: Type.Union([
            Type.Literal('program'),
            Type.Literal('asset'),
            Type.Literal('resource'),
            Type.Literal('other'),
          ]),
          requests: Type.Integer({ minimum: 0 }),
          denied: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 128 }
    ),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false }
);
export type ScopeTrafficSummary = Static<typeof ScopeTrafficSummarySchema>;
