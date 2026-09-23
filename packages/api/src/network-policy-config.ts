import { NetworkPolicy } from '@agentbrowser/policy';

/** One default SSRF policy for embedded services and the server entrypoint. */
export function createDefaultNetworkPolicy(allowedPrivateCIDRs: string[] = []): NetworkPolicy {
  return new NetworkPolicy({
    blockLoopback: true,
    blockPrivateIPs: true,
    blockMetadata: true,
    allowedPrivateCIDRs,
  });
}

/** Operator startup configuration only; never read from session/request input. */
export function networkPolicyFromEnvironment(
  env: { AGENTBROWSER_ALLOWED_CIDRS?: string | undefined },
  warn: (message: string) => void = console.warn
): NetworkPolicy {
  const raw = env.AGENTBROWSER_ALLOWED_CIDRS?.trim() ?? '';
  // Empty/unset disables exceptions. Empty entries in a nonempty list are errors,
  // not silently discarded configuration mistakes.
  const cidrs = raw === '' ? [] : raw.split(',').map((cidr) => cidr.trim());
  const policy = createDefaultNetworkPolicy(cidrs);
  if (cidrs.some((cidr) => cidr.endsWith('/0'))) {
    warn(
      '[agentbrowser] AGENTBROWSER_ALLOWED_CIDRS includes /0: private-network blocking is broadly bypassed; loopback and metadata blocks remain enabled.'
    );
  }
  return policy;
}
