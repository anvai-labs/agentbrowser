import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { type Validated, snapshotJsonData } from './validators.js';

export const OperatorApprovalDecisionSchema = Type.Object(
  {
    decision: Type.Union([Type.Literal('approve'), Type.Literal('deny')]),
  },
  { additionalProperties: false }
);
export const OperatorApprovalViewSchema = Type.Object(
  {
    tokenId: Type.String({ minLength: 1, maxLength: 128 }),
    status: Type.Union(
      (['pending', 'approved', 'denied', 'used', 'expired'] as const).map((value) =>
        Type.Literal(value)
      )
    ),
    createdAt: Type.Integer({ minimum: 0 }),
    expiresAt: Type.Integer({ minimum: 0 }),
    approvedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    action: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false }
);
export type OperatorApprovalView = Static<typeof OperatorApprovalViewSchema>;
export type OperatorApprovalDecision = Static<typeof OperatorApprovalDecisionSchema>;

export function validateOperatorApprovalDecision(
  input: unknown
): Validated<OperatorApprovalDecision> {
  try {
    const decision = snapshotJsonData(input, { maxDepth: 2, maxNodes: 4, maxBytes: 64 });
    if (Value.Check(OperatorApprovalDecisionSchema, decision)) return { ok: true, value: decision };
  } catch {
    /* Static diagnostics keep private input out of errors. */
  }
  return {
    ok: false,
    issues: [{ path: '/decision', message: 'Approval decision must be approve or deny' }],
  };
}

/** Private operator data: detached, bounded, and never echoed in validation failures. */
export function parseOperatorApprovalView(input: unknown): OperatorApprovalView {
  try {
    const view = snapshotJsonData(input, { maxDepth: 24, maxNodes: 8192, maxBytes: 128 * 1024 });
    if (!Value.Check(OperatorApprovalViewSchema, view)) throw new Error();
    snapshotJsonData(view.action, { maxDepth: 20, maxNodes: 4096, maxBytes: 64 * 1024 });
    const encode = (value: unknown) =>
      JSON.stringify(value, (_key, entry) => {
        if (entry === undefined || (typeof entry === 'number' && !Number.isFinite(entry)))
          throw new Error();
        return entry;
      });
    if (
      new TextEncoder().encode(encode(view)).byteLength > 128 * 1024 ||
      new TextEncoder().encode(encode(view.action)).byteLength > 64 * 1024
    )
      throw new Error();
    return view;
  } catch {
    throw new Error('Invalid operator approval view');
  }
}
