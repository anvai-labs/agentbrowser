// The service's plan-level error codes must be declared in protocol PLAN_ERROR_CODES: the CLI's
// JUnit writer only emits known codes, so an undeclared one would silently render as FAILED.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAN_ERROR_CODES } from '@agentbrowser/protocol';
import { expect, it } from 'vitest';

it('every PLAN_* code the service emits is in PLAN_ERROR_CODES', () => {
  const source = readFileSync(join(import.meta.dirname, 'service.ts'), 'utf8');
  const emitted = new Set([...source.matchAll(/'(PLAN_[A-Z_]+)'/g)].map((m) => m[1]));
  expect(emitted.size).toBeGreaterThan(0);
  for (const code of emitted) expect(PLAN_ERROR_CODES, code).toContain(code);
});
