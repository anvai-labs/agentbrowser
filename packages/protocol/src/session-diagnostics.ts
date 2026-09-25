import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const choice = <const T extends readonly string[]>(values: T) =>
  Type.Union(values.map((value) => Type.Literal(value as T[number])));
const strict = { additionalProperties: false };
export const BrowserVersionSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[a-zA-Z0-9._+ -]+$',
});

/** Bound an optional runtime version without exposing arbitrary adapter output. */
export function captureBrowserVersion(value: unknown): string | undefined {
  return Value.Check(BrowserVersionSchema, value) ? value : undefined;
}

export const SessionDiagnosticsSchema = Type.Object(
  {
    attachment: choice(['local_launch', 'remote_cdp', 'cdp_attach', 'unknown']),
    browserFamily: choice(['chromium', 'firefox', 'webkit', 'unknown']),
    browserVersion: Type.Optional(BrowserVersionSchema),
    executableSelection: choice([
      'explicit',
      'detected',
      'playwright_default',
      'not_applicable',
      'unknown',
    ]),
    launchMode: choice(['headless', 'headed', 'unknown']),
    resourceModel: choice([
      'dedicated_local_browser',
      'shared_local_browser',
      'shared_remote_connection',
      'operator_owned_browser',
      'unknown',
    ]),
    endpointClass: Type.Optional(choice(['loopback_http'])),
    egress: Type.Optional(choice(['navigation_preflight_only'])),
    context: Type.Object(
      {
        isolation: choice(['new_context', 'existing_default_context', 'unknown']),
        viewport: Type.Union([
          Type.Object(
            {
              mode: Type.Literal('fixed'),
              width: Type.Integer({ minimum: 1, maximum: 100_000 }),
              height: Type.Integer({ minimum: 1, maximum: 100_000 }),
            },
            strict
          ),
          Type.Object({ mode: Type.Literal('no_viewport') }, strict),
          Type.Object({ mode: Type.Literal('unknown') }, strict),
        ]),
        initScript: choice(['registered', 'not_registered', 'unknown']),
      },
      strict
    ),
  },
  strict
);

export type SessionDiagnostics = Readonly<Static<typeof SessionDiagnosticsSchema>>;

/** Optional adapter facts fail closed to absence. Copy only the bounded schema. */
export function captureSessionDiagnostics(value: unknown): SessionDiagnostics | undefined {
  try {
    if (!Value.Check(SessionDiagnosticsSchema, value)) return undefined;
    const viewport = value.context.viewport;
    const snapshot = {
      attachment: value.attachment,
      browserFamily: value.browserFamily,
      ...(value.browserVersion !== undefined ? { browserVersion: value.browserVersion } : {}),
      executableSelection: value.executableSelection,
      launchMode: value.launchMode,
      resourceModel: value.resourceModel,
      ...(value.endpointClass !== undefined ? { endpointClass: value.endpointClass } : {}),
      ...(value.egress !== undefined ? { egress: value.egress } : {}),
      context: {
        isolation: value.context.isolation,
        viewport:
          viewport.mode === 'fixed'
            ? { mode: viewport.mode, width: viewport.width, height: viewport.height }
            : { mode: viewport.mode },
        initScript: value.context.initScript,
      },
    };
    // A runtime adapter may have getters that change between validation and copy.
    if (!Value.Check(SessionDiagnosticsSchema, snapshot)) return undefined;
    Object.freeze(snapshot.context.viewport);
    Object.freeze(snapshot.context);
    return Object.freeze(snapshot);
  } catch {
    return undefined;
  }
}

/** Service-session deadlines, sampled together; independent of delegated grants. */
export const SessionLeaseSchema = Type.Object(
  {
    sampledAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    expiresAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    lastActivityAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    idleExpiresAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  strict
);
export type SessionLease = Readonly<Static<typeof SessionLeaseSchema>>;

/** Point-in-time lease upper bound derived from one authoritative sample. */
export function sessionLeaseRemainingMs(lease: SessionLease): number {
  return Math.max(0, Math.min(lease.expiresAt, lease.idleExpiresAt) - lease.sampledAt);
}

/** A terminal cause is an observed lifecycle fact, never inferred from free-form text. */
export const SessionCloseCauseSchema = choice([
  'ttl_expired',
  'idle_expired',
  'explicit_close',
  'policy_terminated',
  'engine_disconnected',
  'engine_crash',
  'unknown',
]);
export type SessionCloseCause = Static<typeof SessionCloseCauseSchema>;

/** Detached, bounded facts retained briefly after a session leaves the live registry. */
export const SessionTerminalViewSchema = Type.Object(
  {
    closeCause: SessionCloseCauseSchema,
    endedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    state: choice([
      'closed',
      'expired',
      'policy_terminated',
      'engine_disconnected',
      'engine_crashed',
      'quota_terminated',
    ]),
    leaseRemainingMs: Type.Literal(0),
    lease: SessionLeaseSchema,
  },
  strict
);
export type SessionTerminalView = Readonly<Static<typeof SessionTerminalViewSchema>>;

/** Copy one allowlisted terminal detail from an untrusted client error shape. */
export function sessionTerminalFailureDetail(error: unknown): SessionTerminalView | undefined {
  try {
    if (!error || typeof error !== 'object') return undefined;
    const candidate = (error as { details?: { sessionTerminal?: unknown } }).details
      ?.sessionTerminal;
    if (!Value.Check(SessionTerminalViewSchema, candidate)) return undefined;
    const source = candidate as SessionTerminalView;
    const snapshot = {
      closeCause: source.closeCause,
      endedAt: source.endedAt,
      state: source.state,
      leaseRemainingMs: source.leaseRemainingMs,
      lease: {
        sampledAt: source.lease.sampledAt,
        expiresAt: source.lease.expiresAt,
        lastActivityAt: source.lease.lastActivityAt,
        idleExpiresAt: source.lease.idleExpiresAt,
      },
    };
    if (!Value.Check(SessionTerminalViewSchema, snapshot)) return undefined;
    Object.freeze(snapshot.lease);
    return Object.freeze(snapshot);
  } catch {
    return undefined;
  }
}

/** Shared CLI/MCP text projection; arbitrary error details never reach output. */
export function formatSessionTerminalFailure(error: unknown): string | undefined {
  const terminal = sessionTerminalFailureDetail(error);
  if (!terminal) return undefined;
  return `Session ended: close-cause=${terminal.closeCause}; ended-at=${terminal.endedAt}; lease-remaining=${terminal.leaseRemainingMs}ms; ttl-expires=${terminal.lease.expiresAt}; idle-expires=${terminal.lease.idleExpiresAt} (Unix ms)`;
}

/** The HTTP session view; distinct from the coordinator's capability-bearing result. */
export const SessionViewSchema = Type.Object({
  sessionId: Type.String(),
  status: Type.String(),
  engine: Type.Object({ name: Type.String(), version: Type.String() }),
  createdAt: Type.String(),
  ttlMs: Type.Number({ minimum: 0 }),
  idleTimeoutMs: Type.Number({ minimum: 0 }),
  pages: Type.Integer({ minimum: 0 }),
  tenantId: Type.Optional(Type.String()),
  warnings: Type.Optional(Type.Array(Type.String())),
  diagnostics: Type.Optional(SessionDiagnosticsSchema),
  lease: Type.Optional(SessionLeaseSchema),
  /** Present only after the coordinator has observed the first terminal transition. */
  closeCause: Type.Optional(SessionCloseCauseSchema),
  /** Derived from the sampled lease at projection time; never stored as a countdown. */
  leaseRemainingMs: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
});
export type SessionView = Static<typeof SessionViewSchema>;
