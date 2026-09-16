import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from './canonical-json.js';

describe('bounded canonical application JSON', () => {
  it.each(['ascii', 'é', '漢', '😀', '\u0000', '\b\f\n\r\t', '\ud800', '\udc00', '"\\'])(
    '%j uses JSON UTF-8 and escaping semantics',
    (value) => {
      expect(canonicalJson(value)).toBe(JSON.stringify(value));
    }
  );

  it('accepts exactly 64 KiB and rejects one additional byte', () => {
    const value = 'é'.repeat(32767);
    expect(Buffer.byteLength(canonicalJson(value))).toBe(65536);
    expect(() => canonicalJson(`${value}a`)).toThrow('too large');
    expect(() => canonicalJson('\u0000'.repeat(10923))).toThrow('too large');
  });

  it('charges delimiters, escaped keys and aggregate nested strings to one byte budget', () => {
    const value = ['x'.repeat(32764), 'x'.repeat(32765)];
    expect(Buffer.byteLength(canonicalJson(value))).toBe(65536);
    expect(() => canonicalJson([...value, 0])).toThrow('too large');
    expect(() => canonicalJson({ ['\u0000'.repeat(10923)]: 0 })).toThrow('too large');
  });

  it('orders object keys without changing array order or invoking toJSON', () => {
    expect(canonicalJson({ z: [2, 1], a: { y: 0, x: -0 } })).toBe('{"a":{"x":0,"y":0},"z":[2,1]}');
    const toJSON = vi.fn(() => 'surprise');
    const value = Object.defineProperty({ a: 1 }, 'toJSON', { value: toJSON });
    expect(canonicalJson(value)).toBe('{"a":1}');
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('rejects accessors without invoking application code', () => {
    const getter = vi.fn(() => 1);
    const object = Object.defineProperty({}, 'a', { enumerable: true, get: getter });
    const array = Object.defineProperty([0], '0', { get: getter });
    for (const value of [object, array]) expect(() => canonicalJson(value)).toThrow('data');
    expect(getter).not.toHaveBeenCalled();
  });

  it('bounds nodes and depth and rejects sparse arrays and non-JSON values', () => {
    expect(JSON.parse(canonicalJson(Array(4095).fill(null)))).toHaveLength(4095);
    expect(() => canonicalJson(Array(4096).fill(null))).toThrow();
    let deep: unknown = null;
    for (let i = 0; i < 16; i++) deep = [deep];
    expect(() => canonicalJson(deep)).not.toThrow();
    expect(() => canonicalJson([deep])).toThrow('too deep');
    for (const value of [
      Array(2),
      undefined,
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(),
      { a: () => 1 },
    ])
      expect(() => canonicalJson(value)).toThrow();
  });
});
