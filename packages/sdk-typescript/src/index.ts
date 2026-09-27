/**
 * AgentBrowser TypeScript SDK
 *
 * Export all public API components
 */

export * from './client.js';
export * from './subprocess.js';
export {
  INTERACTION_GUIDANCE,
  validateSessionRequest,
  ApplicationExecuteRequestSchema,
  ApplicationReviewRequestSchema,
  validateApplicationReview,
  ApplicationOperationResultSchema,
  AutofillRequestSchema,
  AutofillReportSchema,
  PlanActionsSchema,
  PlanReportSchema,
  OutcomeRunRequestSchema,
  OutcomeRunReportSchema,
  TestCaseEvaluationInputSchema,
  TestCaseEvaluationReportSchema,
  OperationReplaySchema,
  AGENT_MODE_IDS,
  DEFAULT_AGENT_MODE,
  createPlanReportParser,
  createOutcomeRunReportParser,
  evaluateTestCaseRun,
  isAgentMode,
  isPassingOutcome,
  parseOutcomeRunRequest,
  parseOperationReplay,
  parsePlanSteps,
  parsePlanReport,
  parseAutofillReport,
} from '@agentbrowser/protocol';
export {
  formatSessionTerminalFailure,
  sessionTerminalFailureDetail,
} from '@agentbrowser/protocol';
export type { SessionCloseCause, SessionTerminalView } from '@agentbrowser/protocol';

export type { ExportedCookie } from './client';

export type {
  AgentMode,
  OutcomeRunReport,
  OutcomeRunRequest,
  TestCaseEvaluationInput,
  TestCaseEvaluationReport,
  OperationReplay,
  PlanReport,
  RunCursor,
} from '@agentbrowser/protocol';

export {
  FormMappingSchema,
  FormValuesSchema,
  materializeAutofillMapping,
} from '@agentbrowser/protocol';
export type { FormMapping, FormValues } from '@agentbrowser/protocol';

export {
  OperatorApprovalDecisionSchema,
  OperatorApprovalViewSchema,
  parseOperatorApprovalView,
  validateOperatorApprovalDecision,
} from '@agentbrowser/protocol';
export type { OperatorApprovalView, OperatorApprovalDecision } from '@agentbrowser/protocol';

export {
  ObservationRequestSchema,
  ScreenshotRequestSchema,
  DeliveredWaitConditionSchema,
  PageStateSchema,
  ArtifactRefSchema,
  DELIVERED_WAIT_TYPES,
  parseObservationRequest,
  parseScreenshotRequest,
  validateObservationRequest,
  validateScreenshotRequest,
} from '@agentbrowser/protocol';
export type { DeliveredWaitCondition } from '@agentbrowser/protocol';
