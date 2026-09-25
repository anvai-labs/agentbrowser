import { Type } from '@sinclair/typebox';

/** Default operator-owned ceiling for a complete serialized extraction result. */
export const DEFAULT_EXTRACT_MAX_BYTES = 1024 * 1024;

export const ExtractMaxBytesSchema = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
  description:
    'Maximum UTF-8 bytes of the complete compact JSON extraction result, including evidence. ' +
    'Omission uses the server ceiling (default 1048576 bytes, operator configurable). ' +
    'Requests cannot exceed that ceiling. Oversized results fail explicitly; no partial JSON is returned.',
});

/** Shared request/configuration validation; no coercion of wire values. */
export function parseExtractMaxBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error('Extraction maxBytes must be a positive safe integer');
  return value;
}

/** CLI and environment values are decimal strings, never parseInt prefixes. */
export function parseExtractMaxBytesText(value: string): number {
  if (!/^[0-9]+$/.test(value))
    throw new Error('Extraction maxBytes must be a positive decimal integer');
  return parseExtractMaxBytes(Number(value));
}
