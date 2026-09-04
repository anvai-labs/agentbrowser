/**
 * Type-level contract checks (ADR-015).
 *
 * These live in a COMPILED source file deliberately: test files are
 * excluded from tsconfig and vitest does not type-check, so assertions
 * there would never run in CI. `pnpm -r type-check` enforces these — if a
 * schema and its declared type drift apart, this file stops compiling.
 */

import type { Static } from '@sinclair/typebox';
import type { ActionSchema, SessionRequestSchema } from './schemas.js';
import type { SessionRequest, SupportedAction } from './types.js';

type SchemaStaticOf<T> = T extends { static: infer S } ? S : never;

/** SessionRequestSchema's static type must be assignable to/from SessionRequest. */
export const sessionRequestSchemaMatchesType = (
  null as unknown as SessionRequest
) satisfies SchemaStaticOf<typeof SessionRequestSchema>;

export const sessionRequestTypeMatchesSchema = (
  null as unknown as SchemaStaticOf<typeof SessionRequestSchema>
) satisfies SessionRequest;

/** ActionSchema's static type must be assignable to/from SupportedAction. */
export const actionSchemaMatchesType = (
  null as unknown as SupportedAction
) satisfies SchemaStaticOf<typeof ActionSchema>;

export const actionTypeMatchesSchema = (
  null as unknown as SchemaStaticOf<typeof ActionSchema>
) satisfies SupportedAction;
