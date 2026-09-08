/** Canonical flat /act vocabulary. Surfaces validate here, not by assertion. */
import type { DeliveredWaitCondition, SelectAction, SupportedAction } from './types.js';
import { ACTION_TYPE_LITERALS } from './schemas.js';
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

/**
 * The engine-facing `type` key leaks into client code often enough that the
 * wire accepts it as a deprecated alias: only when `action` is absent and the
 * value is a real action literal. Both present still rejects — ambiguity in
 * an action envelope is never resolved silently.
 */
const TYPE_DEPRECATION_WARNING = "Field 'type' is deprecated; use 'action'.";

function translateDeprecatedType(body: unknown): { value: Record<string, unknown> } | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  if ('action' in record || !('type' in record)) return null;
  const { type, ...rest } = record;
  if (typeof type !== 'string' || !(ACTION_TYPE_LITERALS as readonly string[]).includes(type)) {
    return null;
  }
  return { value: { ...rest, action: type } };
}

/** Translate only action fields; plan orchestration and consent stay outside engines. */
export function decodeWireAction(body: unknown): Validated<SupportedAction> {
  const alias = translateDeprecatedType(body);
  const envelope = validatePlanStep(alias ? alias.value : body);
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
  let validated: Validated<SupportedAction>;
  if (action === 'select' && fields.values === undefined && typeof fields.value === 'string') {
    const { value, ...rest } = fields;
    validated = validateAction({ ...rest, values: [value], type: action });
  } else {
    validated = validateAction({ ...fields, type: action });
  }
  if (validated.ok && alias) {
    return { ...validated, warnings: [TYPE_DEPRECATION_WARNING] };
  }
  return validated;
}

export function validateWireAction(body: unknown): Validated<WireActionRequest> {
  const result = decodeWireAction(body);
  if (!result.ok) return result;
  const alias = translateDeprecatedType(body);
  return {
    ok: true,
    value: (alias ? alias.value : body) as WireActionRequest,
    ...(result.warnings ? { warnings: result.warnings } : {}),
  };
}
