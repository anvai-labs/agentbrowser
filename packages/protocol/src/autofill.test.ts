import { expect, it } from 'vitest';
import {
  AutofillReportSchema,
  labelPattern,
  parseAutofillReport,
  parseAutofillRequest,
} from './autofill.js';
const field = { match: { label: 'Company' }, value: 'Example' };
it.each([
  { fields: [] },
  { fields: Array(51).fill(field) },
  { fields: [{ ...field, option: { value: 'both' } }] },
  { fields: [field], policy: { onAmbiguous: 'first' } },
  { fields: [field], policy: { timeoutMs: -1 } },
  { fields: [{ ...field, match: { labelRegex: '(a+)+$' } }] },
  { fields: [{ ...field, option: { index: 2 } }] },
  { fields: [{ ...field, strategy: 'react-select-keyboard' }] },
])('refuses unsupported or unbounded payloads: %j', (request) => {
  expect(() => parseAutofillRequest(request)).toThrow();
});
it.each([
  ['^Company.*name$', 'Company legal name', true],
  ['^Company.*name$', 'Prior Company legal name', false],
  ['^a.*a$', 'a', false],
  ['Name$', 'Other Name', true],
  ['Company', 'Company name', true],
  ['^Name$', 'Names', false],
])('matches the bounded literal/wildcard subset %s', (pattern, label, expected) => {
  expect(labelPattern(pattern as string)(label as string)).toBe(expected);
});
it('copies a reusable mapping so callers cannot mutate pending fields', () => {
  const input = { fields: [{ ...field, match: { label: 'Company' } }] };
  const request = parseAutofillRequest(input);
  const first = input.fields[0];
  if (!first) throw new Error('Missing fixture field');
  first.match.label = 'Changed';
  expect(request.fields[0]?.match.label).toBe('Company');
});

it('validates the versioned report without changing partial or unverified outcomes', () => {
  expect(AutofillReportSchema.$id).toBe('urn:agentbrowser:autofill-report:v1');
  for (const [ok, status] of [
    [false, 'uncertain'],
    [true, 'unverified'],
  ] as const) {
    const report = {
      ok,
      receipts: [{ field: 0, match: field.match, status, verified: false }],
      elapsedMs: 1,
    };
    expect(parseAutofillReport(report)).toEqual(report);
  }
  expect(() =>
    parseAutofillReport(
      {
        ok: true,
        receipts: [{ field: 0, match: field.match, status: 'verified', verified: true }],
        elapsedMs: 1,
      },
      2
    )
  ).toThrow('may have executed');
});

it('copies repeated report references while rejecting genuine cycles', () => {
  const sharedMatch = { label: 'Company' };
  const report = {
    ok: true,
    receipts: [
      { field: 0, match: sharedMatch, status: 'verified' as const, verified: true },
      { field: 1, match: sharedMatch, status: 'verified' as const, verified: true },
    ],
    elapsedMs: 1,
  };
  expect(parseAutofillReport(report, 2)).toEqual(report);

  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(() => parseAutofillReport({ ...report, extension: cycle }, 2)).toThrow(
    'may have executed'
  );
});

it.each([
  { ok: true, receipts: [], elapsedMs: 1 },
  {
    ok: true,
    receipts: [{ field: 1, match: field.match, status: 'verified', verified: true }],
    elapsedMs: 1,
  },
  { ok: true, receipts: [], elapsedMs: '1' },
  { ok: true, receipts: [{ field: 0, status: 'verified' }], elapsedMs: 1 },
  { ok: true, receipts: [], elapsedMs: 1, secret: 'PRIVATE-REPORT' },
])('rejects malformed reports without exposing returned values', (report) => {
  expect(() => parseAutofillReport(report)).toThrow(/^Invalid autofill report/);
  try {
    parseAutofillReport(report);
  } catch (error) {
    expect(String(error)).not.toContain('PRIVATE-REPORT');
    expect(String(error)).toContain('may have executed');
  }
});

it.each(['skipped', 'failed', 'uncertain', 'not_attempted'] as const)(
  'rejects aggregate success with a %s receipt without exposing the report',
  (status) => {
    const report = {
      ok: true,
      receipts: [
        {
          field: 0,
          match: field.match,
          status,
          verified: false,
          error: { code: 'REMOTE_FAILURE', message: 'PRIVATE-REPORT' },
        },
      ],
      elapsedMs: 1,
    };
    expect(() => parseAutofillReport(report)).toThrow(
      /^Invalid autofill report.*may have executed/
    );
    try {
      parseAutofillReport(report);
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE-REPORT');
    }
  }
);

it.each([
  { status: 'verified', verified: false },
  { status: 'unverified', verified: true },
  {
    status: 'verified',
    verified: true,
    error: { code: 'REMOTE_FAILURE', message: 'PRIVATE-REPORT' },
  },
] as const)('rejects contradictory successful receipt evidence: %j', (receipt) => {
  const report = {
    ok: true,
    receipts: [{ field: 0, match: field.match, ...receipt }],
    elapsedMs: 1,
  };
  expect(() => parseAutofillReport(report)).toThrow(/^Invalid autofill report.*may have executed/);
  try {
    parseAutofillReport(report);
  } catch (error) {
    expect(String(error)).not.toContain('PRIVATE-REPORT');
  }
});
