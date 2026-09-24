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
export const sessionRequestSchemaMatchesType =
  null as unknown as SessionRequest satisfies SchemaStaticOf<typeof SessionRequestSchema>;

export const sessionRequestTypeMatchesSchema = null as unknown as SchemaStaticOf<
  typeof SessionRequestSchema
> satisfies SessionRequest;

/** ActionSchema's static type must be assignable to/from SupportedAction. */
export const actionSchemaMatchesType = null as unknown as SupportedAction satisfies SchemaStaticOf<
  typeof ActionSchema
>;

export const actionTypeMatchesSchema = null as unknown as SchemaStaticOf<
  typeof ActionSchema
> satisfies SupportedAction;

// Capture contracts must agree in both directions, including wait discriminants.
import type {
  DeliveredWaitConditionSchema,
  ObservationRequestSchema,
  ScreenshotRequestSchema,
} from './schemas.js';
import type { DeliveredWaitCondition, ObservationRequest, ScreenshotRequest } from './types.js';
export const observationSchemaMatchesType = null as unknown as Static<
  typeof ObservationRequestSchema
> satisfies ObservationRequest;
export const observationTypeMatchesSchema = null as unknown as ObservationRequest satisfies Static<
  typeof ObservationRequestSchema
>;
export const screenshotSchemaMatchesType = null as unknown as Static<
  typeof ScreenshotRequestSchema
> satisfies ScreenshotRequest;
export const screenshotTypeMatchesSchema = null as unknown as ScreenshotRequest satisfies Static<
  typeof ScreenshotRequestSchema
>;
export const waitSchemaMatchesType = null as unknown as Static<
  typeof DeliveredWaitConditionSchema
> satisfies DeliveredWaitCondition;
export const waitTypeMatchesSchema = null as unknown as DeliveredWaitCondition satisfies Static<
  typeof DeliveredWaitConditionSchema
>;
