import { type Static, Type } from '@sinclair/typebox';
import { AgentModeSchema } from './mode-profile.js';

export const ControlStateSchema = Type.Union([
  Type.Literal('HUMAN_ACTIVE'),
  Type.Literal('RESUME_REVIEW'),
  Type.Literal('AGENT_ACTIVE'),
  Type.Literal('PAUSE_REQUESTED'),
  Type.Literal('STOPPED'),
]);
export const OperationRecordSchema = Type.Object({
  operationId: Type.String(),
  epoch: Type.Integer(),
  status: Type.Union([
    Type.Literal('in_flight'),
    Type.Literal('completed'),
    Type.Literal('failed'),
    Type.Literal('outcome_unknown'),
  ]),
  dispatched: Type.Boolean(),
});
export const RunCursorSchema = Type.Object({
  version: Type.Literal(1),
  serviceGeneration: Type.String({ pattern: '^[A-Za-z0-9_-]{22}$' }),
  bindingGeneration: Type.String({ pattern: '^[A-Za-z0-9_-]{22}$' }),
  sessionId: Type.String({ minLength: 1 }),
  controlEpoch: Type.Integer({ minimum: 0 }),
  mode: AgentModeSchema,
  profileRevision: Type.Integer({ minimum: 1 }),
});
export const ControlViewSchema = Type.Object({
  state: ControlStateSchema,
  epoch: Type.Integer(),
  busy: Type.Boolean(),
  operation: Type.Optional(OperationRecordSchema),
  cursor: Type.Optional(RunCursorSchema),
});
export type ControlState = Static<typeof ControlStateSchema>;
export type OperationRecord = Static<typeof OperationRecordSchema>;
export type RunCursor = Static<typeof RunCursorSchema>;
export type ControlView = Static<typeof ControlViewSchema>;
export const CONTROL_OPERATION_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export const ControlReviewSchema = Type.Intersect([
  ControlViewSchema,
  Type.Object({
    pages: Type.Array(
      Type.Object({
        pageId: Type.String(),
        url: Type.String(),
        title: Type.String(),
        revision: Type.Integer(),
        summary: Type.String(),
      })
    ),
  }),
]);
export const ControlGrantSchema = Type.Intersect([
  ControlViewSchema,
  Type.Object({ token: Type.String(), mode: AgentModeSchema, cursor: RunCursorSchema }),
]);
