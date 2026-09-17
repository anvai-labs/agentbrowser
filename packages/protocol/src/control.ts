import { type Static, Type } from '@sinclair/typebox';
import { AgentModeSchema } from './mode-profile.js';
import { parseExecutionReport } from './validators.js';

const strict = { additionalProperties: false };

export const ControlStateSchema = Type.Union([
  Type.Literal('HUMAN_ACTIVE'),
  Type.Literal('RESUME_REVIEW'),
  Type.Literal('AGENT_ACTIVE'),
  Type.Literal('PAUSE_REQUESTED'),
  Type.Literal('STOPPED'),
]);
export const OperationRecordSchema = Type.Object(
  {
    operationId: Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' }),
    epoch: Type.Integer({ minimum: 0 }),
    status: Type.Union([
      Type.Literal('in_flight'),
      Type.Literal('completed'),
      Type.Literal('failed'),
      Type.Literal('outcome_unknown'),
    ]),
    dispatched: Type.Boolean(),
  },
  strict
);
export const OperationReplaySchema = Type.Object(
  { replay: Type.Literal(true), operation: OperationRecordSchema },
  { ...strict, $id: 'urn:agentbrowser:operation-replay:v1' }
);
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
export type OperationReplay = Static<typeof OperationReplaySchema>;
export type RunCursor = Static<typeof RunCursorSchema>;
export type ControlView = Static<typeof ControlViewSchema>;
export const CONTROL_OPERATION_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export function parseOperationReplay(input: unknown): OperationReplay {
  return parseExecutionReport(OperationReplaySchema, input, 'operation replay', undefined, {
    maxDepth: 4,
    maxNodes: 32,
    maxBytes: 4096,
  });
}

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
