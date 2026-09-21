import { type Static, type TLiteral, Type } from '@sinclair/typebox';
import { OperationIdSchema } from './control.js';
import { INTERACTION_GUIDANCE } from './interaction-guidance.js';
import {
  OutcomeRunReportSchema,
  type OutcomeRunRequest,
  OutcomeRunRequestSchema,
  VERIFICATION_SNAPSHOT_LIMITS,
  createOutcomeRunReportParser,
  isPassingOutcome,
} from './outcome.js';
import { parseExecutionReport } from './validators.js';

const strict = { additionalProperties: false };
const identifier = () =>
  Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' });

const skipReasonLiterals: [
  TLiteral<'CAPABILITY_UNAVAILABLE'>,
  TLiteral<'PRECONDITION_UNAVAILABLE'>,
] = [Type.Literal('CAPABILITY_UNAVAILABLE'), Type.Literal('PRECONDITION_UNAVAILABLE')];
export const TEST_CASE_SKIP_REASON_CODES = Object.freeze(
  skipReasonLiterals.map((schema) => schema.const)
);

export const TestCaseSkipReasonCodeSchema = Type.Intersect([
  Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Z][A-Z0-9_]*$' }),
  Type.Union(skipReasonLiterals),
]);
export type TestCaseSkipReasonCode = Static<typeof TestCaseSkipReasonCodeSchema>;

export const TestCaseEnvironmentSchema = Type.Object(
  {
    productVersion: identifier(),
    cliVersion: identifier(),
    engine: Type.Object({ name: identifier(), version: identifier() }, strict),
    fixture: Type.Object({ id: identifier(), version: identifier() }, strict),
  },
  strict
);
export type TestCaseEnvironment = Static<typeof TestCaseEnvironmentSchema>;

export const TestCaseAssertionDescriptorSchema = Type.Object(
  { id: identifier(), required: Type.Boolean() },
  strict
);
export type TestCaseAssertionDescriptor = Static<typeof TestCaseAssertionDescriptorSchema>;

export const TestCaseDescriptorSchema = Type.Object(
  {
    id: identifier(),
    version: identifier(),
    testedSeam: Type.Literal('ui'),
    environment: TestCaseEnvironmentSchema,
    assertions: Type.Array(TestCaseAssertionDescriptorSchema, { minItems: 1, maxItems: 16 }),
  },
  { ...strict, $id: 'urn:agentbrowser:test-case-descriptor:v1' }
);
export type TestCaseDescriptor = Static<typeof TestCaseDescriptorSchema>;

export const AssertionInvocationSchema = Type.Object(
  {
    id: identifier(),
    operationId: OperationIdSchema,
    request: OutcomeRunRequestSchema,
  },
  strict
);
export type AssertionInvocation = Omit<Static<typeof AssertionInvocationSchema>, 'request'> & {
  request: OutcomeRunRequest;
};

export const TestCaseAssertionResultSchema = Type.Union([
  Type.Object(
    {
      id: identifier(),
      status: Type.Literal('completed'),
      operationId: OperationIdSchema,
      report: OutcomeRunReportSchema,
    },
    strict
  ),
  Type.Object(
    {
      id: identifier(),
      status: Type.Literal('skipped'),
      reasonCode: TestCaseSkipReasonCodeSchema,
    },
    strict
  ),
]);
export type TestCaseAssertionResult = Static<typeof TestCaseAssertionResultSchema>;

export const TestCaseRunReportSchema = Type.Object(
  {
    case: Type.Object({ id: identifier(), version: identifier() }, strict),
    environment: TestCaseEnvironmentSchema,
    setup: Type.Union([Type.Literal('completed'), Type.Literal('failed'), Type.Literal('unknown')]),
    assertions: Type.Array(TestCaseAssertionResultSchema, { minItems: 1, maxItems: 16 }),
    cleanup: Type.Union([
      Type.Literal('complete'),
      Type.Literal('failed'),
      Type.Literal('unknown'),
    ]),
  },
  { ...strict, $id: 'urn:agentbrowser:test-case-run-report:v1' }
);
export type TestCaseRunReport = Static<typeof TestCaseRunReportSchema>;

export const TestCaseEvaluationInputSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    descriptor: TestCaseDescriptorSchema,
    invocations: Type.Array(AssertionInvocationSchema, { maxItems: 16 }),
    report: TestCaseRunReportSchema,
  },
  { ...strict, $id: 'urn:agentbrowser:test-case-evaluation-input:v1' }
);
export type TestCaseEvaluationInput = Omit<
  Static<typeof TestCaseEvaluationInputSchema>,
  'descriptor' | 'invocations' | 'report'
> & {
  descriptor: TestCaseDescriptor;
  invocations: readonly AssertionInvocation[];
  report: TestCaseRunReport;
};

export const TestCaseEvaluationReportSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    provenance: Type.Literal('caller_observed'),
    verdict: Type.Union([Type.Literal('passed'), Type.Literal('failed')]),
    descriptor: TestCaseDescriptorSchema,
    report: TestCaseRunReportSchema,
  },
  { ...strict, $id: 'urn:agentbrowser:test-case-evaluation-report:v1' }
);
export type TestCaseEvaluationReport = Static<typeof TestCaseEvaluationReportSchema>;

export interface TestCaseRunContract {
  parse(input: unknown): TestCaseRunReport;
  isPassing(input: unknown): boolean;
}

interface PreparedInvocation {
  readonly id: string;
  readonly operationId: string;
  readonly parseReport: ReturnType<typeof createOutcomeRunReportParser>;
}

const AssertionInvocationsSchema = Type.Array(AssertionInvocationSchema, { maxItems: 16 });

function invalidContract(): never {
  throw new Error('Invalid test case run contract.');
}

function invalidReport(): never {
  throw new Error(`Invalid test case run report. ${INTERACTION_GUIDANCE.uncertainWrite}`);
}

function invalidEvaluation(): never {
  throw new Error('Invalid test case evaluation.');
}

function sameEnvironment(left: TestCaseEnvironment, right: TestCaseEnvironment): boolean {
  return (
    left.productVersion === right.productVersion &&
    left.cliVersion === right.cliVersion &&
    left.engine.name === right.engine.name &&
    left.engine.version === right.engine.version &&
    left.fixture.id === right.fixture.id &&
    left.fixture.version === right.fixture.version
  );
}

function parseDescriptor(input: unknown): TestCaseDescriptor {
  try {
    return parseExecutionReport(
      TestCaseDescriptorSchema,
      input,
      'test case descriptor',
      (value) =>
        value.environment.productVersion === value.environment.cliVersion &&
        value.assertions.some((assertion) => assertion.required) &&
        new Set(value.assertions.map((assertion) => assertion.id)).size === value.assertions.length,
      VERIFICATION_SNAPSHOT_LIMITS
    );
  } catch {
    return invalidContract();
  }
}

function prepareInvocations(
  input: unknown,
  descriptor: TestCaseDescriptor
): readonly PreparedInvocation[] {
  let invocations: Static<typeof AssertionInvocationsSchema>;
  try {
    invocations = parseExecutionReport(
      AssertionInvocationsSchema,
      input,
      'test case invocations',
      undefined,
      VERIFICATION_SNAPSHOT_LIMITS
    );
  } catch {
    return invalidContract();
  }

  const descriptorIndex = new Map(
    descriptor.assertions.map((assertion, index) => [assertion.id, index] as const)
  );
  const ids = new Set<string>();
  const operationIds = new Set<string>();
  let previousIndex = -1;
  const prepared: PreparedInvocation[] = [];

  try {
    for (const invocation of invocations) {
      const index = descriptorIndex.get(invocation.id);
      if (
        index === undefined ||
        index <= previousIndex ||
        ids.has(invocation.id) ||
        operationIds.has(invocation.operationId)
      ) {
        return invalidContract();
      }
      previousIndex = index;
      ids.add(invocation.id);
      operationIds.add(invocation.operationId);
      prepared.push(
        Object.freeze({
          id: invocation.id,
          operationId: invocation.operationId,
          parseReport: createOutcomeRunReportParser(invocation.request),
        })
      );
    }
  } catch {
    return invalidContract();
  }
  return Object.freeze(prepared);
}

/** Bind report parsing and aggregate truth to one captured descriptor and request set. */
export function createTestCaseRunContract(
  descriptor: TestCaseDescriptor,
  invocations: readonly AssertionInvocation[]
): TestCaseRunContract {
  const expected = parseDescriptor(descriptor);
  const prepared = prepareInvocations(invocations, expected);
  const invocationById = new Map(prepared.map((invocation) => [invocation.id, invocation]));

  const parse = (input: unknown): TestCaseRunReport => {
    let report: TestCaseRunReport;
    try {
      report = parseExecutionReport(
        TestCaseRunReportSchema,
        input,
        'test case run',
        undefined,
        VERIFICATION_SNAPSHOT_LIMITS
      );
    } catch {
      return invalidReport();
    }

    if (
      report.case.id !== expected.id ||
      report.case.version !== expected.version ||
      !sameEnvironment(report.environment, expected.environment) ||
      report.assertions.length !== expected.assertions.length
    ) {
      return invalidReport();
    }

    const assertions: TestCaseAssertionResult[] = [];
    let completed = 0;
    try {
      for (let index = 0; index < expected.assertions.length; index++) {
        const definition = expected.assertions[index];
        const result = report.assertions[index];
        if (definition === undefined || result === undefined || result.id !== definition.id) {
          return invalidReport();
        }
        const invocation = invocationById.get(result.id);
        if (result.status === 'skipped') {
          if (invocation !== undefined) return invalidReport();
          assertions.push(result);
          continue;
        }
        if (invocation === undefined || result.operationId !== invocation.operationId) {
          return invalidReport();
        }
        const nested = invocation.parseReport(result.report);
        if (nested.outcome.testedSeam !== expected.testedSeam) return invalidReport();
        completed++;
        assertions.push({ ...result, report: nested });
      }
    } catch {
      return invalidReport();
    }
    if (completed !== prepared.length) return invalidReport();

    return { ...report, assertions };
  };

  const isPassing = (input: unknown): boolean => {
    const report = parse(input);
    if (report.setup !== 'completed' || report.cleanup !== 'complete') return false;
    return expected.assertions.every((definition, index) => {
      if (!definition.required) return true;
      const result = report.assertions[index];
      return result?.status === 'completed' && isPassingOutcome(result.report.outcome);
    });
  };

  return Object.freeze({ parse, isPassing });
}

/** Evaluate one caller-observed case through the existing bound TestCase truth owner. */
export function evaluateTestCaseRun(input: unknown): TestCaseEvaluationReport {
  try {
    const prepared = parseExecutionReport(
      TestCaseEvaluationInputSchema,
      input,
      'test case evaluation input',
      undefined,
      VERIFICATION_SNAPSHOT_LIMITS
    ) as TestCaseEvaluationInput;
    const contract = createTestCaseRunContract(prepared.descriptor, prepared.invocations);
    const report = contract.parse(prepared.report);
    const output: TestCaseEvaluationReport = {
      schemaVersion: 1,
      provenance: 'caller_observed',
      verdict: contract.isPassing(report) ? 'passed' : 'failed',
      descriptor: prepared.descriptor,
      report,
    };
    return parseExecutionReport(
      TestCaseEvaluationReportSchema,
      output,
      'test case evaluation report',
      undefined,
      VERIFICATION_SNAPSHOT_LIMITS
    );
  } catch {
    return invalidEvaluation();
  }
}
