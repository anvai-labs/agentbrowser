/**
 * Application-surface wire schemas (shared-infra slice 2).
 *
 * These describe the HTTP/SDK vocabulary for the control package's
 * ApplicationAuthority: operator binding, delegated discovery, execution
 * and receipt lookup. Input size, node count and depth are NOT bounded
 * here - the authority's canonicalJson admission owns those limits so
 * every surface (including future MCP) fails identically.
 */

import { type Static, Type } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { OperationIdSchema, OperationRecordSchema } from './control.js';
import type { Validated, ValidationIssue } from './validators.js';

const strict = { additionalProperties: false };

/** Adapter and resource identifiers share the control operation-ID space. */
const ID_SCHEMA = OperationIdSchema;

export const ApplicationBindingSchema = Type.Object(
  { adapter: ID_SCHEMA, resource: ID_SCHEMA },
  strict
);

export const ApplicationOperationDescriptorSchema = Type.Object(
  {
    name: ID_SCHEMA,
    mode: Type.Union([Type.Literal('read'), Type.Literal('write')]),
  },
  strict
);

export const ApplicationDiscoverySchema = Type.Object(
  {
    adapter: Type.String(),
    resource: Type.String(),
    operations: Type.Array(ApplicationOperationDescriptorSchema, { maxItems: 256 }),
  },
  strict
);

export const ApplicationExecuteRequestSchema = Type.Object(
  {
    operation: ID_SCHEMA,
    input: Type.Unknown(),
    operationId: Type.Optional(ID_SCHEMA),
    expectedVersion: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  strict
);

/**
 * What an application execute call returns: the adapter's admitted result,
 * a rejection, or - when the operation ID was already admitted - a replay
 * carrying the recorded operation (with its settled status). `committed`/
 * `read` carry the adapter value; `rejected` carries the adapter's reason.
 * A replay is not a new result.
 */
export const ApplicationOperationResultSchema = Type.Union([
  Type.Object(
    {
      status: Type.Union([Type.Literal('read'), Type.Literal('committed')]),
      value: Type.Unknown(),
    },
    strict
  ),
  Type.Object({ status: Type.Literal('rejected'), reason: Type.String() }, strict),
  Type.Object({ replay: Type.Literal(true), operation: OperationRecordSchema }, strict),
]);

export type ApplicationBinding = Static<typeof ApplicationBindingSchema>;
export type ApplicationOperationDescriptor = Static<typeof ApplicationOperationDescriptorSchema>;
export type ApplicationDiscovery = Static<typeof ApplicationDiscoverySchema>;
export type ApplicationExecuteRequest = Static<typeof ApplicationExecuteRequestSchema>;
export type ApplicationOperationResult = Static<typeof ApplicationOperationResultSchema>;

const binding = TypeCompiler.Compile(ApplicationBindingSchema);
const execute = TypeCompiler.Compile(ApplicationExecuteRequestSchema);

/** Validate an operator bind body. */
export function validateApplicationBinding(body: unknown): Validated<ApplicationBinding> {
  return collect(binding, body) as Validated<ApplicationBinding>;
}

/** Validate an execute body (shape only; write identities are checked by the authority). */
export function validateApplicationExecute(body: unknown): Validated<ApplicationExecuteRequest> {
  return collect(execute, body) as Validated<ApplicationExecuteRequest>;
}

function collect(
  compiler: {
    Check(value: unknown): boolean;
    Errors(value: unknown): Iterable<{ path: string; message: string }>;
  },
  body: unknown
): Validated<unknown> {
  if (compiler.Check(body)) {
    return { ok: true, value: body };
  }
  const issues: ValidationIssue[] = [];
  for (const error of compiler.Errors(body)) {
    issues.push({ path: error.path, message: error.message });
  }
  return { ok: false, issues };
}
