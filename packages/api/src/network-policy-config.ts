import { NetworkPolicy } from '@agentbrowser/policy';

const MAX_OPERATOR_RESPONSE_BYTES = 64 * 1024 * 1024;

/** Startup-only, finite byte budget; malformed configuration must not disable the gate. */
function responseBytesFromEnvironment(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const bytes = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > MAX_OPERATOR_RESPONSE_BYTES
  ) {
    throw new Error('AGENTBROWSER_MAX_RESPONSE_BYTES must be an integer from 1 to 67108864 bytes');
  }
  return bytes;
}

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
  env: {
    AGENTBROWSER_ALLOWED_CIDRS?: string | undefined;
    AGENTBROWSER_ALLOW_LOOPBACK?: string | undefined;
    AGENTBROWSER_MAX_RESPONSE_BYTES?: string | undefined;
  },
  warn: (message: string) => void = console.warn
): NetworkPolicy {
  const raw = env.AGENTBROWSER_ALLOWED_CIDRS?.trim() ?? '';
  // Empty/unset disables exceptions. Empty entries in a nonempty list are errors,
  // not silently discarded configuration mistakes.
  const cidrs = raw === '' ? [] : raw.split(',').map((cidr) => cidr.trim());
  // Operator opt-in for local-machine sessions (e.g. testing dev servers on
  // 127.0.0.1): disables the loopback block for EVERY session on this
  // server. Startup-only configuration; session/request input can never set
  // it. Metadata blocking is unaffected.
  const allowLoopback = /^(1|true|yes)$/i.test(env.AGENTBROWSER_ALLOW_LOOPBACK?.trim() ?? '');
  const maxResponseSize = responseBytesFromEnvironment(env.AGENTBROWSER_MAX_RESPONSE_BYTES);
  const policy = new NetworkPolicy({
    blockLoopback: !allowLoopback,
    blockPrivateIPs: true,
    blockMetadata: true,
    allowedPrivateCIDRs: cidrs,
    ...(maxResponseSize !== undefined ? { maxResponseSize } : {}),
  });
  if (allowLoopback) {
    warn(
      '[agentbrowser] AGENTBROWSER_ALLOW_LOOPBACK is set: the loopback block is DISABLED for all sessions on this server. Visited pages can now reach every loopback service — INCLUDING THIS SERVER ITSELF. In no-keys local mode that is full unauthenticated service control, including other sessions; in keyed mode the service is auth-gated but other loopback services (databases, dev daemons) are exposed. Run keyed, and only where the machine is already untrusted to the page.'
    );
  }
  if (cidrs.some((cidr) => cidr.endsWith('/0'))) {
    warn(
      '[agentbrowser] AGENTBROWSER_ALLOWED_CIDRS includes /0: private-network blocking is broadly bypassed; loopback and metadata blocks remain enabled unless AGENTBROWSER_ALLOW_LOOPBACK is also set.'
    );
  }
  return policy;
}
