import { BlockList, isIP } from 'node:net';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { expandRangesForCedar, normalizeSourceForCedar, parseCidr } from './cedar-generator.js';

/**
 * The referee for `expandRangesForCedar` is Node's BlockList itself — the
 * exact behaviour `LegacyAuthorizer` and `NetworkPolicy` enforce today. For
 * any rule and any probe address, "the expansion covers the normalized probe"
 * must equal `BlockList.check`. This pins the mapped-space un-mapping and the
 * marker-prefix grants, including prefixes the oracle's fixed CIDR list never
 * reaches.
 */

const v4Arb = fc
  .tuple(fc.nat(255), fc.nat(255), fc.nat(255), fc.nat(255))
  .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);
const v4Special = fc.constantFrom(
  '0.0.0.0',
  '10.0.0.1',
  '10.255.255.255',
  '11.0.0.0',
  '255.255.255.255',
  '192.168.1.0',
  '192.168.1.255'
);
const probe4Arb = fc.oneof(v4Arb, v4Special);

const v6Arb = fc
  .tuple(...Array<fc.Arbitrary<number>>(8).fill(fc.nat(0xffff)))
  .map((words) => words.map((w) => w.toString(16)).join(':'));
const v6Special = fc.constantFrom(
  '::',
  '::1',
  '::ffff:0:0',
  '::ffff:ffff:ffff',
  '64:ff9b::a01:203',
  'fd12::1',
  '::ffff:0:0:0', // translated-style, not mapped space
  '2001:db8::1'
);
const mappedDottedArb = v4Arb.map((a) => `::ffff:${a}`);
const probe6Arb = fc.oneof(v6Arb, v6Special, mappedDottedArb);

const prefix4Arb = fc.oneof(fc.nat(32), fc.constantFrom(0, 8, 31, 32));
const prefix6Arb = fc.oneof(
  fc.nat(128),
  fc.constantFrom(0, 79, 80, 81, 95, 96, 97, 104, 119, 120, 127, 128)
);

const rule4Arb = fc.tuple(v4Arb, prefix4Arb).map(([a, p]) => `${a}/${p}`);
const rule6Arb = fc
  .tuple(fc.oneof(v6Arb, v6Special, mappedDottedArb), prefix6Arb)
  .map(([a, p]) => `${a}/${p}`);
const ruleArb = fc.oneof(rule4Arb, rule6Arb).filter((rule) => {
  const [subnet] = rule.split('/');
  return isIP(subnet) !== 0;
});

const v4ToInt = (a: string) => a.split('.').reduce((acc, o) => acc * 256 + Number(o), 0);
const v6ToBig = (a: string) => {
  const groups = a.split('::');
  const expand = (part: string) =>
    part === ''
      ? []
      : part
          .split(':')
          .flatMap((w) =>
            w.includes('.')
              ? [
                  (
                    Number.parseInt(w.split('.')[0], 10) * 256 +
                    Number.parseInt(w.split('.')[1], 10)
                  )
                    .toString(16)
                    .padStart(4, '0'),
                  (
                    Number.parseInt(w.split('.')[2], 10) * 256 +
                    Number.parseInt(w.split('.')[3], 10)
                  )
                    .toString(16)
                    .padStart(4, '0'),
                ]
              : [w]
          );
  const head = expand(groups[0] ?? '');
  const tail = groups.length > 1 ? expand(groups[1] ?? '') : [];
  const fill = Array<string>(8 - head.length - tail.length).fill('0');
  return [...head, ...fill, ...tail].reduce(
    (acc, w) => (acc << 16n) + BigInt(Number.parseInt(w, 16)),
    0n
  );
};

function contains(range: string, address: string): boolean {
  const { subnet, prefix, family } = parseCidr(range);
  if (family === 4) {
    if (isIP(address) !== 4) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (v4ToInt(subnet) & mask) === (v4ToInt(address) & mask);
  }
  if (isIP(address) !== 6) return false;
  const shift = BigInt(128 - prefix);
  return v6ToBig(subnet) >> shift === v6ToBig(address) >> shift;
}

/** The Cedar-side answer: normalize the probe, then look for a same-family range. */
function cedarCovers(ranges: string[], address: string, type: 'ipv4' | 'ipv6'): boolean {
  const normalized = normalizeSourceForCedar(address, type);
  return ranges.some((range) => contains(range, normalized));
}

describe('expandRangesForCedar matches BlockList exactly', () => {
  it('single rule, arbitrary probes', () => {
    fc.assert(
      fc.property(
        ruleArb,
        fc.oneof(probe4Arb, probe6Arb),
        fc.constantFrom('ipv4', 'ipv6'),
        (rule, rawProbe, declaredType) => {
          const probe =
            declaredType === 'ipv4' ? (isIP(rawProbe) === 4 ? rawProbe : '10.1.2.3') : rawProbe;
          if (declaredType === 'ipv6' && isIP(probe) !== 6) return true;
          const [subnet, prefixText] = rule.split('/');
          const block = new BlockList();
          block.addSubnet(subnet, Number(prefixText), isIP(subnet) === 4 ? 'ipv4' : 'ipv6');
          const expected = block.check(probe, declaredType);
          expect({
            rule,
            probe,
            declaredType,
            got: cedarCovers(expandRangesForCedar([rule]), probe, declaredType),
            want: expected,
          }).toEqual({ rule, probe, declaredType, got: expected, want: expected });
        }
      ),
      { numRuns: 3000 }
    );
  });

  it('unions of rules', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(ruleArb, { maxLength: 3 }),
        fc.oneof(probe4Arb, probe6Arb),
        (rules, probe) => {
          const type = (isIP(probe) === 4 ? 'ipv4' : 'ipv6') as 'ipv4' | 'ipv6';
          const block = new BlockList();
          for (const rule of rules) {
            const [subnet, prefixText] = rule.split('/');
            block.addSubnet(subnet, Number(prefixText), isIP(subnet) === 4 ? 'ipv4' : 'ipv6');
          }
          expect(cedarCovers(expandRangesForCedar(rules), probe, type)).toBe(
            block.check(probe, type)
          );
        }
      ),
      { numRuns: 1500 }
    );
  });

  it('the verified cross-family matrix, as a fixed table', () => {
    const probes: Array<[string, 'ipv4' | 'ipv6']> = [
      ['10.1.2.3', 'ipv4'],
      ['192.168.1.5', 'ipv4'],
      ['8.8.8.8', 'ipv4'],
      ['::ffff:10.1.2.3', 'ipv6'],
      ['::ffff:8.8.8.8', 'ipv6'],
      ['64:ff9b::a01:203', 'ipv6'],
      ['fd12::1', 'ipv6'],
      ['::1', 'ipv6'],
    ];
    const rules = [
      '10.0.0.0/8',
      '192.168.1.0/24',
      '0.0.0.0/0',
      '::/0',
      '::/80',
      '::/95',
      '::/96',
      '::ffff:0:0/96',
      '::ffff:10.0.0.0/104',
      '::ffff:192.168.1.0/120',
      '64:ff9b::/96',
      '2001:db8::/32',
    ];
    for (const rule of rules) {
      const [subnet, prefixText] = rule.split('/');
      const block = new BlockList();
      block.addSubnet(subnet, Number(prefixText), isIP(subnet) === 4 ? 'ipv4' : 'ipv6');
      const ranges = expandRangesForCedar([rule]);
      for (const [probe, type] of probes) {
        expect({
          rule,
          probe,
          got: cedarCovers(ranges, probe, type),
          want: block.check(probe, type),
        }).toEqual({
          rule,
          probe,
          got: block.check(probe, type),
          want: block.check(probe, type),
        });
      }
    }
  });
});
