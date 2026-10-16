import { Type } from '@sinclair/typebox';
import { ControlViewSchema, OperationRecordSchema } from './control.js';
import { SessionEventsPageSchema } from './event-replay.js';
import { SessionResponseSchema } from './schemas.js';
import { SessionViewSchema } from './session-diagnostics.js';

/**
 * T0 M2: result shapes of MCP tools that previously advertised no outputSchema. MCP clients
 * validate structuredContent against the advertised schema, so these describe the live REST/SDK
 * results exactly where the fields are guaranteed and stay OPEN (additional properties allowed)
 * so an additive server field never breaks an agent. Validated against real results end to end
 * in packages/api/src/mcp-output-schemas.test.ts.
 */

const pageProperties = {
  pageId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  status: Type.String({ description: 'Page lifecycle status as the engine reports it.' }),
  url: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
};

/** A page as the service reports it (create, list). */
export const PageResponseSchema = Type.Object(pageProperties, { $id: 'urn:agentbrowser:page:v1' });

/** MCP `create`: the session plus the page provisioned with it. */
export const SessionCreatedResultSchema = Type.Object(
  {
    ...SessionResponseSchema.properties,
    pageId: Type.String({
      minLength: 1,
      description: 'The initial page created with the session.',
    }),
  },
  { $id: 'urn:agentbrowser:session-created:v1' }
);

/** MCP `pages`. */
export const PageListResultSchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1 }),
    pages: Type.Array(Type.Object(pageProperties)),
  },
  { $id: 'urn:agentbrowser:page-list:v1' }
);

/** MCP `close`. */
export const SessionClosedResultSchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1 }),
    closed: Type.Literal(true),
  },
  { $id: 'urn:agentbrowser:session-closed:v1' }
);

/** MCP `events_replay`: the paging envelope (the tool always requests the object form). */
export const SessionEventsPageResultSchema = Type.Object(
  { ...SessionEventsPageSchema.properties },
  { $id: 'urn:agentbrowser:session-events-page:v1' }
);

const decisionSchema = Type.Object({
  allowed: Type.Boolean(),
  reason: Type.Optional(Type.String()),
  ruleMatched: Type.Optional(Type.String()),
});

/** MCP `policy` without an action: the loaded policy's summary for the caller. */
export const PolicySummarySchema = Type.Object({
  policyVersion: Type.String(),
  summaryFor: Type.String(),
  capabilities: Type.Record(Type.String(), decisionSchema),
  limits: Type.Optional(Type.Record(Type.String(), Type.Number())),
  unconditional: Type.Optional(Type.String()),
});

/** MCP `policy` with an action: one answer per class set, by enumeration. */
export const PolicyCheckAnswerSchema = Type.Object({
  action: Type.String(),
  target: Type.Optional(Type.String()),
  answers: Type.Array(
    Type.Object({
      classSet: Type.String(),
      answer: Type.Object({ kind: Type.String(), decision: Type.Optional(decisionSchema) }),
    })
  ),
});

/** MCP `policy`: a summary or a check answer (root stays an object, as MCP requires). */
export const PolicyToolResultSchema = Type.Union([PolicySummarySchema, PolicyCheckAnswerSchema], {
  type: 'object',
  $id: 'urn:agentbrowser:policy-answer:v1',
});

/** MCP `cookies`: the session's exported cookies (values included: this is the export tool). */
export const CookieListResultSchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1 }),
    cookies: Type.Array(
      Type.Object({
        name: Type.String(),
        value: Type.String(),
        domain: Type.String(),
        path: Type.String(),
        expires: Type.Optional(Type.Number()),
        httpOnly: Type.Optional(Type.Boolean()),
        secure: Type.Optional(Type.Boolean()),
        sameSite: Type.Optional(Type.String()),
      })
    ),
  },
  { $id: 'urn:agentbrowser:cookie-list:v1' }
);

const countsSchema = Type.Record(Type.String(), Type.Integer({ minimum: 0 }));

/** MCP `cookie_handoff`: the completed handoff, or the approval request to relay. */
export const CookieHandoffToolResultSchema = Type.Union(
  [
    Type.Object({
      sessionId: Type.String({ minLength: 1 }),
      credentialSource: Type.Literal('operator'),
      domains: Type.Array(Type.String()),
      counts: countsSchema,
      lease: Type.Optional(
        Type.Object({
          hosts: Type.Array(Type.String()),
          expiresAt: Type.Number(),
          maxActions: Type.Integer({ minimum: 0 }),
          remainingActions: Type.Integer({ minimum: 0 }),
        })
      ),
    }),
    Type.Object({
      approvalRequired: Type.Literal(true),
      kind: Type.String(),
      sessionId: Type.String({ minLength: 1 }),
      domains: Type.Array(Type.String()),
      counts: countsSchema,
      tokenId: Type.String({ minLength: 1 }),
      guidance: Type.String(),
    }),
  ],
  { type: 'object', $id: 'urn:agentbrowser:cookie-handoff:v1' }
);

/** MCP `snapshot`: a self-contained observation usable as plan targets. */
export const PageSnapshotSchema = Type.Object(
  {
    url: Type.String(),
    title: Type.String(),
    revision: Type.Integer({ minimum: 0 }),
    mode: Type.Union([Type.Literal('stable'), Type.Literal('verified')]),
    fields: Type.Array(
      Type.Object({ ref: Type.String(), role: Type.String(), label: Type.String() })
    ),
    controls: Type.Optional(
      Type.Array(
        Type.Object({
          ref: Type.String(),
          role: Type.String(),
          label: Type.String(),
          context: Type.Optional(Type.String()),
        })
      )
    ),
    controlsProjection: Type.Optional(
      Type.Object({
        matched: Type.Integer({ minimum: 0 }),
        total: Type.Integer({ minimum: 0 }),
      })
    ),
    truncated: Type.Optional(Type.Boolean()),
    degraded: Type.Optional(Type.Boolean()),
    degradedReason: Type.Optional(Type.String()),
  },
  { $id: 'urn:agentbrowser:page-snapshot:v1' }
);

/** MCP `html`: the page HTML inline, bounded by maxBytes UTF-8 bytes and marked untrusted. */
export const PageHtmlResultSchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1 }),
    pageId: Type.String({ minLength: 1 }),
    artifactId: Type.String({ minLength: 1 }),
    html: Type.String(),
    truncated: Type.Boolean(),
    sizeBytes: Type.Integer({ minimum: 0 }),
    untrustedContent: Type.Literal(true),
    warning: Type.String(),
  },
  { $id: 'urn:agentbrowser:page-html:v1' }
);

/**
 * A client-facing copy of a protocol schema: every nested object stays open and closed string
 * enums widen to `string`, while required fields are kept. The MCP binary ships separately from
 * the server it talks to, so a newer server adding a field, a diagnostic or an enum value must not
 * make an older client reject the whole result. The canonical protocol schemas stay strict.
 */
export function relaxForClients(schema: unknown): Record<string, unknown> {
  const relax = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(relax);
    if (node === null || typeof node !== 'object') return node;
    const source = node as Record<string, unknown>;
    const alternatives = source.anyOf;
    if (
      Array.isArray(alternatives) &&
      alternatives.length > 0 &&
      alternatives.every(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as { const?: unknown }).const === 'string'
      )
    ) {
      const { anyOf: _closed, ...rest } = source;
      return { ...relaxEntries(rest), type: 'string' };
    }
    return relaxEntries(source);
  };
  const relaxEntries = (source: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (key === 'additionalProperties' && value === false) continue;
      out[key] = relax(value);
    }
    return out;
  };
  return relax(schema) as Record<string, unknown>;
}

/** MCP `session`: the session view, its pages and (for a bound session) the control view. */
export const SessionInspectionResultSchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1 }),
    session: Type.Unsafe<Record<string, unknown>>(relaxForClients(SessionViewSchema)),
    control: Type.Optional(
      Type.Unsafe<Record<string, unknown>>(relaxForClients(ControlViewSchema))
    ),
    pages: Type.Array(Type.Object(pageProperties)),
  },
  { $id: 'urn:agentbrowser:session-inspection:v1' }
);

/** MCP `operation` (delegated sessions): the operation record, relaxed for clients. */
export const OperationRecordResultSchema = Type.Unsafe<Record<string, unknown>>({
  ...relaxForClients(OperationRecordSchema),
  $id: 'urn:agentbrowser:operation-record:v1',
});
