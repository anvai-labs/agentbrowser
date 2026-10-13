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
// RFC 8215 local-use NAT64 prefix: never globally routable.
privateIPs.addSubnet('64:ff9b:1::', 48, 'ipv6');

// The metadata floor (ADR-024 §1, TD-BROWSER-15 phase 0). Never relaxed by an
// operator private exception. Link-local is floored whole: it carries ECS task
// metadata (169.254.170.2) and EKS Pod Identity (169.254.170.23) as well as IMDS.
const metadata = new BlockList();
metadata.addSubnet('169.254.0.0', 16); // IPv4 link-local, incl. 169.254.169.254
metadata.addAddress('100.100.100.200'); // Alibaba Cloud
metadata.addAddress('168.63.129.16'); // Azure wire server
metadata.addSubnet('fd00:ec2::', 64, 'ipv6'); // AWS IMDS (::254), EKS Pod Identity (::23)
metadata.addSubnet('fe80::', 10, 'ipv6'); // IPv6 link-local
// GCP metadata server for IPv6-only instances (cloud.google.com, "querying metadata").
metadata.addAddress('fd20:ce::254', 'ipv6');
// OCI IMDS over IPv6. Not in Oracle's docs; cloud-init's DataSourceOracle uses it.
metadata.addAddress('fd00:c1::a9fe:a9fe', 'ipv6');

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

// RFC 6052 §2.2: where the IPv4 sits for each NAT64 prefix length. Byte 8 (the
// reserved u-octet) is skipped.
const RFC6052_OFFSETS: Record<number, readonly number[]> = {
  48: [6, 7, 9, 10],
  56: [7, 9, 10, 11],
  64: [9, 10, 11, 12],
  96: [12, 13, 14, 15],
};

/**
 * Every IPv4 an IPv6 address may carry, for the forms that route to it:
 * - NAT64 well-known 64:ff9b::/96;
 * - NAT64 local-use 64:ff9b:1::/48 (RFC 8215), under every RFC 6052 layout
 *   its prefix length allows (/48, /56, /64, /96), since the operator chooses;
 * - 6to4 2002::/16;
 * - SIIT IPv4-translated ::ffff:0:0:0/96;
 * - the deprecated IPv4-compatible ::/96, except :: and ::1, which decoded
 *   would read as 0.0.0.0/0.0.0.1 and lose their loopback class.
 * IPv4-mapped (::ffff:0:0/96) is already matched by BlockList's address
 * identity. Teredo (2001::/32) and ISATAP are not decoded: Teredo carries only
 * UDP-encapsulated IPv6 and ISATAP is an interface identifier.
 */
function embeddedIPv4(address: string): string[] {
  const b = ipv6Bytes(address);
  const at = (offsets: readonly number[]) => offsets.map((o) => b[o]).join('.');
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  const nat64 = b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b;
  if (nat64 && zero(4, 12)) return [at(RFC6052_OFFSETS[96] ?? [])]; // 64:ff9b::/96
  if (nat64 && b[4] === 0x00 && b[5] === 0x01) {
    return Object.values(RFC6052_OFFSETS).map(at); // 64:ff9b:1::/48, any layout
  }
  if (b[0] === 0x20 && b[1] === 0x02) return [at([2, 3, 4, 5])]; // 2002::/16
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && zero(10, 12)) {
    return [at([12, 13, 14, 15])]; // SIIT ::ffff:0:0:0/96
  }
  const isUnspecifiedOrLoopback = zero(12, 15) && (b[15] ?? 0) <= 1; // ::/127
  if (zero(0, 12) && !isUnspecifiedOrLoopback) return [at([12, 13, 14, 15])]; // ::/96
  return [];
}

// Cloud metadata services reached by name. Domains match exactly or as a
// subdomain; short (single-label search-domain) names match exactly.
const METADATA_DOMAINS = [
  'metadata.google.internal', // GCP
  'metadata.goog', // GCP
  'instance-data.ec2.internal', // AWS
] as const;
const METADATA_SHORT_NAMES = new Set(['metadata', 'instance-data']); // GCP, AWS

/**
 * True for a metadata service name. Case-insensitive, and a fully qualified
 * trailing dot is ignored: `metadata.google.internal.` names the same host, and
 * the CDP-attach lane, which checks only the name, has no DNS answer to fall back on.
 * Repeated trailing dots are stripped too.
 */
export function isMetadataHostname(hostname: string): boolean {
  // Strip trailing dots with a linear scan. A /\.+$/ regex backtracks
  // quadratically on interior dot runs, and page content controls hostnames.
  let end = hostname.length;
  while (end > 0 && hostname.charCodeAt(end - 1) === 0x2e) end--;
  const name = hostname.slice(0, end).toLowerCase();
  return (
    METADATA_SHORT_NAMES.has(name) ||
    METADATA_DOMAINS.some((domain) => name === domain || name.endsWith(`.${domain}`))
  );
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
  // Union with every embedded IPv4's classes: decoding only ever adds restrictions.
  const embedded = type === 'ipv6' ? embeddedIPv4(address) : [];
  const has = (list: BlockList) =>
    list.check(address, type) || embedded.some((v4) => list.check(v4, 'ipv4'));
  return {
    address,
    type,
    loopback: has(loopback),
    privateIP: has(privateIPs),
    metadata: has(metadata),
    // What makes it private, for operator CIDR exceptions: the address itself
    // (matched against IPv6/IPv4 CIDRs as written) and each private embedded
    // IPv4 (matched against IPv4 CIDRs). An exception must cover every source.
    privateSources: [
      ...(privateIPs.check(address, type) ? [{ address, type }] : []),
      ...embedded
        .filter((v4) => privateIPs.check(v4, 'ipv4'))
        .map((v4) => ({ address: v4, type: 'ipv4' as const })),
    ],
  };
}
