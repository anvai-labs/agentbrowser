import { NetworkPolicy } from '@agentbrowser/policy';
import {
  type Authorizer,
  egressExceptionsOf,
  MemoizedAuthorizer,
  TenantBindingAuthorizer,
} from '@agentbrowser/policy-engine';
import type { PolicyLimits } from '@agentbrowser/protocol';
import { responseBytesFromEnvironment } from './network-policy-config.js';

/**
 * TD-BROWSER-15 phase 4: the per-session policy factory. Every session's
 * network policy is the floor blocks plus the tenant-bound, per-session-
 * memoized authorizer exceptions, cleared at close.
 *
 * Response-size parity (review R1): a FILE's `limits.maxResponseBytes` sets
 * the cap; a SHADOW keeps exactly what the environment set — the same
 * `AGENTBROWSER_MAX_RESPONSE_BYTES` the non-shadow policy carries — so
 * turning the shadow on never relaxes an operator cap.
 */

const POLICY_BEARING_ENV = [
  'AGENTBROWSER_ALLOW_LOOPBACK',
  'AGENTBROWSER_ALLOWED_CIDRS',
  'AGENTBROWSER_APPROVAL_POLICY',
  'AGENTBROWSER_MAX_RESPONSE_BYTES',
] as const;

export { POLICY_BEARING_ENV };

export interface SessionPolicyOptions {
  /** `'file'` (default) or `'shadow'`. */
  kind?: 'file' | 'shadow';
  authorizer: Authorizer;
  limits: PolicyLimits;
  /** True when no API keys are configured: nothing binds, local decides. */
  unkeyed?: boolean;
}

export function sessionPolicyFactoryFor(
  policy: SessionPolicyOptions,
  unkeyed: boolean,
  env: { AGENTBROWSER_MAX_RESPONSE_BYTES?: string | undefined } = process.env
): (tenantId: string | undefined) => { networkPolicy: NetworkPolicy; clear: () => void } {
  const isFile = (policy.kind ?? 'file') === 'file';
  return (tenantId: string | undefined) => {
    const memo = new MemoizedAuthorizer(
      new TenantBindingAuthorizer(policy.authorizer, unkeyed ? undefined : tenantId)
    );
    const maxResponseSize = isFile
      ? policy.limits.maxResponseBytes
      : responseBytesFromEnvironment(env.AGENTBROWSER_MAX_RESPONSE_BYTES);
    return {
      networkPolicy: new NetworkPolicy({
        blockLoopback: true,
        blockPrivateIPs: true,
        blockMetadata: true,
        ...(maxResponseSize !== undefined ? { maxResponseSize } : {}),
        exceptions: egressExceptionsOf(memo),
      }),
      clear: () => memo.clear(),
    };
  };
}
