import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { parseExecutionReport } from './validators.js';

const text = () => Type.String({ minLength: 1, maxLength: 512 });
const strict = { additionalProperties: false };
export const AutofillMatchSchema = Type.Object(
  {
    role: Type.Optional(text()),
    label: Type.Optional(text()),
    labelRegex: Type.Optional(text()),
    dataAutomationId: Type.Optional(text()),
    block: Type.Optional(
      Type.Object(
        { id: Type.Optional(text()), label: Type.Optional(text()) },
        { ...strict, minProperties: 1 }
      )
    ),
  },
  { ...strict, minProperties: 1 }
);
export const AutofillRequestSchema = Type.Object(
  {
    fields: Type.Array(
      Type.Object(
        {
          match: AutofillMatchSchema,
          value: Type.Optional(Type.String({ maxLength: 8192 })),
          option: Type.Optional(Type.Object({ value: Type.String({ maxLength: 8192 }) }, strict)),
          verify: Type.Optional(Type.Union([Type.Literal('exact'), Type.Literal('none')])),
          strategy: Type.Optional(
            Type.Union([
              Type.Literal('native-input'),
              Type.Literal('native-select'),
              Type.Literal('react-select'),
              Type.Literal('chip-multiselect'),
            ])
          ),
        },
        strict
      ),
      { minItems: 1, maxItems: 50 }
    ),
    policy: Type.Optional(
      Type.Object(
        {
          onAmbiguous: Type.Optional(Type.Union([Type.Literal('fail'), Type.Literal('skip')])),
          onVerifyFail: Type.Optional(
            Type.Union([Type.Literal('fail'), Type.Literal('skip'), Type.Literal('retry')])
          ),
          maxReobserve: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
          settleMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 2000 })),
          timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 240000 })),
        },
        strict
      )
    ),
  },
  strict
);

export type AutofillRequest = Static<typeof AutofillRequestSchema>;
export type AutofillMatch = Static<typeof AutofillMatchSchema>;
export const AutofillReceiptSchema = Type.Object(
  {
    field: Type.Integer({ minimum: 0, maximum: 49 }),
    match: AutofillMatchSchema,
    resolvedRef: Type.Optional(Type.String()),
    blockIdentity: Type.Optional(Type.String()),
    actionId: Type.Optional(Type.String()),
    status: Type.Union(
      (['verified', 'unverified', 'skipped', 'failed', 'uncertain', 'not_attempted'] as const).map(
        (value) => Type.Literal(value)
      )
    ),
    verified: Type.Boolean(),
    actual: Type.Optional(Type.String({ maxLength: 512 })),
    actualTruncated: Type.Optional(Type.Boolean()),
    error: Type.Optional(Type.Object({ code: Type.String(), message: Type.String() }, strict)),
  },
  strict
);
export const AutofillReportSchema = Type.Object(
  {
    ok: Type.Boolean(),
    receipts: Type.Array(AutofillReceiptSchema, { maxItems: 50 }),
    elapsedMs: Type.Number({ minimum: 0 }),
    snapshot: Type.Optional(
      Type.Object(
        {
          artifactId: Type.String(),
          contentType: Type.Optional(Type.String()),
          sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
          warnings: Type.Optional(Type.Array(Type.String())),
        },
        strict
      )
    ),
    snapshotError: Type.Optional(Type.String()),
  },
  { ...strict, $id: 'urn:agentbrowser:autofill-report:v1' }
);
export type AutofillReceipt = Omit<Static<typeof AutofillReceiptSchema>, 'actual'> & {
  actual?: string | undefined;
};
export type AutofillReport = Omit<Static<typeof AutofillReportSchema>, 'receipts'> & {
  receipts: AutofillReceipt[];
};

/** Bounded, linear matching subset: literals, .* and optional ^ / $ anchors. */
export function labelPattern(pattern: string): (label: string) => boolean {
  const start = pattern.startsWith('^');
  const end = pattern.endsWith('$');
  const body = pattern.slice(start ? 1 : 0, end ? -1 : undefined);
  const parts = body.split('.*');
  if (parts.some((p) => /[\\[\]{}()+?*|.^$]/.test(p)))
    throw new Error('labelRegex supports only literals, .* and optional ^/$ anchors');
  return (label) => {
    let offset = 0;
    for (const [index, part] of parts.entries()) {
      const at = label.indexOf(part, offset);
      if (at < 0 || (index === 0 && start && at !== 0)) return false;
      offset = at + part.length;
    }
    if (!end) return true;
    const last = parts[parts.length - 1] ?? '';
    return label.endsWith(last) && (parts.length > 1 || !start || offset === label.length);
  };
}

export function parseAutofillRequest(input: unknown): AutofillRequest {
  if (!Value.Check(AutofillRequestSchema, input))
    throw new Error(
      'Invalid autofill request: bounded fields[] and policy required; unknown properties are rejected'
    );
  // Copy before any await so a trusted caller cannot change later fields mid-batch.
  const request = structuredClone(input);
  for (const field of request.fields) {
    if ((field.value === undefined) === (field.option === undefined))
      throw new Error('Each autofill field requires exactly one of value or option.value');
    const match = field.match;
    if (!match.label && !match.labelRegex && !match.dataAutomationId)
      throw new Error('Each autofill match requires label, labelRegex or dataAutomationId');
    if (match.labelRegex !== undefined) labelPattern(match.labelRegex);
    if (
      (field.strategy === 'native-input' && field.value === undefined) ||
      (field.strategy === 'native-select' && field.option === undefined)
    )
      throw new Error('Autofill strategy does not match value/option');
  }
  return request;
}

/** Validate service output before advertising it as a structured report. */
export function parseAutofillReport(input: unknown, expectedFields?: number): AutofillReport {
  return parseExecutionReport(
    AutofillReportSchema,
    input,
    'autofill',
    (report) =>
      !report.ok ||
      (report.receipts.length > 0 &&
        (expectedFields === undefined || report.receipts.length === expectedFields) &&
        report.receipts.every(
          (receipt, index) =>
            receipt.field === index &&
            receipt.error === undefined &&
            ((receipt.status === 'verified' && receipt.verified) ||
              (receipt.status === 'unverified' && !receipt.verified))
        ))
  );
}
