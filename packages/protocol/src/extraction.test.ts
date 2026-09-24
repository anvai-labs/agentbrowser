import { Value } from '@sinclair/typebox/value';
import { expect, it } from 'vitest';
import {
  ExtractMaxBytesSchema,
  parseExtractMaxBytes,
  parseExtractMaxBytesText,
} from './extraction.js';

it.each([1, 4096, 1048576, Number.MAX_SAFE_INTEGER])(
  'accepts the same valid limit %s in parser and schema',
  (value) => {
    expect(Value.Check(ExtractMaxBytesSchema, value)).toBe(true);
    expect(parseExtractMaxBytes(value)).toBe(value);
    expect(parseExtractMaxBytesText(String(value))).toBe(value);
  }
);

it.each([
  undefined,
  null,
  true,
  '4096',
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
])('refuses invalid wire limit %s in parser and schema', (value) => {
  expect(Value.Check(ExtractMaxBytesSchema, value)).toBe(false);
  expect(() => parseExtractMaxBytes(value)).toThrow();
});

it.each(['', ' ', '+1', '-1', '1.5', '4KB', '1e6', '0x1000'])(
  'refuses non-decimal CLI/environment limit %s',
  (value) => {
    expect(() => parseExtractMaxBytesText(value)).toThrow();
  }
);
