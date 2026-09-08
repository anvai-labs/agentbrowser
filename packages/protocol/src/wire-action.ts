/** Canonical flat /act vocabulary. Surfaces validate here, not by assertion. */
import type { DeliveredWaitCondition, SelectAction, SupportedAction } from './types.js';
import { ACTION_TYPE_LITERALS, DELIVERED_WAIT_TYPES } from './schemas.js';
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

/** F3: a /act batch envelope - bounded short sequence, not an unbounded plan. */
export interface WireActionBatchRequest {
  steps: WireActionRequest[];
  observe?: 'after' | 'none';
  wait?: DeliveredWaitCondition;
}

export const MAX_BATCH_STEPS = 20;

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

function isValidDeliveredWait(wait: unknown): boolean {
  if (typeof wait !== 'object' || wait === null) return false;
  const record = wait as Record<string, unknown>;
  if (
    typeof record.until !== 'string' ||
    !(DELIVERED_WAIT_TYPES as readonly string[]).includes(record.until)
  ) {
    return false;
  }
  if (
    record.timeoutMs !== undefined &&
    (typeof record.timeoutMs !== 'number' ||
      !Number.isInteger(record.timeoutMs) ||
      record.timeoutMs < 0 ||
      record.timeoutMs > 300000)
  ) {
    return false;
  }
  if (record.pattern !== undefined && typeof record.pattern !== 'string') return false;
  if (record.selector !== undefined && typeof record.selector !== 'string') return false;
  if (
    record.count !== undefined &&
    (typeof record.count !== 'number' || !Number.isInteger(record.count) || record.count < 1)
  ) {
    return false;
  }
  return true;
}

/**
 * F3: structural validation for the batch envelope. Every step must stand
 * alone as a wire action; `action`/`type` alongside `steps` is an ambiguous
 * envelope and rejected. The service still re-validates each step when it
 * runs it - this gate exists to reject garbage with a 400 before anything
 * executes.
 */
export function validateWireActionBatch(body: unknown): Validated<WireActionBatchRequest> {
  const issues: Array<{ path: string; message: string }> = [];
  const record = body as Record<string, unknown>;
  if ('action' in record || 'type' in record) {
    issues.push({
      path: '/steps',
      message: 'A batch envelope carries steps only; action/type is ambiguous here.',
    });
  }
  if (!Array.isArray(record.steps)) {
    issues.push({ path: '/steps', message: "Batch requires a 'steps' array." });
  } else {
    if (record.steps.length < 1 || record.steps.length > MAX_BATCH_STEPS) {
      issues.push({
        path: '/steps',
        message: `Batch requires 1..${MAX_BATCH_STEPS} steps; got ${record.steps.length}.`,
      });
    }
    for (const [index, step] of record.steps.entries()) {
      const check = decodeWireAction(step);
      if (!check.ok) {
        for (const issue of check.issues) {
          issues.push({ path: `/steps/${index}${issue.path}`, message: issue.message });
        }
      }
    }
  }
  if (record.wait !== undefined && !isValidDeliveredWait(record.wait)) {
    issues.push({ path: '/wait', message: 'Invalid delivered wait condition.' });
  }
  if (record.observe !== undefined && record.observe !== 'after' && record.observe !== 'none') {
    issues.push({ path: '/observe', message: "observe must be 'after' or 'none'." });
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: body as WireActionBatchRequest };
}
