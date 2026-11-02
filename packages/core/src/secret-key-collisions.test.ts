import { expect, it } from 'vitest';
import { SecretManager } from './secret-manager.js';

const A = 'alphaSeed-123';
const B = 'bravoSeed-456';
const key = (value: number, bits: number) =>
  Array.from({ length: bits }, (_, bit) => ((value >> bit) & 1 ? A : B)).join('');

it('assigns collision suffixes in linear work without overwriting existing literal keys', () => {
  const manager = new SecretManager();
  manager.initializeSessionSecrets('owner', [A, B]);
  const bits = 9;
  const base = '***'.repeat(bits);
  const source = Object.fromEntries([
    [`${base}#1`, 'reserved'],
    ...Array.from({ length: 2 ** bits }, (_, value) => [key(value, bits), `value-${value}`]),
  ]);
  const original = Set.prototype.has;
  let calls = 0;
  let output: Record<string, unknown>;
  Set.prototype.has = function (value) {
    calls++;
    return original.call(this, value);
  };
  try {
    output = manager.redactUntrustedScoped(source, 'owner');
  } finally {
    Set.prototype.has = original;
  }
  expect(calls).toBeLessThan(4 * Object.keys(source).length);
  expect(Object.keys(output)).toHaveLength(2 ** bits + 1);
  expect(output[`${base}#1`]).toBe('reserved');
  expect(output[base]).toBe('value-0');
  expect(output[`${base}#2`]).toBe('value-1');
  expect(output[`${base}#${2 ** bits}`]).toBe(`value-${2 ** bits - 1}`);
});

it('retains the previous insertion-order behavior when a literal suffixed key occurs later', () => {
  const manager = new SecretManager();
  manager.initializeSessionSecrets('owner', [A, B]);
  expect(
    manager.redactUntrustedScoped({ [A]: 'first', [B]: 'second', '***#1': 'literal' }, 'owner')
  ).toEqual({ '***': 'first', '***#1': 'second', '***#1#1': 'literal' });
});
