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
    attachment: choice(['local_launch', 'remote_cdp', 'unknown']),
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
      'unknown',
    ]),
    context: Type.Object(
      {
        isolation: choice(['new_context', 'unknown']),
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
});
export type SessionView = Static<typeof SessionViewSchema>;
