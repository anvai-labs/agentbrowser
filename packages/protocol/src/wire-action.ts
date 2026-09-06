/** Canonical flat /act vocabulary. Surfaces validate here, not by assertion. */
import type { DeliveredWaitCondition, SelectAction, SupportedAction } from './types.js';
import { type Validated, validateAction, validatePlanStep } from './validators.js';

type Flat<A> = A extends { type: infer T } ? Omit<A, 'type'> & { action: T } : never;
type Delivered =
  | Exclude<SupportedAction, { type: 'navigate' | 'wait' }>
  | { type: 'wait'; condition: DeliveredWaitCondition };
export type WireActionRequest = (
  | Flat<Delivered>
  // Compatibility with the original single-value select wire API.
  | (Omit<Flat<SelectAction>, 'values'> & { value: string; values?: never })
) & {
  observe?: 'after' | 'none';
  expectedRevision?: number;
  approvalToken?: string;
  wait?: DeliveredWaitCondition;
};

/** Translate only action fields; plan orchestration and consent stay outside engines. */
export function decodeWireAction(body: unknown): Validated<SupportedAction> {
  const envelope = validatePlanStep(body);
  if (!envelope.ok) return envelope;
  if ('type' in envelope.value) {
    return {
      ok: false,
      issues: [{ path: '/type', message: 'Wire actions use action, not type.' }],
    };
  }
  const {
    action,
    observe,
    expectedRevision,
    approvalToken,
    wait,
    waitForLabel,
    waitMs,
    ...fields
  } = envelope.value;
  if (action === 'select' && fields.values === undefined && typeof fields.value === 'string') {
    const { value, ...rest } = fields;
    return validateAction({ ...rest, values: [value], type: action });
  }
  return validateAction({ ...fields, type: action });
}

export function validateWireAction(body: unknown): Validated<WireActionRequest> {
  const result = decodeWireAction(body);
  return result.ok ? { ok: true, value: body as WireActionRequest } : result;
}
