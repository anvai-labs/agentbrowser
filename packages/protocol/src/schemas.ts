/**
 * JSON Schema definitions for AgentBrowser v1 API
 *
 * These schemas are the source of truth for API validation.
 * All types in this file should be kept in sync with types.ts
 */

import { Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { REF_PATTERN } from './types.js';

// Re-export all types for convenience
export * from './types.js';

// ============================================================================
// Error Schemas
// ============================================================================

export const ErrorCodeEnum = Type.Union([
  Type.Literal('INVALID_REQUEST'),
  Type.Literal('UNAUTHORIZED'),
  Type.Literal('FORBIDDEN'),
  Type.Literal('NOT_FOUND'),
  Type.Literal('POLICY_DENIED'),
  Type.Literal('APPROVAL_REQUIRED'),
  Type.Literal('SESSION_NOT_FOUND'),
  Type.Literal('SESSION_EXPIRED'),
  Type.Literal('PAGE_NOT_FOUND'),
  Type.Literal('STALE_TARGET'),
  Type.Literal('TARGET_NOT_FOUND'),
  Type.Literal('TARGET_AMBIGUOUS'),
  Type.Literal('TARGET_NOT_VISIBLE'),
  Type.Literal('TARGET_DISABLED'),
  Type.Literal('NAVIGATION_TIMEOUT'),
  Type.Literal('ACTION_TIMEOUT'),
  Type.Literal('ENGINE_UNSUPPORTED'),
  Type.Literal('ENGINE_CRASHED'),
  Type.Literal('DOWNLOAD_BLOCKED'),
  Type.Literal('QUOTA_EXCEEDED'),
  Type.Literal('OUTPUT_TRUNCATED'),
  Type.Literal('INTERNAL'),
]);

export const ApiErrorDetailSchema = Type.Object({
  code: ErrorCodeEnum,
  message: Type.String(),
  retryable: Type.Boolean(),
  action: Type.Optional(Type.String()),
  details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  traceId: Type.Optional(Type.String()),
});

export const ApiErrorSchema = Type.Object({
  error: ApiErrorDetailSchema,
});

// ============================================================================
// Core Type Schemas
// ============================================================================

export const ViewportSchema = Type.Object({
  width: Type.Number({ minimum: 1, maximum: 32768 }),
  height: Type.Number({ minimum: 1, maximum: 32768 }),
});

export const EngineTypeSchema = Type.Union([
  Type.Literal('playwright-chromium'),
  Type.Literal('auto'),
]);

export const ApprovalPolicySchema = Type.Object({
  transactions: Type.Optional(
    Type.Union([Type.Literal('allow'), Type.Literal('deny'), Type.Literal('required')])
  ),
  externalMessages: Type.Optional(
    Type.Union([Type.Literal('allow'), Type.Literal('deny'), Type.Literal('required')])
  ),
});

export const SessionPolicySchema = Type.Object({
  allowedHosts: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  blockedHosts: Type.Optional(Type.Array(Type.String())),
  allowDownloads: Type.Optional(Type.Boolean()),
  maxDownloadBytes: Type.Optional(Type.Number({ minimum: 0 })),
  approval: Type.Optional(ApprovalPolicySchema),
});

export const SessionRequestSchema = Type.Object({
  engine: Type.Optional(EngineTypeSchema),
  ttlMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 86400000 })),
  idleTimeoutMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 3600000 })),
  viewport: Type.Optional(ViewportSchema),
  locale: Type.Optional(Type.String({ pattern: '^[a-z]{2}-[A-Z]{2}$' })),
  timezoneId: Type.Optional(Type.String()),
  policy: Type.Optional(SessionPolicySchema),
});

// ============================================================================
// Engine Capability Schemas
// ============================================================================

export const ObservationModeSchema = Type.Union([
  Type.Literal('interactive'),
  Type.Literal('content'),
  Type.Literal('accessibility'),
  Type.Literal('compact_dom'),
  Type.Literal('visual'),
]);

/** The ActionType literal tuple, derived from the schema (never hand-listed). */
export const ACTION_TYPE_LITERALS = [
  'navigate',
  'click',
  'hover',
  'fill',
  'type',
  'clear',
  'press',
  'select',
  'check',
  'uncheck',
  'scroll',
  'wait',
  'upload',
  'download',
  'goBack',
  'goForward',
  'reload',
  'dismissDialog',
  'acceptDialog',
] as const;

export const ActionTypeSchema = Type.Union(
  ACTION_TYPE_LITERALS.map((literal) => Type.Literal(literal))
);

export const EngineCapabilitiesSchema = Type.Object({
  supportsScreenshots: Type.Boolean(),
  supportsPdf: Type.Boolean(),
  supportsDownloads: Type.Boolean(),
  supportsUploads: Type.Boolean(),
  supportsJavascript: Type.Boolean(),
  supportsWebgl: Type.Boolean(),
  supportsVideo: Type.Boolean(),
  supportsPersistentStorage: Type.Boolean(),
  supportsAccessibilityTree: Type.Boolean(),
  supportsCdp: Type.Boolean(),
  supportedObservationModes: Type.Array(ObservationModeSchema, { minItems: 1 }),
  supportedActionTypes: Type.Array(ActionTypeSchema, { minItems: 1 }),
});

export const EngineInfoSchema = Type.Object({
  name: Type.String(),
  version: Type.String(),
  capabilities: EngineCapabilitiesSchema,
});

// ============================================================================
// Response Schemas
// ============================================================================

export const SessionResponseSchema = Type.Object({
  sessionId: Type.String({ pattern: '^ses_[a-zA-Z0-9_]+$' }),
  engine: EngineInfoSchema,
  createdAt: Type.String(),
  ttlMs: Type.Number({ minimum: 0 }),
  idleTimeoutMs: Type.Number({ minimum: 0 }),
});

// ============================================================================
// Page State Schemas
// ============================================================================

export const ActionEffectSchema = Type.Union([
  Type.Literal('read'),
  Type.Literal('write-local'),
  Type.Literal('external-message'),
  Type.Literal('transaction'),
  Type.Literal('account-security'),
  Type.Literal('destructive'),
]);

export const PageStatusSchema = Type.Union([
  Type.Literal('loading'),
  Type.Literal('interactive'),
  Type.Literal('complete'),
]);

export const PageElementSchema = Type.Object({
  ref: Type.String({ pattern: REF_PATTERN.source }),
  role: Type.String(),
  name: Type.Optional(Type.String()),
  value: Type.Optional(Type.String()),
  required: Type.Optional(Type.Boolean()),
  visible: Type.Boolean(),
  enabled: Type.Boolean(),
  focused: Type.Optional(Type.Boolean()),
  risk: Type.Optional(ActionEffectSchema),
});

export const ElementChangeSchema = Type.Object({
  ref: Type.String(),
  change: Type.Union([Type.Literal('added'), Type.Literal('removed'), Type.Literal('modified')]),
  properties: Type.Record(
    Type.String(),
    Type.Object({
      old: Type.Unknown(),
      new: Type.Unknown(),
    })
  ),
});

export const ContinuationCursorSchema = Type.Object({
  nextOrdinal: Type.Integer({ minimum: 0 }),
  remaining: Type.Integer({ minimum: 0 }),
});

export const PageStateSchema = Type.Object({
  sessionId: Type.String(),
  pageId: Type.String(),
  revision: Type.Integer({ minimum: 1 }),
  url: Type.String({ pattern: '^https?://[\\w\\-]+(\\.[\\w\\-]+)+\\S*$' }),
  title: Type.String(),
  status: PageStatusSchema,
  focusedRef: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  elements: Type.Array(PageElementSchema),
  text: Type.Optional(Type.Array(Type.String())),
  changes: Type.Optional(Type.Array(ElementChangeSchema)),
  truncated: Type.Boolean(),
  untrustedContent: Type.Boolean(),
  continuation: Type.Optional(ContinuationCursorSchema),
});

// ============================================================================
// Action Schemas
// ============================================================================

export const ElementTargetSchema = Type.Object({
  ref: Type.String({ pattern: REF_PATTERN.source }),
});

export const NavigateActionSchema = Type.Object({
  type: Type.Literal('navigate'),
  url: Type.String({ pattern: '^https?://[\\w\\-]+(\\.[\\w\\-]+)+\\S*$' }),
  waitUntil: Type.Optional(
    Type.Union([
      Type.Literal('load'),
      Type.Literal('domcontentloaded'),
      Type.Literal('networkidle'),
    ])
  ),
});

export const ClickActionSchema = Type.Object({
  type: Type.Literal('click'),
  target: ElementTargetSchema,
  button: Type.Optional(
    Type.Union([Type.Literal('left'), Type.Literal('right'), Type.Literal('middle')])
  ),
  clickCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
  modifiers: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal('Alt'),
        Type.Literal('Control'),
        Type.Literal('Meta'),
        Type.Literal('Shift'),
      ])
    )
  ),
});

export const FillActionSchema = Type.Object({
  type: Type.Literal('fill'),
  target: ElementTargetSchema,
  value: Type.String(),
  sensitive: Type.Optional(Type.Boolean()),
});

export const SelectActionSchema = Type.Object({
  type: Type.Literal('select'),
  target: ElementTargetSchema,
  values: Type.Array(Type.String(), { minItems: 1 }),
});

export const ScrollActionSchema = Type.Object({
  type: Type.Literal('scroll'),
  target: Type.Optional(ElementTargetSchema),
  deltaX: Type.Optional(Type.Integer()),
  deltaY: Type.Optional(Type.Integer()),
  direction: Type.Optional(
    Type.Union([
      Type.Literal('up'),
      Type.Literal('down'),
      Type.Literal('left'),
      Type.Literal('right'),
    ])
  ),
  amount: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const PressActionSchema = Type.Object({
  type: Type.Literal('press'),
  target: Type.Optional(ElementTargetSchema),
  key: Type.String(),
});

export const WaitTypeSchema = Type.Union([
  Type.Literal('domcontentloaded'),
  Type.Literal('load'),
  Type.Literal('networkidle'),
  Type.Literal('selector'),
  Type.Literal('url'),
  Type.Literal('text'),
  Type.Literal('function'),
  Type.Literal('settled'),
]);

export const WaitConditionSchema = Type.Object({
  until: WaitTypeSchema,
  timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 300000 })),
});

export const WaitActionSchema = Type.Object({
  type: Type.Literal('wait'),
  condition: WaitConditionSchema,
});

export const ActionSchema = Type.Union([
  NavigateActionSchema,
  ClickActionSchema,
  FillActionSchema,
  SelectActionSchema,
  ScrollActionSchema,
  PressActionSchema,
  WaitActionSchema,
]);

export const ObservationRequestSchema = Type.Object({
  mode: Type.Optional(ObservationModeSchema),
  maxBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  maxElements: Type.Optional(Type.Integer({ minimum: 0 })),
  sinceRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  continueFrom: Type.Optional(Type.Integer({ minimum: 0 })),
  scope: Type.Optional(
    Type.Union([
      Type.Literal('viewport'),
      Type.Literal('full'),
      Type.Literal('frame'),
      Type.Literal('element'),
    ])
  ),
  include: Type.Optional(Type.Array(Type.String())),
});

// ============================================================================
// Action Request/Response Schemas
// ============================================================================

export const ActionRequestSchema = Type.Object({
  pageId: Type.String(),
  expectedRevision: Type.Integer({ minimum: 1 }),
  action: ActionSchema,
  wait: Type.Optional(WaitConditionSchema),
  observeAfter: Type.Optional(ObservationRequestSchema),
  approvalToken: Type.Optional(Type.String()),
});

export const NavigationStatusSchema = Type.Object({
  status: Type.Union([Type.Literal('success'), Type.Literal('timeout'), Type.Literal('blocked')]),
  url: Type.String({ pattern: '^https?://[\\w\\-]+(\\.[\\w\\-]+)+\\S*$' }),
  redirectChain: Type.Array(Type.String()),
});

export const PolicyDecisionSchema = Type.Object({
  allowed: Type.Boolean(),
  reason: Type.String(),
  ruleMatched: Type.Optional(Type.String()),
});

export const ApprovalDecisionSchema = Type.Object({
  approved: Type.Boolean(),
  reason: Type.Optional(Type.String()),
  approvalRequired: Type.Optional(Type.Boolean()),
});

export const ArtifactRefSchema = Type.Object({
  artifactId: Type.String(),
  type: Type.Union([
    Type.Literal('screenshot'),
    Type.Literal('pdf'),
    Type.Literal('trace'),
    Type.Literal('download'),
    Type.Literal('html'),
    Type.Literal('dom'),
  ]),
  contentType: Type.String(),
  sizeBytes: Type.Integer({ minimum: 0 }),
  url: Type.String(),
});

export const ActionResultSchema = Type.Object({
  actionId: Type.String(),
  startTimestamp: Type.String(),
  endTimestamp: Type.String(),
  oldRevision: Type.Integer({ minimum: 1 }),
  newRevision: Type.Integer({ minimum: 1 }),
  result: Type.Unknown(),
  navigationStatus: Type.Optional(NavigationStatusSchema),
  targetFingerprint: Type.Optional(Type.String()),
  policyDecision: Type.Optional(PolicyDecisionSchema),
  approvalDecision: Type.Optional(ApprovalDecisionSchema),
  observation: Type.Optional(PageStateSchema),
  artifacts: Type.Optional(Type.Array(ArtifactRefSchema)),
  error: Type.Optional(ApiErrorDetailSchema),
});

// ============================================================================
// Validation Helper
// ============================================================================

/**
 * Validate a value against a schema
 */
export function validate<T extends object>(
  schema: T,
  value: unknown
): { success: boolean; errors?: string[] } {
  try {
    // Check if value matches schema
    const isValid = Value.Check(schema as any, value);

    if (!isValid) {
      // Collect validation errors
      const errors: string[] = [];
      const errorsAny = Value.Errors(schema as any, value);

      for (const error of errorsAny) {
        errors.push(`${error.path}/${error.message}`);
      }

      return {
        success: false,
        errors: errors.length > 0 ? errors : ['Validation failed'],
      };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      errors: error instanceof Error ? [error.message] : ['Unknown validation error'],
    };
  }
}

/**
 * Check if value matches schema type
 */
export function isValid(schema: object, value: unknown): boolean {
  try {
    return Value.Check(schema as any, value);
  } catch {
    return false;
  }
}
