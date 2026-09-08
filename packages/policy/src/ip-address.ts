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

const metadata = new BlockList();
metadata.addAddress('169.254.169.254');

/** Internal classification only; undefined means not a valid, unscoped IP. */
export function classifyIPAddress(input: string) {
  if (typeof input !== 'string' || input.includes('%')) return undefined;
  const bracketed = input.startsWith('[') && input.endsWith(']');
  const address = bracketed ? input.slice(1, -1) : input;
  const family = isIP(address);
  // The browser policy port also receives URL hostnames such as [::1].
  // Brackets never make sense for IPv4 or resolver-owned transport records.
  if (!family || (bracketed && family !== 6)) return undefined;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  return {
    loopback: loopback.check(address, type),
    privateIP: privateIPs.check(address, type),
    metadata: metadata.check(address, type),
  };
}
