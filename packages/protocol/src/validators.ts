/**
 * Compiled request validators (ADR-015 B4).
 *
 * The TypeBox schemas in schemas.ts were the documented source of truth
 * but were never invoked at runtime - every surface hand-rolled its own
 * typeof checks. These compiled validators are the runtime half: surfaces
 * call them instead of re-implementing validation. Compiled once at module
 * load (TypeCompiler), so the per-request cost is a cheap Check().
 */

import type { Static, TSchema } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { Value } from '@sinclair/typebox/value';
import { UsageError } from './errors.js';
import { INTERACTION_GUIDANCE } from './interaction-guidance.js';
import {
  ActionSchema,
  DeliveredWaitConditionSchema,
  ObservationRequestSchema,
  PlanStepSchema,
  ScreenshotRequestSchema,
  SessionRequestSchema,
} from './schemas.js';
import type {
  DeliveredWaitCondition,
  ObservationRequest,
  ScreenshotRequest,
  SessionRequest,
  SupportedAction,
} from './types.js';
import { validateUploadIntegrity } from './upload.js';

/** One validation failure, addressed by pointer path. */
export interface ValidationIssue {
  path: string;
  message: string;
}

export type Validated<T> =
  | { ok: true; value: T; warnings?: string[] }
  | { ok: false; issues: ValidationIssue[] };

const sessionRequest = TypeCompiler.Compile(SessionRequestSchema);

/**
 * Validate a session-create body against SessionRequestSchema. Note that
 * tenantId is OPTIONAL at the protocol level - whether a tenantId is
 * required is an authentication-policy decision that belongs to the
 * surface (the REST server requires it in no-keys mode and stamps the
 * key's tenant when keys are configured).
 *
 * Additional properties (e.g. the service's flat policy fields) pass
 * through untouched; validation constrains, it does not strip.
 */
export function validateSessionRequest(body: unknown): Validated<SessionRequest> {
  if (sessionRequest.Check(body)) {
    return { ok: true, value: body as SessionRequest };
  }
  const issues: ValidationIssue[] = [];
  for (const error of sessionRequest.Errors(body)) {
    issues.push({ path: error.path, message: error.message });
  }
  return { ok: false, issues };
}

const action = TypeCompiler.Compile(ActionSchema);

/**
 * Validate a constructed action (the protocol's nested SupportedAction
 * shape, not the flat wire body) against the ActionSchema union.
 * Enforced in the service immediately after construction, so REST /act,
 * /plan and direct service callers all pass through one gate.
 */
export function validateAction(body: unknown): Validated<SupportedAction> {
  const integrityError = validateUploadIntegrity(body);
  if (integrityError) return { ok: false, issues: [{ path: '/sha256', message: integrityError }] };
  if (action.Check(body)) {
    return { ok: true, value: body as SupportedAction };
  }
  const issues: ValidationIssue[] = [];
  for (const error of action.Errors(body)) {
    issues.push({ path: error.path, message: error.message });
  }
  return { ok: false, issues };
}

const planStep = TypeCompiler.Compile(PlanStepSchema);

/**
 * Validate one plan step (the flat wire vocabulary) against PlanStepSchema.
 * The plan route was the last request surface taking an unvalidated loose
 * array: waitForLabel/waitMs rode straight through to waitForLabel's
 * deadline arithmetic, where a non-numeric or non-finite waitMs produced a
 * NaN/Infinity deadline and a poll loop that never exited. validateAction
 * does not close this - toProtocolAction strips both fields BEFORE it runs.
 * Like the other validators: constrains, does not strip.
 */
export function validatePlanStep(body: unknown): Validated<Record<string, unknown>> {
  const integrityError = validateUploadIntegrity(body);
  if (integrityError) return { ok: false, issues: [{ path: '/sha256', message: integrityError }] };
  // The nested { action: { type: ... } } envelope is the service-internal
  // representation; left to the compiled union it surfaces as an opaque
  // "Expected union value", so name the flat shape before that check runs.
  if (
    typeof body === 'object' &&
    body !== null &&
    'action' in body &&
    typeof (body as Record<string, unknown>).action !== 'string'
  ) {
    return {
      ok: false,
      issues: [
        {
          path: '/action',
          message:
            "Wire actions and plan steps use the flat shape: { action: 'fill', target: { ref: 'e1_0' }, value: 'text' }. Got a non-string action (nested object?) - flatten it: the action name is the string and every field sits beside it. The nested { action: { type: ... } } shape is the service-internal representation and is not accepted on the wire.",
        },
      ],
    };
  }
  if (planStep.Check(body)) {
    return { ok: true, value: body as Record<string, unknown> };
  }
  const issues: ValidationIssue[] = [];
  for (const error of planStep.Errors(body)) {
    issues.push({ path: error.path, message: error.message });
  }
  return { ok: false, issues };
}

const utf8 = new TextEncoder();

export interface JsonSnapshotLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxBytes: number;
}

interface SnapshotState {
  readonly active: WeakSet<object>;
  readonly limits: JsonSnapshotLimits;
  nodes: number;
  bytes: number;
}

function chargeString(value: string, state: SnapshotState): void {
  if (value.length > state.limits.maxBytes - state.bytes) throw new Error('unstable report');
  state.bytes += utf8.encode(value).byteLength;
  if (state.bytes > state.limits.maxBytes) throw new Error('unstable report');
}

function snapshotJsonValue(input: unknown, state: SnapshotState, depth: number): unknown {
  if (depth > state.limits.maxDepth || ++state.nodes > state.limits.maxNodes)
    throw new Error('unstable report');
  if (
    input === null ||
    input === undefined ||
    typeof input === 'number' ||
    typeof input === 'boolean'
  ) {
    return input;
  }
  if (typeof input === 'string') {
    chargeString(input, state);
    return input;
  }
  if (typeof input !== 'object' || state.active.has(input)) throw new Error('unstable report');
  state.active.add(input);
  try {
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype) throw new Error('unstable report');
      const length = Object.getOwnPropertyDescriptor(input, 'length');
      if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value))
        throw new Error('unstable report');
      if (length.value > state.limits.maxNodes - state.nodes) throw new Error('unstable report');
      const keys = Reflect.ownKeys(input);
      if (keys.length !== length.value + 1 || keys.some((key) => typeof key !== 'string'))
        throw new Error('unstable report');
      const snapshot: unknown[] = [];
      for (let index = 0; index < length.value; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
          throw new Error('unstable report');
        snapshot.push(snapshotJsonValue(descriptor.value, state, depth + 1));
      }
      return snapshot;
    }

    if (Object.getPrototypeOf(input) !== Object.prototype) throw new Error('unstable report');
    const snapshot: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string') throw new Error('unstable report');
      chargeString(key, state);
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
        throw new Error('unstable report');
      Object.defineProperty(snapshot, key, {
        value: snapshotJsonValue(descriptor.value, state, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return snapshot;
  } finally {
    state.active.delete(input);
  }
}

/** Stable and detached data, with optional bounds, for semantic validation at trust boundaries. */
export function snapshotJsonData(input: unknown, limits?: JsonSnapshotLimits): unknown {
  return snapshotJsonValue(
    input,
    {
      active: new WeakSet<object>(),
      limits: limits ?? {
        maxDepth: Number.POSITIVE_INFINITY,
        maxNodes: Number.POSITIVE_INFINITY,
        maxBytes: Number.POSITIVE_INFINITY,
      },
      nodes: 0,
      bytes: 0,
    },
    0
  );
}

/** One output-boundary policy: invalid reports never prove that a write did not execute. */
export function parseExecutionReport<S extends TSchema>(
  schema: S,
  input: unknown,
  operation: string,
  semanticallyValid: (report: Static<S>) => boolean = () => true,
  snapshotLimits?: JsonSnapshotLimits
): Static<S> {
  let report: unknown;
  try {
    report = snapshotJsonData(input, snapshotLimits);
  } catch {
    throw new Error(`Invalid ${operation} report. ${INTERACTION_GUIDANCE.uncertainWrite}`);
  }
  if (!Value.Check(schema, report) || !semanticallyValid(report)) {
    throw new Error(`Invalid ${operation} report. ${INTERACTION_GUIDANCE.uncertainWrite}`);
  }
  return report;
}

const captureObservation = TypeCompiler.Compile(ObservationRequestSchema);
const captureScreenshot = TypeCompiler.Compile(ScreenshotRequestSchema);
const deliveredWait = TypeCompiler.Compile(DeliveredWaitConditionSchema);

/** Validate before starting any browser work; preserve the caller's request. */
export function validateDeliveredWaitCondition(body: unknown): Validated<DeliveredWaitCondition> {
  if (!deliveredWait.Check(body))
    return {
      ok: false,
      issues: [...deliveredWait.Errors(body)].map(({ path, message }) => ({ path, message })),
    };
  const wait = body as DeliveredWaitCondition;
  if (wait.until === 'urlPattern') {
    const regex = /^\/(.*)\/([a-z]*)$/.exec(wait.pattern ?? '');
    if (regex) {
      try {
        new RegExp(regex[1] ?? '', regex[2] ?? '');
      } catch {
        return {
          ok: false,
          issues: [{ path: '/pattern', message: "Wait 'urlPattern' regex is invalid" }],
        };
      }
    }
  }
  return { ok: true, value: wait };
}

function validateCapture<T extends { wait?: DeliveredWaitCondition }>(
  body: unknown,
  schema: typeof captureObservation | typeof captureScreenshot
): Validated<T> {
  if (!schema.Check(body))
    return {
      ok: false,
      issues: [...schema.Errors(body)].map(({ path, message }) => ({ path, message })),
    };
  const request = body as T;
  if (request.wait !== undefined) {
    const checked = validateDeliveredWaitCondition(request.wait);
    if (!checked.ok)
      return {
        ok: false,
        issues: checked.issues.map((issue) => ({ ...issue, path: `/wait${issue.path}` })),
      };
  }
  return { ok: true, value: request };
}

export function validateObservationRequest(body: unknown): Validated<ObservationRequest> {
  return validateCapture<ObservationRequest>(body, captureObservation);
}
export function validateScreenshotRequest(body: unknown): Validated<ScreenshotRequest> {
  return validateCapture<ScreenshotRequest>(body, captureScreenshot);
}

function requireCapture<T>(result: Validated<T>): T {
  if (!result.ok)
    throw new UsageError(
      `Invalid capture request: ${result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`
    );
  return result.value;
}
export function parseObservationRequest(body: unknown): ObservationRequest {
  return requireCapture(validateObservationRequest(body));
}
export function parseScreenshotRequest(body: unknown): ScreenshotRequest {
  return requireCapture(validateScreenshotRequest(body));
}
