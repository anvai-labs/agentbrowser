import { BlockList, isIP } from 'node:net';

// Private, fixed-size tables. Node compares parsed address identities, including
// IPv4-mapped IPv6, rather than spelling/prefixes. No DNS, sockets or verdict cache.
const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8);
loopback.addAddress('0.0.0.0');
loopback.addAddress('::1', 'ipv6');
loopback.addAddress('::', 'ipv6');

const privateIPs = new BlockList();
// Preserve the existing blockPrivateIPs range set, not an all-special-use list.
// IPv4 127/8 belongs to blockLoopback; IPv6 ::/::1 historically match both flags.
for (const [address, prefix] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
  ['100.64.0.0', 10],
  ['0.0.0.0', 8],
  ['198.18.0.0', 15],
] as const) {
  privateIPs.addSubnet(address, prefix);
}
privateIPs.addAddress('::1', 'ipv6');
privateIPs.addAddress('::', 'ipv6');
privateIPs.addSubnet('fe80::', 10, 'ipv6');
privateIPs.addSubnet('fc00::', 7, 'ipv6');

// The metadata floor (ADR-024 §1, TD-BROWSER-15 phase 0). Never relaxed by an
// operator private exception. Link-local is floored whole: it carries ECS task
// metadata (169.254.170.2) and EKS Pod Identity (169.254.170.23) as well as IMDS.
const metadata = new BlockList();
metadata.addSubnet('169.254.0.0', 16); // IPv4 link-local, incl. 169.254.169.254
metadata.addAddress('100.100.100.200'); // Alibaba Cloud
metadata.addAddress('168.63.129.16'); // Azure wire server
metadata.addSubnet('fd00:ec2::', 64, 'ipv6'); // AWS IMDS (::254), EKS Pod Identity (::23)
metadata.addSubnet('fe80::', 10, 'ipv6'); // IPv6 link-local

/** The 16 bytes of an IPv6 address already validated by `isIP`. */
function ipv6Bytes(address: string): number[] {
  let text = address;
  const tail: number[] = [];
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1]) {
    tail.push(...dotted[1].split('.').map(Number));
    text = text.slice(0, -dotted[1].length);
    if (text.endsWith(':') && !text.endsWith('::')) text = text.slice(0, -1);
  }
  const [head = '', rest] = text.split('::') as [string, string | undefined];
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const left = groups(head);
  const right = rest === undefined ? [] : groups(rest);
  const missing = 8 - tail.length / 2 - left.length - right.length;
  const hex = [...left, ...Array<string>(rest === undefined ? 0 : missing).fill('0'), ...right];
  const bytes = hex.flatMap((g) => {
    const v = Number.parseInt(g, 16);
    return [v >> 8, v & 0xff];
  });
  return [...bytes, ...tail];
}

/**
 * IPv4 carried inside an IPv6 address, for the forms that route to it: NAT64
 * (64:ff9b::/96, 64:ff9b:1::/48), 6to4 (2002::/16) and the deprecated
 * IPv4-compatible ::/96. `::` and `::1` are excluded: decoded they would read as
 * 0.0.0.0/0.0.0.1 and lose their loopback class. IPv4-mapped (::ffff:0:0/96) is
 * already matched by BlockList's address identity.
 */
function embeddedIPv4(address: string): string | undefined {
  const b = ipv6Bytes(address);
  const dotted = (o: number) => b.slice(o, o + 4).join('.');
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (zero(4, 12)) return dotted(12); // 64:ff9b::/96
    if (b[4] === 0x00 && b[5] === 0x01) return dotted(12); // 64:ff9b:1::/48 (RFC 8215)
  }
  if (b[0] === 0x20 && b[1] === 0x02) return dotted(2); // 2002::/16 (6to4)
  const isUnspecifiedOrLoopback = zero(12, 15) && (b[15] ?? 0) <= 1; // ::/127
  if (zero(0, 12) && !isUnspecifiedOrLoopback) return dotted(12); // ::/96
  return undefined;
}

/** Internal classification only; undefined means not a valid, unscoped IP. */
export function classifyIPAddress(input: string) {
  if (typeof input !== 'string' || input.includes('%')) return undefined;
  const bracketed = input.startsWith('[') && input.endsWith(']');
  const address = bracketed ? input.slice(1, -1) : input;
  const family = isIP(address);
  // The browser policy port also receives URL hostnames such as [::1].
  // Brackets never make sense for IPv4 or resolver-owned transport records.
  if (!family || (bracketed && family !== 6)) return undefined;
  const type: 'ipv4' | 'ipv6' = family === 4 ? 'ipv4' : 'ipv6';
  // Union with the embedded IPv4's classes: decoding only ever adds restrictions.
  const embedded = type === 'ipv6' ? embeddedIPv4(address) : undefined;
  const has = (list: BlockList) =>
    list.check(address, type) || (embedded !== undefined && list.check(embedded, 'ipv4'));
  return {
    address,
    type,
    loopback: has(loopback),
    privateIP: has(privateIPs),
    metadata: has(metadata),
  };
}
