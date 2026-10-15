import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { snapshotJsonData, type Validated } from './validators.js';

export const OperatorApprovalDecisionSchema = Type.Object(
  {
    decision: Type.Union([Type.Literal('approve'), Type.Literal('deny')]),
    /**
     * TD-BROWSER-16 phase 6 (ADR-025 §5): a cookie.handoff approval may carry
     * an action lease, applied when the handoff marks the session. Operator
     * input only; validated against the session's allowlist at apply time.
     */
    lease: Type.Optional(
      Type.Object(
        {
          hosts: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 16 }),
          expiresInMs: Type.Integer({ minimum: 1 }),
          maxActions: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false }
      )
    ),
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
    /**
     * TD-BROWSER-16: reviewed act approvals carry their kind, so the operator
     * surface tells an act.reviewed decision from a plain act token; absent
     * on legacy reviewed tokens minted before the kind was stamped.
     */
    kind: Type.Optional(Type.Union([Type.Literal('act.reviewed'), Type.Literal('cookie.handoff')])),
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
    // Bounds cover the optional lease (hosts 1-16 + two integers): a
    // deeper/larger body is refused as malformed before the schema check.
    const decision = snapshotJsonData(input, { maxDepth: 4, maxNodes: 24, maxBytes: 1024 });
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
