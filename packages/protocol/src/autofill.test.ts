import { expect, it } from 'vitest';
import { labelPattern, parseAutofillRequest } from './autofill.js';
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
  input.fields[0]!.match.label = 'Changed';
  expect(request.fields[0]?.match.label).toBe('Company');
});
